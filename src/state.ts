// Per-session state, kept next to the store: <common>/braid/sessions/<id>.json.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Repo } from "./repo.ts";
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
  harness: "claude-code";
  transcript?: string;
  /** Where the previous save stopped reading the transcript. */
  cursor?: Cursor;
  /** Id of the last native record saved, so the next save starts after it. */
  last?: string;
  /** Id of the newest record of this session in the store. */
  head?: string;
  chunks: number;
  /** "anthropic:claude-sonnet-5-5": the model of the newest assistant record. */
  model?: string;
  userAgent?: string;
  /** Subagent transcripts saved with this session, by agent id. */
  agents?: Record<string, { cursor: Cursor; last?: string; linked?: boolean }>;
  /** Id of the first message, which a fork's transcript shares with the session it was forked from. */
  first?: string;
  /** A session this one forks from, set by `braid fork` before the first save. */
  forkFrom?: { session: string; conv: string; head: string; actor?: string };
  pendingMerge?: PendingMerge;
  /** Native records whose parent is `from` continue from the merge record `to`. */
  reparent?: { from: string; to: string };
  /** Code commits made since the last save; the next save commits the conversation with each. */
  commits?: string[];
  withheld?: string[];
  /** Forked from someone else's session: published when it ends, since a review has no commits to push. */
  review?: boolean;
  private?: boolean;
  /** What the last after-turn notice reported, so it is not repeated. */
  notified?: string;
}

function path(repo: Repo, session: string): string {
  return join(repo.dir, "sessions", `${session}.json`);
}

export function loadState(repo: Repo, session: string): SessionState | undefined {
  const p = path(repo, session);
  if (!existsSync(p)) return undefined;
  return JSON.parse(readFileSync(p, "utf8")) as SessionState;
}

export function saveState(repo: Repo, state: SessionState): void {
  const p = path(repo, state.session);
  mkdirSync(join(repo.dir, "sessions"), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, p);
}

export function newState(session: string, transcript?: string): SessionState {
  return { session, conv: session, harness: "claude-code", transcript, chunks: 0 };
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
