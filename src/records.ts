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
  if (r.type === "label") return braidOf(r).commit ? `commit: ${String(r.label)}` : `named ${String(r.label)}`;
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
