// braid review: a session as git push would publish it, one line per record,
// numbered, and the edits that keep parts of it back before a commit: withhold
// records by number, hide text everywhere in the session, or keep it private.
import { readAgents, readRecords } from "./chunks.ts";
import { applyEdit, clean, committedAgentRecord, editableText, spread, termRule, view, type View } from "./publish.ts";
import { redactValue, type Counts } from "./redact.ts";
import { braidOf, describe, type Rec } from "./records.ts";
import { remoteRefs, type Repo } from "./repo.ts";
import { loadState, saveState, withLock, type SessionState } from "./state.ts";
import { sessionTitle } from "./status.ts";

export interface Line {
  /** "12", or "12.3" for the third record of the subagent spawned at 12. */
  num: string;
  rec: Rec;
  /** The subagent a record belongs to. */
  agent?: string;
  who: string;
  /** The record as it would be published, and on one line. */
  shown: Rec;
  text: string;
  edited: boolean;
  redactions: number;
  withheld?: string;
  committed: boolean;
  published: boolean;
}

function who(r: Rec, agent: string | undefined): string {
  if (r.type === "branch_summary") return "merge";
  if (r.type === "compaction") return "summary";
  if (r.type === "agent_link") return "spawn";
  if (r.type === "label") return braidOf(r).commit ? "commit" : braidOf(r).code ? "code" : "name";
  if (r.role === "user") return agent ? "prompt" : "you";
  return r.role === "assistant" ? "agent" : String(r.role ?? r.type);
}

function oneLine(r: Rec): string {
  if (r.type === "label") {
    const sha = braidOf(r).commit?.sha ?? braidOf(r).code?.sha;
    return `${String(r.label)}${sha ? ` (${sha.slice(0, 7)})` : ""}`;
  }
  return describe(r, 2000).replace(/\s*\n\s*/g, " · ");
}

/** Every record that publishing could include, numbered, with what would be published of it. */
export function reviewLines(repo: Repo, v: View, remote: string): Line[] {
  const tracking = `${remoteRefs(remote)}/${v.state.conv}/${v.state.session}`;
  const published = new Set(
    [...readRecords(tracking, { cwd: repo.top }), ...[...readAgents(tracking, { cwd: repo.top }).values()].flat()].map((r) => r.id),
  );
  const agents = new Map([...v.agents].map(([id, c]) => [id, c.flat()]));
  const out: Line[] = [];
  const add = (num: string, r: Rec, committed: boolean, agent?: string) => {
    const c = clean(r);
    if (!c || r.type === "transcript") return false;
    const counts: Counts = new Map();
    const red = redactValue(applyEdit(c, v.edits.get(r.id)), counts, v.redact);
    out.push({
      num,
      rec: r,
      agent,
      who: who(r, agent),
      shown: red,
      text: oneLine(red),
      edited: v.edits.has(r.id),
      redactions: [...counts.values()].reduce((a, b) => a + b, 0),
      withheld: v.withheld.get(r.id),
      committed,
      published: published.has(r.id),
    });
    return true;
  };
  const listAgent = (key: string, id: string) => {
    let k = 0;
    for (const a of agents.get(id) ?? []) if (add(`${key}.${k + 1}`, a, committedAgentRecord(v, a), id)) k++;
  };
  const shown = new Set<string>();
  let n = 0;
  v.chunks.flat().forEach((r, i) => {
    if (!add(String(n + 1), r, i < v.committed)) return;
    n++;
    if (r.type === "agent_link" && !shown.has(String(r.transcriptId))) {
      shown.add(String(r.transcriptId));
      listAgent(String(n), String(r.transcriptId));
    }
  });
  // A subagent still running when the session was saved has no link yet: it goes last, under its id.
  for (const id of agents.keys()) if (!shown.has(id)) listAgent(id.slice(0, 6), id);
  return out;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s;
}

/** The listing: a header, then one line per record. */
export function renderReview(v: View, lines: Line[], width: number): string[] {
  const s = v.state;
  const main = lines.filter((l) => !l.agent);
  const lastCommitted = main.filter((l) => l.committed).at(-1)?.num;
  const withheld = lines.filter((l) => l.withheld).length;
  const edited = lines.filter((l) => l.edited && !l.withheld).length;
  const redactions = lines.filter((l) => !l.withheld).reduce((a, l) => a + l.redactions, 0);
  const head = [
    `braid review ${sessionTitle(v.chunks.flat(), s.session)}: ${main.length} records, ` +
      `${lastCommitted ? `committed up to ${lastCommitted}` : "nothing committed yet"}, ${withheld} withheld, ${edited ? `${edited} edited, ` : ""}${redactions} redacted`,
  ];
  if (s.private) head.push("This session is private: none of it is published. braid review --undo --all makes it publishable again.");
  else if (v.rules.withholdSession && v.pathCounts.size > 0) head.push("None of this session is published: it touched a path in .braidignore, and redact.toml sets withhold-session.");
  if (s.terms?.length) head.push(`Hidden text: ${s.terms.map((t) => JSON.stringify(t)).join(", ")}`);
  head.push("git push publishes up to the last commit. ↑ committed, not published yet · ✗ withheld · ✎ edited");
  const w = Math.max(...lines.map((l) => l.num.length), 2);
  const body = lines.map((l) => {
    const mark = l.withheld ? "✗" : l.edited ? "✎" : l.committed && !l.published ? "↑" : " ";
    const why = l.withheld ? `  [${l.withheld === "you" ? "withheld" : l.withheld}]` : "";
    const prefix = `${l.num.padStart(w)} ${mark} ${l.who.padEnd(7)}`;
    return `${prefix}${clip(l.text, Math.max(20, width - prefix.length - why.length))}${why}`;
  });
  return [...head, "", ...body];
}

/** Lines picked by numbers and ranges: 4, 7-9, 12.3, 12.3-5. */
export function pickLines(lines: Line[], tokens: string[]): Line[] {
  const byNum = new Map(lines.map((l) => [l.num, l]));
  const picked = new Map<string, Line>();
  const need = (num: string) => {
    const l = byNum.get(num);
    if (!l) throw new Error(`no record ${num} in this session (braid review lists them)`);
    picked.set(num, l);
  };
  for (const token of tokens.flatMap((t) => t.split(",")).filter(Boolean)) {
    const m = /^(?:([0-9a-z]+)\.)?(\d+)(?:-(?:\1\.)?(\d+))?$/.exec(token);
    if (!m) throw new Error(`not a record number or range: ${token}`);
    const [, group, from, to] = m;
    const prefix = group ? `${group}.` : "";
    for (let i = Number(from); i <= Number(to ?? from); i++) need(`${prefix}${i}`);
  }
  return [...picked.values()];
}

/** The records a withheld record was withheld with: the call behind a result, the link and call behind a subagent's records. */
function causes(v: View, id: string): string[] {
  const all = [...v.chunks.flat(), ...[...v.agents.values()].flat(2)];
  const r = all.find((x) => x.id === id);
  if (!r) return [];
  const callOf = (callId: unknown) =>
    typeof callId === "string"
      ? all.filter((x) => Array.isArray(x.content) && (x.content as { type?: string; id?: string }[]).some((b) => b?.type === "tool_call" && b.id === callId)).map((x) => x.id)
      : [];
  const out = r.role === "tool" ? callOf(r.toolCallId) : [];
  const agent = braidOf(r).agent;
  const link = v.chunks.flat().find((x) => x.type === "agent_link" && (x.id === id || x.transcriptId === agent));
  if (link) out.push(link.id, ...callOf(link.toolCallId));
  return out;
}

export interface Edit {
  /** Lines whose state changed. */
  changed: Line[];
  /** Of those, records already published: the next push replaces them. */
  published: number;
  note?: string;
}

function update(repo: Repo, session: string, fn: (state: SessionState) => void): void {
  withLock(repo, `save-${session}`, () => {
    const state = loadState(repo, session);
    if (!state) throw new Error("this session is not saved yet");
    fn(state);
    saveState(repo, state);
  });
}

/** Withholds the picked records, or with `undo` puts them back. Returns the lines whose state changed. */
export function withhold(repo: Repo, v: View, lines: Line[], picked: Line[], undo: boolean): Edit {
  const ids = new Set(picked.map((l) => l.rec.id));
  const kept = picked.filter((l) => l.withheld && l.withheld !== "you");
  update(repo, v.state.session, (state) => {
    const seeds = new Set(state.withheld ?? []);
    if (undo) for (const id of ids) for (const x of [id, ...causes(v, id)]) seeds.delete(x);
    else for (const id of ids) seeds.add(id);
    state.withheld = [...seeds];
    v.state.withheld = state.withheld;
  });
  const main = v.chunks.flat();
  const agents = new Map([...v.agents].map(([id, c]) => [id, c.flat()]));
  const seeds = new Map<string, string>((v.state.withheld ?? []).map((id) => [id, "you"]));
  for (const [id, why] of v.withheld) if (why !== "you") seeds.set(id, why);
  const after = spread(seeds, main, agents);
  const changed = lines.filter((l) => !!l.withheld !== after.has(l.rec.id));
  const note = undo && kept.length ? `${kept.map((l) => l.num).join(", ")} stay withheld by .braidignore; edit .braidignore to change that` : undefined;
  return { changed, published: changed.filter((l) => l.published).length, note };
}

/** Hides text everywhere in the session, or with `undo` shows it again. Returns the lines that contain it. */
export function hide(repo: Repo, v: View, lines: Line[], text: string, undo: boolean): Edit {
  if (!text.trim()) throw new Error("--text needs the text to hide");
  update(repo, v.state.session, (state) => {
    const others = (state.terms ?? []).filter((t) => t.toLowerCase() !== text.toLowerCase());
    state.terms = undo ? others : [...others, text];
  });
  const rule = termRule(text);
  const changed = lines.filter((l) => {
    const c = clean(l.rec);
    const counts: Counts = new Map();
    if (c) redactValue(c, counts, [rule]);
    return (counts.get("term") ?? 0) > 0;
  });
  return { changed, published: changed.filter((l) => l.published && !l.withheld).length };
}

/** The text of a line that --edit starts from: as it would be published. */
export const lineText = (l: Line): string | undefined => editableText(l.shown);

/** Publishes `text` in place of a record's own text, or with undefined goes back to its own. */
export function editRecord(repo: Repo, v: View, line: Line, text: string | undefined): Edit {
  update(repo, v.state.session, (state) => {
    const edits = { ...state.edits };
    if (text === undefined) delete edits[line.rec.id];
    else edits[line.rec.id] = text;
    state.edits = Object.keys(edits).length ? edits : undefined;
  });
  return { changed: [line], published: line.published ? 1 : 0 };
}

/** Withholds every record written in the last `ms` milliseconds. */
export function withholdRecent(repo: Repo, v: View, lines: Line[], ms: number): Edit {
  const cutoff = Date.now() - ms;
  const recent = lines.filter((l) => l.rec.time && Date.parse(l.rec.time) >= cutoff);
  return withhold(repo, v, lines, recent, false);
}

/** Keeps the whole session from being published, or with `undo` lets it be published again. */
export function setPrivate(repo: Repo, session: string, value: boolean): void {
  update(repo, session, (state) => {
    state.private = value || undefined;
  });
}

export { view };
