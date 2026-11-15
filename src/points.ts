// Fork points. With autofork, braid marks a conversation as it stood before a
// turn that changed a lot: many files edited, or a long run of tool calls. A
// point is a tag in the store, at the session's commit before that turn, so
// `braid fork @N` can start a new window from there.
import { forEachRef, git } from "./git.ts";
import { describe, type Rec } from "./records.ts";
import { storeRef, type Repo } from "./repo.ts";
import type { SessionState } from "./state.ts";

/** A turn is big from this many files edited, or this many tool calls. */
export const BIG = { files: 5, calls: 30 };

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

/** Why the records of a turn make a big change, or undefined when they do not. */
export function bigTurn(records: Rec[]): string | undefined {
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
  if (files.size >= BIG.files) return `${files.size} files edited`;
  if (calls >= BIG.calls) return `${calls} tool calls`;
  return undefined;
}

export interface Point {
  n: number;
  /** The store commit of the session before the big turn. */
  commit: string;
  /** "before <prompt> (<why>)". */
  what: string;
}

const prefix = (session: string) => `refs/tags/points/${session}`;

export function points(repo: Repo, session: string): Point[] {
  return forEachRef([prefix(session)], { gitDir: repo.store })
    .map(({ ref }) => {
      const n = Number(ref.split("/").at(-1));
      const [commit = "", what = ""] = git(["for-each-ref", "--format=%(*objectname)%00%(contents:subject)", ref], { gitDir: repo.store }).trim().split("\0");
      return { n, commit, what };
    })
    .filter((p) => Number.isInteger(p.n) && p.commit)
    .sort((a, b) => a.n - b.n);
}

/** Marks the session as it stands in the store, before `turn` is saved, when `turn` is big. Returns the point's number. */
export function markIfBig(repo: Repo, state: SessionState, turn: Rec[]): number | undefined {
  if (state.chunks === 0) return undefined;
  const why = bigTurn(turn);
  if (!why) return undefined;
  const prompt = turn.find((r) => r.role === "user" && typeof r.content !== "undefined");
  const said = prompt ? describe(prompt, 60).split("\n")[0]!.replace(/\s+/g, " ") : "a turn";
  const n = (points(repo, state.session).at(-1)?.n ?? 0) + 1;
  git(["tag", "-a", `points/${state.session}/${n}`, storeRef(state.conv, state.session), "-m", `before "${said}" (${why})`], { gitDir: repo.store });
  return n;
}
