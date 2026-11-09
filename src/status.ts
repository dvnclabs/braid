// What the status line shows: unpublished records (↑) and sessions built on
// this one that wait to be merged (↓).
import { readRecords } from "./chunks.ts";
import { forEachRef, gitMaybe } from "./git.ts";
import { braidOf, isTurn, type Rec } from "./records.ts";
import { isEnabled, remoteRefs, SESSION_REFS, storeRef, type Repo } from "./repo.ts";
import { loadState } from "./state.ts";

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
  enabled: boolean;
  saved: boolean;
  conv?: string;
  private: boolean;
  /** Saved, never published, and never committed. */
  local: boolean;
  ahead: number;
  waiting: Waiting[];
}

/** Keeps names printable: other people write them. */
export function cleanName(name: string): string {
  return name.replace(/[^A-Za-z0-9/._-]/g, "").slice(0, 32);
}

export function sessionName(records: Rec[], session: string): string {
  const label = records.find((r) => r.type === "label" && typeof r.label === "string" && !braidOf(r).commit);
  return (label && cleanName(String(label.label))) || session.slice(0, 8);
}

/** The conversation a session of the store belongs to. */
export function convOf(repo: Repo, session: string): string | undefined {
  const state = loadState(repo, session);
  if (state && state.chunks > 0) return state.conv;
  const ref = forEachRef([`${SESSION_REFS}/*/${session}`], { gitDir: repo.store })[0];
  return ref?.ref.split("/")[2];
}

function linkedByCommit(repo: Repo, session: string): boolean {
  const log = gitMaybe(["log", "-n", "200", "--format=%(trailers:key=Braid-Session,valueonly)", "HEAD"], { cwd: repo.top }) ?? "";
  return log.split("\n").some((line) => line.trim() === session);
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

export function computeStatus(repo: Repo, session: string, remote = "origin"): Status {
  const status: Status = { session, enabled: isEnabled(repo), saved: false, private: false, local: false, ahead: 0, waiting: [] };
  const conv = convOf(repo, session);
  if (!conv) return status;
  const state = loadState(repo, session);
  const mine = readRecords(storeRef(conv, session), { gitDir: repo.store });
  if (mine.length === 0) return status;
  Object.assign(status, { saved: true, conv, private: state?.private ?? false });

  const tracking = remoteRefs(remote);
  const published = new Set(readRecords(`${tracking}/${conv}/${session}`, { cwd: repo.top }).map((r) => r.id));
  const withheld = new Set(state?.withheld ?? []);
  status.ahead = mine.filter((r) => isTurn(r) && !published.has(r.id) && !withheld.has(r.id)).length;
  const committed = mine.some((r) => r.type === "label" && braidOf(r).commit);
  status.local = published.size === 0 && !committed && !(state?.commits ?? []).length && !linkedByCommit(repo, session);

  const myIds = new Set(mine.map((r) => r.id));
  const pending = state?.pendingMerge ? [state.pendingMerge.fromHead] : [];
  // Your own branches of this conversation, then everyone's published sessions.
  const refs = new Map<string, { ref: string; opts: { gitDir?: string; cwd?: string } }>();
  for (const { ref } of forEachRef([`${SESSION_REFS}/${conv}/`], { gitDir: repo.store })) refs.set(ref.slice(ref.lastIndexOf("/") + 1), { ref, opts: { gitDir: repo.store } });
  for (const { ref } of forEachRef([`${tracking}/${conv}/`], { cwd: repo.top })) {
    const other = ref.slice(ref.lastIndexOf("/") + 1);
    if (!refs.has(other)) refs.set(other, { ref, opts: { cwd: repo.top } });
  }
  for (const [other, { ref, opts }] of refs) {
    if (other === session) continue;
    const theirs = readRecords(ref, opts);
    const fork = theirs.find((r) => r.parentId && myIds.has(r.parentId));
    if (!fork) continue;
    const open = uncovered(mine, theirs, pending);
    if (open.length === 0) continue;
    const head = [...theirs].reverse().find(isTurn)?.id ?? open.at(-1)!.id;
    status.waiting.push({ session: other, name: sessionName(theirs, other), count: open.length, head, base: fork.parentId ?? null });
  }
  return status;
}

/** The braid part of the status line, after the session id. */
export function render(s: Status): string {
  if (!s.enabled) return "";
  if (!s.saved) return "not saved";
  const parts: string[] = [];
  if (s.private) parts.push("private");
  else if (s.local) parts.push("local");
  else if (s.ahead > 0) parts.push(`↑${s.ahead}`);
  if (s.waiting.length === 1) {
    const w = s.waiting[0]!;
    parts.push(`↓ ${w.name} +${w.count} → /braid:merge`);
  } else if (s.waiting.length > 1) {
    const total = s.waiting.reduce((a, w) => a + w.count, 0);
    parts.push(`↓ ${s.waiting.length} sessions +${total} → /braid:merge`);
  }
  return parts.length ? parts.join(" · ") : "✓";
}
