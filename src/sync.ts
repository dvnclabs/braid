// Merging sessions that wait in ↓ into the current one. The agent writes the
// summary; braid records it when the turn ends.
import { randomUUID } from "node:crypto";
import { readRecords } from "./chunks.ts";
import { ancestry, isTurn, type Rec } from "./records.ts";
import { remoteRefs, storeRef, type Repo } from "./repo.ts";
import { loadState, saveState } from "./state.ts";
import { computeStatus, type Waiting } from "./status.ts";
import { quote } from "./load.ts";

export function pick(repo: Repo, session: string, remote: string, target?: string): { waiting: Waiting[]; chosen?: Waiting } {
  const waiting = computeStatus(repo, session, remote).waiting;
  if (!target) return { waiting, chosen: waiting.length === 1 ? waiting[0] : undefined };
  const chosen = waiting.find((w) => w.session.startsWith(target) || w.name === target);
  return { waiting, chosen };
}

export function context(repo: Repo, session: string, remote: string, w: Waiting): string {
  const state = loadState(repo, session);
  const conv = state?.conv ?? session;
  const mine = readRecords(storeRef(conv, session), { gitDir: repo.store });
  const theirs = readRecords(`${remoteRefs(remote)}/${conv}/${w.session}`, { cwd: repo.top });
  const parents = new Map(mine.map((r) => [r.id, r.parentId ?? null]));
  const base = w.base;
  const sinceBase = (records: Rec[], head: string | undefined) => {
    if (!head) return [];
    const path = ancestry(head, parents);
    const cut = base ? path.indexOf(base) : -1;
    return (cut >= 0 ? path.slice(0, cut) : path).reverse().map((id) => records.find((r) => r.id === id)!).filter(Boolean);
  };
  const myHead = [...mine].reverse().find(isTurn)?.id;
  const ours = sinceBase(mine, myHead).filter(isTurn);
  return [
    `braid sync: merging ${w.name} (${w.session.slice(0, 8)}) into this session. Base: ${base ?? "none"}.`,
    "",
    `This session since the base, ${ours.length} records: already in your context.`,
    "",
    quote(`${w.name} since the base, ${w.count} records not merged yet:`, theirs.filter(isTurn)),
    "",
    "Write a merge summary that follows the user's instruction: what the other session found, what to adopt,",
    "and what stays as it is. If the two sessions reached incompatible decisions that the instruction does not",
    "settle, ask the user before recording. Then record it:",
    "",
    `  braid sync --record ${w.session.slice(0, 8)} --instruction "<the user's instruction>" <<'EOF'`,
    "  <the summary>",
    "  EOF",
  ].join("\n");
}

export function record(
  repo: Repo,
  session: string,
  w: Waiting,
  opts: { instruction: string; summary: string; strategy: string },
): void {
  const state = loadState(repo, session);
  if (!state) throw new Error("this session is not saved yet");
  state.pendingMerge = {
    id: `braid-merge-${randomUUID()}`,
    from: w.session,
    fromHead: w.head,
    base: w.base,
    instruction: opts.instruction,
    strategy: opts.strategy,
    summary: opts.summary.trim(),
  };
  saveState(repo, state);
}
