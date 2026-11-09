// Merging another session into the current one: a session waiting in ↓, or any
// session by id, name or pr:N. The agent writes the summary; braid records it
// when the turn ends.
import { randomUUID } from "node:crypto";
import { readRecords } from "./chunks.ts";
import { conversation, quote, resolve, type Found } from "./load.ts";
import { ancestry, braidOf, isTurn, lastTurn, type Rec } from "./records.ts";
import { storeRef, type Repo } from "./repo.ts";
import { loadState, saveState } from "./state.ts";
import { computeStatus, sessionName, type Waiting } from "./status.ts";

export interface Incoming {
  session: string;
  name: string;
  /** Their newest turn, and the newest record both sessions share. */
  head: string;
  base: string | null;
  /** Their turns since the base that no merge of this session covers yet. */
  records: Rec[];
}

/** What another session has that this one has not merged. */
function incoming(repo: Repo, session: string, remote: string, found: Found): Incoming {
  const state = loadState(repo, session);
  const conv = state?.conv ?? session;
  const mine = readRecords(storeRef(conv, session), { gitDir: repo.store });
  const all = conversation(repo, conv, remote);
  if (found.conv !== conv) for (const [id, r] of conversation(repo, found.conv, remote)) if (!all.has(id)) all.set(id, r);
  const parents = new Map([...all.values()].map((r) => [r.id, r.parentId ?? null]));
  const theirs = readRecords(found.ref, found.opts);
  const head = lastTurn(theirs) ?? theirs.at(-1)?.id ?? "";

  const myHead = lastTurn(mine);
  const shared = new Set(myHead ? ancestry(myHead, parents) : []);
  const path = ancestry(head, parents);
  const cut = path.findIndex((id) => shared.has(id));
  const covered = new Set<string>();
  const heads = [...mine.flatMap((r) => braidOf(r).merge?.heads ?? []), ...(state?.pendingMerge ? [state.pendingMerge.fromHead] : [])];
  for (const h of heads) for (const id of ancestry(h, parents)) covered.add(id);
  const records = (cut >= 0 ? path.slice(0, cut) : path)
    .reverse()
    .map((id) => all.get(id))
    .filter((r): r is Rec => !!r && isTurn(r) && !covered.has(r.id));
  return { session: found.session, name: sessionName(theirs, found.session), head, base: cut >= 0 ? path[cut]! : null, records };
}

/** Picks the session to merge: the target, or the one session waiting in ↓. */
export function pick(repo: Repo, session: string, remote: string, target?: string): { waiting: Waiting[]; chosen?: Incoming } {
  const waiting = computeStatus(repo, session, remote).waiting;
  const name = target ? (waiting.find((w) => w.session.startsWith(target) || w.name === target)?.session ?? target) : waiting.length === 1 ? waiting[0]!.session : undefined;
  if (!name) return { waiting };
  const found = resolve(repo, name, remote).filter((f) => f.session !== session);
  if (found.length === 0) throw new Error(`no session matches ${name}; try braid fetch --all, then braid sessions`);
  if (found.length > 1) throw new Error(`${name} matches ${found.length} sessions: ${found.map((f) => f.session.slice(0, 8)).join(", ")}; name one`);
  return { waiting, chosen: incoming(repo, session, remote, found[0]!) };
}

export function context(chosen: Incoming): string {
  return [
    `braid merge: merging ${chosen.name} (${chosen.session.slice(0, 8)}) into this session. Shared up to: ${chosen.base ?? "nothing"}.`,
    "This session's own records are already in your context.",
    "",
    quote(`${chosen.name}, ${chosen.records.length} records not merged yet:`, chosen.records),
    "",
    "Write a merge summary that follows the user's instruction: what the other session found, what to adopt,",
    "and what stays as it is. If the two sessions reached incompatible decisions that the instruction does not",
    "settle, ask the user before recording. Then record it:",
    "",
    `  braid merge --record ${chosen.session.slice(0, 8)} --instruction "<the user's instruction>" <<'BRAID'`,
    "  <the summary>",
    "  BRAID",
  ].join("\n");
}

export function record(repo: Repo, session: string, chosen: Incoming, opts: { instruction: string; summary: string; strategy: string }): void {
  const state = loadState(repo, session);
  if (!state || state.chunks === 0) throw new Error("this session is not saved yet");
  state.pendingMerge = {
    id: `braid-merge-${randomUUID()}`,
    from: chosen.session,
    fromHead: chosen.head,
    base: chosen.base,
    instruction: opts.instruction,
    strategy: opts.strategy,
    summary: opts.summary.trim(),
  };
  saveState(repo, state);
}
