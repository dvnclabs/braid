// Turns. A turn is a prompt you typed and everything the agent did until it
// stopped. Each has a name, <session>.<n>, numbered in the order of the
// session's file. A fork's file holds the history it was written from, so a
// fork continues the numbering of the session it forks.
import { readRecords } from "./store.ts";
import type { Found } from "./load.ts";
import { isPrompt, lastTurn, nativeLine, type Rec } from "./records.ts";
import type { Repo } from "./repo.ts";

export const startsTurn = (r: Rec): boolean => isPrompt(r);

/** "5b0e2c1a.12" */
export const turnName = (session: string, n: number): string => `${session.slice(0, 8)}.${n}`;

/** A turn name: a session, by id or the name you gave it, then a dot and the turn's number. `.12` is this session's. */
export const TURN = /^(.*)\.(\d+)$/;

export interface TurnRecords {
  n: number;
  /** The prompt that starts it; none for what comes before a session's first prompt. */
  start?: Rec;
  records: Rec[];
}

/** Where a compaction starts: Claude Code's boundary line, or the compaction itself, as Codex writes it. */
const compacts = (r: Rec): boolean => r.type === "compaction" || nativeLine(r)?.subtype === "compact_boundary";

/**
 * A session's turns, in order, each with its records. A compaction after a
 * turn's last answer starts the next turn: Claude Code compacts as the next
 * prompt goes out, so a fork from the end of a turn holds the turn as it
 * ended, before the compaction. One in the middle of a turn is the turn's.
 */
export function turnsOf(records: Rec[]): TurnRecords[] {
  const out: TurnRecords[] = [{ n: 0, records: [] }];
  for (const r of records) {
    if (startsTurn(r)) {
      const before = out.at(-1)!.records;
      const answered = before.findLastIndex((x) => x.type === "message" && x.role === "assistant");
      const from = before.findIndex((x, i) => i > answered && compacts(x));
      out.push({ n: out.length, start: r, records: from >= 0 ? before.splice(from) : [] });
    }
    out.at(-1)!.records.push(r);
  }
  return out;
}

export interface Turn {
  found: Found;
  n: number;
  /** The turn's last record, which a fork continues from. */
  until: string;
}

/** Turn `n` of a session. */
export function findTurn(repo: Repo, found: Found, n: number): Turn | undefined {
  const t = turnsOf(readRecords(repo, found.session)).find((t) => t.n === n && t.start);
  return t && lastTurn(t.records) ? { found, n, until: t.records.at(-1)!.id } : undefined;
}

const EDITS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch", "edit", "write"]);

/** The files a patch in Codex's format adds, updates, deletes or moves to. */
export function patchedFiles(patch: string): string[] {
  if (!patch.includes("*** Begin Patch")) return [];
  return [...patch.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+?)\s*$/gm)].map((m) => m[1]!);
}

type Call = { type?: string; name?: string; input?: unknown; arguments?: Record<string, unknown> };

/** The text a call may carry a patch in: apply_patch's input, or a shell command that runs apply_patch. */
function patchText(b: Call): string {
  const a = b.arguments ?? {};
  for (const v of [b.input, a.input, a.cmd, a.command, a.patch]) {
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return v.filter((x) => typeof x === "string").join("\n");
  }
  return "";
}

/** What the records of a turn did: the files edited, and the tool calls made. */
export function turnStats(records: Rec[]): { files: number; calls: number } {
  const files = new Set<string>();
  let calls = 0;
  for (const r of records) {
    if (!Array.isArray(r.content)) continue;
    for (const b of r.content as Call[]) {
      if (b?.type !== "tool_call") continue;
      calls++;
      const path = b.arguments?.file_path ?? b.arguments?.path ?? b.arguments?.notebook_path;
      if (EDITS.has(String(b.name)) && typeof path === "string") files.add(path);
      // Codex edits files with patches, which name each file in a header.
      for (const f of patchedFiles(patchText(b))) files.add(f);
    }
  }
  return { files: files.size, calls };
}

/** "5 files edited, 6 tool calls", or "" for a turn that called no tools. */
export function turnDetail(records: Rec[]): string {
  const { files, calls } = turnStats(records);
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  return [files ? `${plural(files, "file")} edited` : "", calls ? plural(calls, "tool call") : ""].filter(Boolean).join(", ");
}
