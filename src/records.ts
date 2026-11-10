// ATXF records as braid handles them: loosely typed JSON with the few fields braid reads.

export interface Actor {
  actorId: string;
  userAgent: string;
}

export interface MergeInfo {
  base: string | null;
  heads: string[];
  instruction: string;
  strategy: string;
  model: string;
  conflicts: string[];
}

export interface BraidExt {
  version?: number;
  actor?: Actor;
  session?: string;
  partOf?: string;
  /** On a subagent's record: the subagent's id. */
  agent?: string;
  merge?: MergeInfo;
  pr?: number;
  /** On a label: the conversation was committed here, with this code commit when there is one. */
  commit?: { sha?: string };
  /** On a label: a code commit made here, which did not commit the conversation (autocommit off). */
  code?: { sha: string };
  redactions?: { rule: string; count: number }[];
}

export interface Rec {
  type: string;
  id: string;
  parentId?: string | null;
  time?: string;
  role?: string;
  content?: unknown;
  ext?: { braid?: BraidExt; [key: string]: unknown };
  [key: string]: unknown;
}

export const braidOf = (r: Rec): BraidExt => r.ext?.braid ?? {};

/** Messages and merges: what the ↑ and ↓ counts count. */
export const isTurn = (r: Rec): boolean => r.type === "message" || r.type === "branch_summary";

/** A commit of the conversation: what is published ends at the last one. */
export const isCommit = (r: Rec): boolean => r.type === "label" && !!braidOf(r).commit;

/** How many records, from the start, are committed: up to and including the last commit. */
export function committedLength(records: Rec[]): number {
  for (let i = records.length - 1; i >= 0; i--) if (isCommit(records[i]!)) return i + 1;
  return 0;
}

export function parseJsonl(text: string): Rec[] {
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Rec);
}

export function toJsonl(records: Rec[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "");
}

/** Sets ext.braid fields on a record without disturbing other extensions. */
export function withBraid(r: Rec, fields: BraidExt): Rec {
  return { ...r, ext: { ...r.ext, braid: { ...braidOf(r), ...fields } } };
}

function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function blockText(block: unknown, max: number): string {
  if (typeof block === "string") return clip(block, max);
  if (!block || typeof block !== "object") return "";
  const b = block as Record<string, unknown>;
  if (b.type === "text" && typeof b.text === "string") return clip(b.text, max);
  if (b.type === "tool_call") {
    const args = b.arguments && typeof b.arguments === "object" ? (b.arguments as Record<string, unknown>) : {};
    const key = ["file_path", "path", "command", "cmd", "pattern", "url", "query"].find((k) => typeof args[k] === "string");
    return `→ ${String(b.name)}${key ? ` ${clip(String(args[key]), 120)}` : ""}`;
  }
  return "";
}

/** One readable line (or a few) for a record, for logs and briefings. */
export function describe(r: Rec, max = 400): string {
  if (r.type === "branch_summary") return clip(String(r.summary ?? ""), max * 4);
  if (r.type === "compaction") return clip(String(r.summary ?? ""), max);
  if (r.type === "label") return braidOf(r).commit ? `commit: ${String(r.label)}` : braidOf(r).code ? `code commit: ${String(r.label)}` : `named ${String(r.label)}`;
  if (r.type === "agent_link") {
    const agent = r.agent as { name?: string; role?: string } | undefined;
    return clip(`→ subagent ${String(r.transcriptId)}${agent ? ` (${agent.name ?? "subagent"}): ${agent.role ?? ""}` : ""}`, max);
  }
  if (r.type !== "message") return "";
  const c = r.content;
  const parts = Array.isArray(c) ? c.map((b) => blockText(b, max)) : [blockText(c, max)];
  return parts.filter(Boolean).join("\n");
}

/** The id of the newest turn in a list, in file order. */
export function lastTurn(records: Rec[]): string | undefined {
  for (let i = records.length - 1; i >= 0; i--) if (isTurn(records[i]!)) return records[i]!.id;
  return undefined;
}

/** Ids of every record from `head` back to its root, through a parent map. */
export function ancestry(head: string, parents: Map<string, string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let id: string | null | undefined = head;
  while (id && parents.has(id) && !seen.has(id)) {
    seen.add(id);
    out.push(id);
    id = parents.get(id);
  }
  return out;
}

/** A note the harness attached to the conversation: a reminder, hook output, a file the user named. */
const isAttachment = (r: Rec): boolean => r.type === "custom" && String(r.name ?? "").startsWith("attachment");

const callIds = (r: Rec): string[] =>
  r.type === "message" && r.role === "assistant" && Array.isArray(r.content)
    ? (r.content as { type?: string; id?: unknown }[]).flatMap((b) => (b?.type === "tool_call" && typeof b.id === "string" ? [b.id] : []))
    : [];

/**
 * The records an agent reads to continue from `head`, root first: its
 * ancestry, and what a batch of parallel tool calls left beside it. Claude
 * Code writes one response in several lines and links the result of each call
 * to that call, so the conversation goes on from one of them; when it resumes
 * a session it brings back the rest of the response and every result, and so
 * does this, after the response's last line on the ancestry.
 */
export function contextPath(head: string, all: Map<string, Rec>): Rec[] {
  const parents = new Map([...all.values()].map((r) => [r.id, r.parentId ?? null]));
  const path = ancestry(head, parents)
    .reverse()
    .map((id) => all.get(id))
    .filter((r): r is Rec => !!r && r.type !== "transcript");
  const onPath = new Set(path.map((r) => r.id));
  const isReply = (r: Rec | undefined) => r?.type === "message" && r.role === "assistant";
  const results = new Map<string, Rec>();
  const responses = new Map<string, Rec[]>();
  for (const r of all.values()) {
    if (r.role === "tool" && typeof r.toolCallId === "string" && !results.has(r.toolCallId)) results.set(r.toolCallId, r);
    if (isReply(r) && typeof r.responseId === "string" && !onPath.has(r.id)) responses.set(r.responseId, [...(responses.get(r.responseId) ?? []), r]);
  }
  const children = new Map<string, Rec[]>();
  for (const r of all.values()) if (r.parentId) children.set(r.parentId, [...(children.get(r.parentId) ?? []), r]);
  const out: Rec[] = [];
  const taken = new Set(onPath);
  let waiting: Rec[] = [];
  // A result comes back with the notes the harness attached below it.
  const bring = (r: Rec) => {
    taken.add(r.id);
    waiting.push(r);
    for (const c of children.get(r.id) ?? []) if (isAttachment(c) && !taken.has(c.id)) bring(c);
  };
  // What comes back hangs from what is already there: the rest of a response from its line before, a result from its call.
  const linked = (r: Rec) => !taken.has(r.id) && !!r.parentId && taken.has(r.parentId);
  const answer = (r: Rec) => {
    for (const id of callIds(r)) {
      const result = results.get(id);
      if (result && linked(result)) bring(result);
    }
  };
  // Results go back in the order they came in, which is the order Claude Code reads them in.
  const order = new Map([...all.keys()].map((id, i) => [id, i]));
  path.forEach((r, i) => {
    if (!isReply(r)) {
      out.push(...[...waiting, r].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)));
      waiting = [];
      return;
    }
    out.push(r);
    answer(r);
    const next = path[i + 1];
    if (typeof r.responseId !== "string" || (isReply(next) && next!.responseId === r.responseId)) return;
    for (const rest of responses.get(r.responseId) ?? []) {
      if (!linked(rest)) continue;
      taken.add(rest.id);
      out.push(rest);
      answer(rest);
    }
  });
  // Results still waiting answer calls of the head's own response: they come after it.
  return out;
}
