// Publishing: build a redacted copy of a session's committed records and push it.
import { existsSync } from "node:fs";
import { readAgentChunks, readAgents, readChunks, readRecords, writeChunks } from "./chunks.ts";
import { git, gitMaybe, revParse, updateRef } from "./git.ts";
import { redactValue, type Counts, type Rule } from "./redact.ts";
import { loadRules, pathWithheld, type Rules } from "./rules.ts";
import { braidOf, committedLength, isTurn, type Rec } from "./records.ts";
import { PUBLISHED_REFS, readConfig, remoteRefs, storeRef, type Repo } from "./repo.ts";
import { AUTOPILOT } from "./fetch.ts";
import { shellWord } from "./replay.ts";
import { loadState, saveState, withLock, type SessionState } from "./state.ts";

const PUBLISHED_TYPES = new Set(["transcript", "message", "branch_summary", "label", "compaction", "agent_link"]);
const PUBLISHED_BLOCKS = new Set(["text", "tool_call"]);

/** Removes what never leaves the machine: native lines, replay data, reasoning, images, system messages. */
export function clean(r: Rec): Rec | undefined {
  if (!PUBLISHED_TYPES.has(r.type)) return undefined;
  if (r.type === "message" && r.role !== "user" && r.role !== "assistant" && r.role !== "tool") return undefined;
  const { native: _native, replay: _replay, usage: _usage, cost: _cost, ...rest } = r;
  const out: Rec = { ...rest };
  if (r.type === "transcript") {
    out.fidelity = { topology: "tree", native: "none" };
    return out;
  }
  if (Array.isArray(r.content)) {
    const blocks = (r.content as Record<string, unknown>[])
      .filter((b) => PUBLISHED_BLOCKS.has(String(b?.type)))
      .map(({ replay: _r, ...b }) => b);
    if (blocks.length === 0) return undefined;
    out.content = blocks;
  }
  return out;
}

/** The text of a record that braid edit --rewrite rewrites: its text blocks, or a summary. Undefined for a tool call. */
export function editableText(r: Rec): string | undefined {
  if (r.type === "branch_summary" || r.type === "compaction") return typeof r.summary === "string" ? r.summary : undefined;
  if (r.type !== "message") return undefined;
  if (typeof r.content === "string") return r.content;
  if (!Array.isArray(r.content)) return undefined;
  const texts = (r.content as { type?: string; text?: unknown }[]).filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => String(b.text));
  return texts.length ? texts.join("\n\n") : undefined;
}

/** A record with its text replaced: the first text block takes the new text, other text blocks go, tool calls stay. */
export function applyEdit(r: Rec, text: string | undefined): Rec {
  if (text === undefined) return r;
  if (r.type === "branch_summary" || r.type === "compaction") return { ...r, summary: text };
  if (typeof r.content === "string") return { ...r, content: text };
  if (!Array.isArray(r.content)) return r;
  let placed = false;
  const content = (r.content as { type?: string }[]).flatMap((b) => {
    if (b?.type !== "text") return [b];
    if (placed) return [];
    placed = true;
    return [{ ...b, text }];
  });
  return { ...r, content };
}

/** A literal, matched in any case. */
export const termRule = (term: string): Rule => ({ rule: "term", re: new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi") });

/**
 * Each withheld record takes along the results of its tool calls, and the
 * subagents that its calls (or its agent link) spawned.
 */
export function spread(seeds: Map<string, string>, main: Rec[], agents: Map<string, Rec[]>): Map<string, string> {
  const out = new Map(seeds);
  const all = [...main, ...[...agents.values()].flat()];
  const calls = new Map<string, string>();
  for (const r of all) {
    const why = out.get(r.id);
    if (!why || !Array.isArray(r.content)) continue;
    for (const b of r.content as { type?: string; id?: string }[]) if (b?.type === "tool_call" && b.id) calls.set(b.id, why);
  }
  for (const r of all) {
    const why = r.role === "tool" && typeof r.toolCallId === "string" ? calls.get(r.toolCallId) : undefined;
    if (why && !out.has(r.id)) out.set(r.id, why);
  }
  for (const link of main.filter((r) => r.type === "agent_link")) {
    const why = out.get(link.id) ?? (typeof link.toolCallId === "string" ? calls.get(link.toolCallId) : undefined);
    if (!why) continue;
    if (!out.has(link.id)) out.set(link.id, why);
    for (const r of agents.get(String(link.transcriptId)) ?? []) if (!out.has(r.id)) out.set(r.id, why);
  }
  return out;
}

/** A session as publishing sees it: every record in the store, what is withheld and why, and where the commits end. */
export interface View {
  state: SessionState;
  chunks: Rec[][];
  agents: Map<string, Rec[][]>;
  /** Withheld records: "you" (braid edit) or ".braidignore <pattern>". */
  withheld: Map<string, string>;
  /** Redaction rules on top of the built-in ones: the team's, the user's, and this session's hidden text. */
  redact: Rule[];
  /** Text published in place of a record's own, by record id. */
  edits: Map<string, string>;
  rules: Rules;
  pathCounts: Map<string, number>;
  /** How many records, from the start, are committed; subagent records count up to the last commit's time. */
  committed: number;
  committedAt?: string;
}

export function view(repo: Repo, state: SessionState, remote: string): View {
  const ref = storeRef(state.conv, state.session);
  const chunks = readChunks(ref, { gitDir: repo.store });
  const agents = readAgentChunks(ref, { gitDir: repo.store });
  const main = chunks.flat();
  const flatAgents = new Map([...agents].map(([id, c]) => [id, c.flat()]));
  const code = state.code && existsSync(state.code) ? state.code : undefined;
  const rules = loadRules(repo, remote, code);
  const byPath = pathWithheld([...main, ...[...flatAgents.values()].flat()], rules, code ?? repo.top);
  const seeds = new Map<string, string>((state.withheld ?? []).map((id) => [id, "you"]));
  for (const [id, pattern] of byPath.ids) seeds.set(id, `.braidignore ${pattern}`);
  const committed = committedLength(main);
  return {
    state,
    chunks,
    agents,
    withheld: spread(seeds, main, flatAgents),
    redact: [...rules.redact, ...(state.terms ?? []).map(termRule)],
    edits: new Map(Object.entries(state.edits ?? {})),
    rules,
    pathCounts: byPath.counts,
    committed,
    committedAt: committed ? main[committed - 1]!.time : undefined,
  };
}

/** Whether a subagent record falls within the commits: written before the last one. */
export const committedAgentRecord = (v: View, r: Rec): boolean => !!v.committedAt && (!r.time || r.time <= v.committedAt);

/** The committed part of a view: the records up to the last commit, and subagent records up to its time. */
function committedPart(v: View): { chunks: Rec[][]; agents: Map<string, Rec[][]> } {
  let left = v.committed;
  const chunks = v.chunks
    .map((c) => {
      const part = c.slice(0, Math.max(0, left));
      left -= c.length;
      return part;
    })
    .filter((c) => c.length > 0);
  const agents = new Map<string, Rec[][]>();
  for (const [id, c] of v.agents) {
    const part = c.map((chunk) => chunk.filter((r) => committedAgentRecord(v, r))).filter((chunk) => chunk.length > 0);
    if (part.length) agents.set(id, part);
  }
  return { chunks, agents };
}

export interface PublishResult {
  session: string;
  pushed: boolean;
  records: number;
  redactions: number;
  reason?: string;
  /** Turns after the last commit, which are not published. */
  uncommitted?: number;
  /** Records published before that this push removed or changed, after braid edit. */
  replaced?: number;
  /** Records the remote copy has with different content: this machine's version was published. */
  conflicts?: string[];
  /** What --dry-run reports: redactions per rule, withheld records per cause, and where the rules came from. */
  report?: { counts: Counts; withheld: Map<string, number>; sources: string[]; problems: string[] };
}

/** Builds the published chunks for a session: cleaned, withheld records dropped, edits applied, parents relinked, redacted. */
export function publishedChunks(chunks: Rec[][], withheld: Set<string>, extra: Rule[] = [], edits = new Map<string, string>()): { chunks: Rec[][]; counts: Counts } {
  const all = chunks.flat();
  const parents = new Map(all.map((r) => [r.id, r.parentId ?? null]));
  const cleaned = new Map<string, Rec>();
  for (const r of all) {
    if (withheld.has(r.id)) continue;
    const c = clean(r);
    if (c) cleaned.set(r.id, applyEdit(c, edits.get(r.id)));
  }
  // A dropped record's children attach to its nearest kept ancestor.
  const relink = (id: string | null | undefined): string | null => {
    let cur = id ?? null;
    const seen = new Set<string>();
    while (cur && parents.has(cur) && !cleaned.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = parents.get(cur) ?? null;
    }
    return cur;
  };
  const counts: Counts = new Map();
  const out = chunks.map((chunk) =>
    chunk
      .filter((r) => cleaned.has(r.id))
      .map((r) => {
        const c = { ...cleaned.get(r.id)! };
        if (c.type !== "transcript") c.parentId = relink(c.parentId);
        if (typeof c.fromId === "string") c.fromId = relink(c.fromId) ?? c.fromId;
        if (typeof c.targetId === "string") c.targetId = relink(c.targetId) ?? c.targetId;
        const found: Counts = new Map();
        const red = redactValue(c, found, extra);
        if (found.size > 0) {
          const redactions = [...found].map(([rule, count]) => ({ rule, count }));
          red.ext = { ...red.ext, braid: { ...braidOf(red), redactions } };
          for (const [rule, count] of found) counts.set(rule, (counts.get(rule) ?? 0) + count);
        }
        return red;
      }),
  );
  return { chunks: out.filter((c) => c.length > 0), counts };
}

const sum = (m: Counts) => [...m.values()].reduce((a, b) => a + b, 0);

export function publish(repo: Repo, session: string, opts: { remote?: string; dryRun?: boolean } = {}): PublishResult {
  const remote = opts.remote ?? readConfig(repo).remote;
  const result: PublishResult = { session, pushed: false, records: 0, redactions: 0 };
  const state = loadState(repo, session);
  if (!state || state.chunks === 0) return { ...result, reason: "not saved" };
  if (state.private) return { ...result, reason: "private" };

  return withLock(repo, `publish-${session}`, () => {
    const v = view(repo, state, remote);
    const report = { counts: new Map() as Counts, withheld: new Map(v.pathCounts), sources: v.rules.sources, problems: v.rules.problems };
    const byYou = [...v.withheld.values()].filter((w) => w === "you").length;
    if (byYou) report.withheld.set("braid edit", byYou);
    const uncommitted = v.chunks.flat().slice(v.committed).filter((r) => isTurn(r) && !v.withheld.has(r.id)).length;
    if (v.rules.withholdSession && v.pathCounts.size > 0) return { ...result, uncommitted, reason: "withheld whole: it touched a path in .braidignore", report };
    if (v.committed === 0) return { ...result, uncommitted, reason: "nothing committed yet (braid edit, then braid commit)", report };

    const part = committedPart(v);
    const withheld = new Set(v.withheld.keys());
    const { chunks, counts } = publishedChunks(part.chunks, withheld, v.redact, v.edits);
    const agents = new Map<string, Rec[][]>();
    for (const [id, chunksOfAgent] of part.agents) {
      const published = publishedChunks(chunksOfAgent, withheld, v.redact, v.edits);
      if (published.chunks.length) agents.set(id, published.chunks);
      for (const [rule, n] of published.counts) counts.set(rule, (counts.get(rule) ?? 0) + n);
    }
    report.counts = counts;
    const records = chunks.flat().filter(isTurn).length;
    const redactions = sum(counts);
    if (opts.dryRun) return { ...result, records, redactions, uncommitted, reason: "dry run", report };
    if (readConfig(repo).autopilot) return { ...result, records, redactions, uncommitted, reason: AUTOPILOT, report };
    if (!/[:/]/.test(remote) && !gitMaybe(["remote", "get-url", remote], { cwd: repo.top })) {
      return { ...result, records, redactions, uncommitted, reason: `${repo.top} has no remote ${remote}: git -C ${shellWord(repo.top)} remote add ${remote} <url>`, report };
    }
    const published = `${PUBLISHED_REFS}/${state.conv}/${session}`;
    const target = `${repo.common} ${remote}`;
    const tracking = `${remoteRefs(remote)}/${state.conv}/${session}`;
    const localIds = new Set([...v.chunks.flat(), ...[...v.agents.values()].flat(2)].map((r) => r.id));
    const mine = new Map(chunks.flat().map((r) => [r.id, r]));
    const ours = new Map([...chunks.flat(), ...[...agents.values()].flat(2)].map((r) => [r.id, stable(r)]));

    // The same session can be saved on two machines. Records the remote copy has
    // and this machine lacks are kept; a record both have with different content
    // is reported, and this machine's version is published. Records this machine
    // withheld or redacted after publishing them are replaced, and then the copy
    // is published without its history, so the old content is not reachable from it.
    const attempt = () => {
      const parent = revParse(tracking, { cwd: repo.top });
      const theirs = parent ? readRecords(tracking, { cwd: repo.top }) : [];
      const theirAgents = parent ? [...readAgents(tracking, { cwd: repo.top }).values()].flat() : [];
      const extra = theirs.filter((r) => !localIds.has(r.id));
      const changed = [...theirs, ...theirAgents].filter((r) => localIds.has(r.id) && ours.get(r.id) !== stable(r)).length;
      // A copy this machine pushed last differs only by its own edits; any other copy differs by another machine's.
      const ownCopy = !!parent && parent === state.published?.[target];
      const conflicts = ownCopy ? [] : theirs.filter((r) => mine.has(r.id) && stable(mine.get(r.id)) !== stable(r)).map((r) => r.id);
      const commit = writeChunks(extra.length ? [...chunks, extra] : chunks, parent, `publish ${session}`, { cwd: repo.top }, agents, changed > 0);
      return { commit, parent, replaced: changed - conflicts.length, conflicts };
    };
    let a = attempt();
    for (let tries = 0; ; tries++) {
      if (!a.commit) return { ...result, records, redactions, uncommitted, conflicts: a.conflicts, reason: "up to date" };
      try {
        git(["push", "--no-verify", "--quiet", `--force-with-lease=${published}:${a.parent ?? ""}`, remote, `${a.commit}:${published}`], { cwd: repo.top });
        break;
      } catch (err) {
        if (tries > 0) throw err;
        // Published from somewhere else since the last fetch: take that copy in and try again.
        gitMaybe(["fetch", "--quiet", "--no-write-fetch-head", remote, `+${published}:${tracking}`], { cwd: repo.top });
        a = attempt();
      }
    }
    updateRef(tracking, a.commit, a.parent, { cwd: repo.top });
    withLock(repo, `save-${session}`, () => {
      const s = loadState(repo, session);
      if (s) saveState(repo, { ...s, published: { ...s.published, [target]: a.commit! } });
    });
    return { session, pushed: true, records, redactions, uncommitted, replaced: a.replaced, conflicts: a.conflicts };
  });
}

/** JSON with sorted keys, so two copies of a record compare by content. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));
}
