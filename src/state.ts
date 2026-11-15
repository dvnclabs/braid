// Per-session state, next to its records: .braid/sessions/<id>.json.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureStore, type Repo } from "./repo.ts";
import type { About } from "./records.ts";
import type { Cursor } from "./transcript.ts";

export interface PendingMerge {
  id: string;
  /** The session brought in, and its head when the merge was written. */
  from: string;
  fromHead: string;
  base: string | null;
  instruction: string;
  strategy: string;
  summary: string;
}

export interface SessionState {
  session: string;
  conv: string;
  /** The agent the session runs in, whose transcript braid reads. */
  harness: "claude-code" | "codex";
  transcript?: string;
  /** Where the previous save stopped reading the transcript. */
  cursor?: Cursor;
  /** Id of the last native record saved, so the next save starts after it. */
  last?: string;
  /** Id of the newest record of this session saved. */
  head?: string;
  /** How many saves wrote records. */
  chunks: number;
  /** "anthropic:claude-sonnet-5-5": the model of the newest assistant record. */
  model?: string;
  userAgent?: string;
  /** Subagent transcripts saved with this session, by agent id. */
  agents?: Record<string, { cursor: Cursor; last?: string; linked?: boolean }>;
  /** Id of the first message, which a fork's transcript shares with the session it was forked from. */
  first?: string;
  /** A session this one forks from, set by `braid fork` before the first save. */
  /** `lines`: how many lines a replayed fork wrote, all copies of the source. */
  forkFrom?: { session: string; conv: string; head: string; actor?: string; replayed?: boolean; lines?: number };
  /** A rollout braid wrote for Codex: its first lines, this many, are copies of the session it continues, saved there. */
  copied?: number;
  /** The last braid verify, run when the session ended. */
  verified?: { ok: boolean; at: string; problems?: string[] };
  pendingMerge?: PendingMerge;
  /** Native records whose parent is `from` continue from the merge record `to`. */
  reparent?: { from: string; to: string };
  /** What the last after-turn notice reported, so it is not repeated. */
  notified?: string;
  /** What the session is about, from its records: the status line and braid status show it. */
  title?: About["title"];
  /** The agent's latest recap of the session, shown when the session is resumed. */
  recap?: About["recap"];
  /** The number of the session's newest turn, counted along its line from the conversation's first prompt. */
  turn?: number;
  /** The checkout the session ran in: one of the project's worktrees, or the project itself. */
  ran?: string;
}

function path(repo: Repo, session: string): string {
  return join(repo.sessions, `${session}.json`);
}

export function loadState(repo: Repo, session: string): SessionState | undefined {
  const p = path(repo, session);
  if (!existsSync(p)) return undefined;
  return JSON.parse(readFileSync(p, "utf8")) as SessionState;
}

export function saveState(repo: Repo, state: SessionState): void {
  const p = path(repo, state.session);
  ensureStore(repo);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, p);
}

export function newState(session: string, transcript?: string, harness: SessionState["harness"] = "claude-code"): SessionState {
  return { session, conv: session, harness, transcript, chunks: 0 };
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** Runs fn while holding a lock directory; a lock older than 30 s is taken over. */
export function withLock<T>(repo: Repo, name: string, fn: () => T): T {
  const lock = join(repo.dir, "locks", name);
  mkdirSync(join(repo.dir, "locks"), { recursive: true });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      let stale = false;
      try {
        stale = Date.now() - statSync(lock).mtimeMs > 30_000;
      } catch {
        continue;
      }
      if (stale) rmSync(lock, { recursive: true, force: true });
      else if (Date.now() > deadline) throw new Error(`braid: ${name} is locked`);
      else Atomics.wait(sleeper, 0, 0, 50);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
