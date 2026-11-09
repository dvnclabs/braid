// Publishing: build a redacted copy of a session from the store and push it.
import { readAgentChunks, readChunks, writeChunks } from "./chunks.ts";
import { git, revParse, updateRef } from "./git.ts";
import { redactValue, type Counts, type Rule } from "./redact.ts";
import { loadRules, pathWithheld } from "./rules.ts";
import { braidOf, isTurn, type Rec } from "./records.ts";
import { PUBLISHED_REFS, readConfig, remoteRefs, storeRef, type Repo } from "./repo.ts";
import { loadState, withLock } from "./state.ts";

const PUBLISHED_TYPES = new Set(["transcript", "message", "branch_summary", "label", "compaction", "agent_link"]);
const PUBLISHED_BLOCKS = new Set(["text", "tool_call"]);

/** Removes what never leaves the machine: native lines, replay data, reasoning, images, system messages. */
function clean(r: Rec): Rec | undefined {
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

export interface PublishResult {
  session: string;
  pushed: boolean;
  records: number;
  redactions: number;
  reason?: string;
  /** What --dry-run reports: redactions per rule, withheld records per cause, and where the rules came from. */
  report?: { counts: Counts; withheld: Map<string, number>; sources: string[]; problems: string[] };
}

/** Builds the published chunks for a session: cleaned, withheld records dropped, parents relinked, redacted. */
export function publishedChunks(chunks: Rec[][], withheld: Set<string>, extra: Rule[] = []): { chunks: Rec[][]; counts: Counts } {
  const all = chunks.flat();
  const parents = new Map(all.map((r) => [r.id, r.parentId ?? null]));
  const cleaned = new Map<string, Rec>();
  for (const r of all) {
    if (withheld.has(r.id)) continue;
    const c = clean(r);
    if (c) cleaned.set(r.id, c);
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

export function publish(repo: Repo, session: string, opts: { remote?: string; force?: boolean; dryRun?: boolean } = {}): PublishResult {
  const config = readConfig(repo);
  const remote = opts.remote ?? config.remote;
  const result: PublishResult = { session, pushed: false, records: 0, redactions: 0 };
  const off = config.publish === "off" && !opts.force ? `publishing is off in ${config.publishSource ?? ".braid/config.toml"}` : undefined;
  if (off && !opts.dryRun) return { ...result, reason: off };
  const state = loadState(repo, session);
  if (!state || state.chunks === 0) return { ...result, reason: "not saved" };
  if (state.private) return { ...result, reason: "private" };

  return withLock(repo, `publish-${session}`, () => {
    const ref = storeRef(state.conv, session);
    const local = readChunks(ref, { gitDir: repo.store });
    const localAgents = readAgentChunks(ref, { gitDir: repo.store });
    const rules = loadRules(repo, remote);
    const byPath = pathWithheld([...local.flat(), ...[...localAgents.values()].flat(2)], rules, repo.top);
    const report = { counts: new Map() as Counts, withheld: new Map(byPath.counts), sources: rules.sources, problems: rules.problems };
    if ((state.withheld ?? []).length) report.withheld.set("braid withhold", state.withheld!.length);
    if (rules.withholdSession && byPath.ids.size > 0) return { ...result, reason: "withheld whole: it touched a path under the withhold rules", report };
    const withheld = new Set([...(state.withheld ?? []), ...byPath.ids]);

    const { chunks, counts } = publishedChunks(local, withheld, rules.redact);
    const agents = new Map<string, Rec[][]>();
    for (const [id, chunksOfAgent] of localAgents) {
      const published = publishedChunks(chunksOfAgent, withheld, rules.redact);
      agents.set(id, published.chunks);
      for (const [rule, n] of published.counts) counts.set(rule, (counts.get(rule) ?? 0) + n);
    }
    report.counts = counts;
    const records = chunks.flat().filter(isTurn).length;
    const redactions = sum(counts);
    if (opts.dryRun) return { ...result, records, redactions, reason: off ?? "dry run", report };
    const published = `${PUBLISHED_REFS}/${state.conv}/${session}`;
    const tracking = `${remoteRefs(remote)}/${state.conv}/${session}`;
    const parent = revParse(tracking, { cwd: repo.top });
    const commit = writeChunks(chunks, parent, `publish ${session}`, { cwd: repo.top }, agents);
    if (!commit) return { ...result, records, redactions, reason: "up to date" };
    git(["push", "--no-verify", "--quiet", `--force-with-lease=${published}:${parent ?? ""}`, remote, `${commit}:${published}`], {
      cwd: repo.top,
    });
    updateRef(tracking, commit, parent, { cwd: repo.top });
    return { session, pushed: true, records, redactions };
  });
}
