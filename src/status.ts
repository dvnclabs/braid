// What the status line shows after a session's name: sessions built on this
// one that wait to be merged (↓), and a session that failed braid verify (⚠).
import { allSessions, sessionName } from "./load.ts";
import { braidOf, isTurn, lastTurn, type Rec } from "./records.ts";
import type { Repo } from "./repo.ts";
import { loadState } from "./state.ts";
import { readRecords } from "./store.ts";

export interface Waiting {
  session: string;
  name: string;
  count: number;
  /** Their newest turn, and the record of this session they forked from. */
  head: string;
  base: string | null;
}

export interface Status {
  session: string;
  saved: boolean;
  /** The last braid verify, when the session ended, found problems. */
  broken?: boolean;
  conv?: string;
  waiting: Waiting[];
}

/** Records of `others` that no merge in `mine` covers. A merge covers its heads and everything before them. */
export function uncovered(mine: Rec[], others: Rec[], extraHeads: string[] = []): Rec[] {
  const parents = new Map(others.map((r) => [r.id, r.parentId ?? null]));
  const heads = [...mine.flatMap((r) => braidOf(r).merge?.heads ?? []), ...extraHeads];
  const covered = new Set<string>();
  for (const head of heads) {
    let id: string | null | undefined = head;
    while (id && parents.has(id) && !covered.has(id)) {
      covered.add(id);
      id = parents.get(id);
    }
  }
  return others.filter((r) => isTurn(r) && !covered.has(r.id));
}

export function computeStatus(repo: Repo, session: string): Status {
  const status: Status = { session, saved: false, waiting: [] };
  const state = loadState(repo, session);
  if (!state || state.chunks === 0) return status;
  const mine = readRecords(repo, session);
  Object.assign(status, { saved: mine.length > 0, conv: state.conv, broken: state.verified?.ok === false });
  const myIds = new Set(mine.map((r) => r.id));
  const pending = state.pendingMerge ? [state.pendingMerge.fromHead] : [];
  // Branches of this conversation that forked from this session and have turns it has not merged.
  for (const other of allSessions(repo)) {
    if (other.conv !== state.conv || other.session === session) continue;
    const theirs = readRecords(repo, other.session);
    const fork = theirs.find((r) => r.parentId && myIds.has(r.parentId));
    if (!fork) continue;
    const open = uncovered(mine, theirs, pending);
    if (open.length === 0) continue;
    const head = lastTurn(theirs) ?? open.at(-1)!.id;
    status.waiting.push({ session: other.session, name: sessionName(repo, other.session), count: open.length, head, base: fork.parentId ?? null });
  }
  return status;
}

/** How the status line colors each kind of mark. */
export type Tone = "quiet" | "waiting" | "broken";
export type Paint = (tone: Tone, text: string) => string;
const plain: Paint = (_tone, text) => text;

const SGR: Record<Tone | "sep", [string, string]> = {
  quiet: ["2", "22"],
  waiting: ["35", "39"],
  broken: ["31", "39"],
  sep: ["2", "22"],
};

/** Terminal colors, unless NO_COLOR is set. */
export function colors(env: NodeJS.ProcessEnv = process.env): { paint: Paint; sep: string; dim: (s: string) => string } {
  if (env.NO_COLOR) return { paint: plain, sep: " · ", dim: (s) => s };
  const wrap = (k: Tone | "sep", t: string) => `\x1b[${SGR[k][0]}m${t}\x1b[${SGR[k][1]}m`;
  return { paint: wrap, sep: wrap("sep", " · "), dim: (t) => wrap("quiet", t) };
}

/** The marks after a session's name: a failed check, and sessions waiting to be merged. */
export function render(s: Status, paint: Paint = plain, sep = " · "): string {
  const parts: string[] = [];
  if (s.broken) parts.push(paint("broken", "⚠ braid verify"));
  if (s.waiting.length === 1) {
    const w = s.waiting[0]!;
    parts.push(paint("waiting", `↓ ${w.name} +${w.count} → /braid:merge`));
  } else if (s.waiting.length > 1) {
    const total = s.waiting.reduce((a, w) => a + w.count, 0);
    parts.push(paint("waiting", `↓ ${s.waiting.length} sessions +${total} → /braid:merge`));
  }
  return parts.join(sep);
}
