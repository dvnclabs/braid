// Turns. A turn is a prompt you typed and everything the agent did until it
// stopped, or a merge. Each has a name, <session>.<n>: turns are numbered from
// the conversation's first prompt along the session's line, so a fork
// continues the numbering of the session it forks from.
import { readRecords } from "./chunks.ts";
import { allSessions, resolve } from "./load.ts";
import { isPrompt, lastTurn, type Rec } from "./records.ts";
import type { Repo } from "./repo.ts";
import type { Found } from "./load.ts";

export const startsTurn = (r: Rec): boolean => isPrompt(r) || r.type === "branch_summary";

export interface Session {
  session: string;
  records: Rec[];
}

/** The turn of each record, by session, for the sessions of one conversation. */
export function numbering(sessions: Session[]): Map<string, Map<string, number>> {
  const owner = new Map<string, string>();
  for (const s of sessions) for (const r of s.records) if (!owner.has(r.id)) owner.set(r.id, s.session);
  const bySession = new Map(sessions.map((s) => [s.session, s]));
  const out = new Map<string, Map<string, number>>();
  const open = new Set<string>();
  const of = (session: string): Map<string, number> => {
    const done = out.get(session);
    if (done) return done;
    open.add(session);
    const s = bySession.get(session)!;
    const ids = new Set(s.records.map((r) => r.id));
    // The session continues another from the record its first outside parent is: so does its numbering.
    const join = s.records.find((r) => r.parentId && !ids.has(r.parentId) && owner.has(r.parentId));
    const from = join ? owner.get(join.parentId!)! : undefined;
    let n = from && !open.has(from) ? (of(from).get(join!.parentId!) ?? 0) : 0;
    const turns = new Map<string, number>();
    for (const r of s.records) {
      if (startsTurn(r)) n++;
      turns.set(r.id, n);
    }
    open.delete(session);
    out.set(session, turns);
    return turns;
  };
  for (const s of sessions) of(s.session);
  return out;
}

/** The sessions of a conversation, your own copies first, with their records. */
export function conversationSessions(repo: Repo, conv: string, remote: string): (Session & { found: Found })[] {
  return allSessions(repo, remote)
    .filter((f) => f.conv === conv)
    .sort((a, b) => Number(!!b.opts.gitDir) - Number(!!a.opts.gitDir))
    .map((found) => ({ session: found.session, records: readRecords(found.ref, found.opts), found }));
}

/** The number of a session's newest turn: what its next prompt continues. */
export function newestTurn(repo: Repo, conv: string, session: string, remote: string): number {
  const turns = numbering(conversationSessions(repo, conv, remote)).get(session);
  return turns ? Math.max(0, ...turns.values()) : 0;
}

/** "5b0e2c1a.12" */
export const turnName = (session: string, n: number): string => `${session.slice(0, 8)}.${n}`;

/** A turn name: a session, by id, name or the name you gave it, then a dot and the turn's number. `.12` is this session's. */
export const TURN = /^(.*)\.(\d+)$/;

export interface Turn {
  /** The session whose records hold the turn: the one named, or one it forks from, for a turn before the fork. */
  found: Found;
  n: number;
  /** The turn's last record, which a fork continues from, and its newest point to continue from. */
  until: string;
  head: string;
}

/**
 * A session's line: the sessions it continues, each up to the record the next
 * forks at, then its own records. The first is the conversation's start.
 */
export function lineOf<S extends Session>(sessions: S[], session: string): S[] {
  const bySession = new Map(sessions.map((s) => [s.session, s]));
  const line: S[] = [];
  let s = bySession.get(session);
  let limit: string | undefined;
  while (s && !line.some((l) => l.session === s!.session)) {
    const records = limit ? s.records.slice(0, s.records.findIndex((r) => r.id === limit) + 1) : s.records;
    line.unshift({ ...s, records });
    const ids = new Set(s.records.map((r) => r.id));
    const join = s.records.find((r) => r.parentId && !ids.has(r.parentId));
    const from: S | undefined = join ? sessions.find((o) => o.session !== s!.session && o.records.some((r) => r.id === join.parentId)) : undefined;
    if (!from) break;
    limit = join!.parentId!;
    s = from;
  }
  return line;
}

export interface TurnRecords {
  n: number;
  /** The session holding the record that starts the turn, or its first record. */
  session: string;
  /** The prompt or merge that starts it; none for what comes before a session's first prompt. */
  start?: Rec;
  records: Rec[];
}

/** The turns along a line, in order, each with its records. */
export function turnsAlong(line: Session[], turns: Map<string, Map<string, number>>): TurnRecords[] {
  const out = new Map<number, TurnRecords>();
  for (const seg of line) {
    for (const r of seg.records) {
      const n = turns.get(seg.session)?.get(r.id) ?? 0;
      let t = out.get(n);
      if (!t) out.set(n, (t = { n, session: seg.session, records: [] }));
      if (!t.start && startsTurn(r)) Object.assign(t, { start: r, session: seg.session });
      t.records.push(r);
    }
  }
  return [...out.values()].sort((a, b) => a.n - b.n);
}

/** Finds turn `n` along a session's line: in its own records, or, before it forked, in a session it continues. */
export function findTurn(repo: Repo, found: Found, n: number, remote: string): Turn | undefined {
  const sessions = conversationSessions(repo, found.conv, remote);
  const line = lineOf(sessions, found.session);
  const t = turnsAlong(line, numbering(sessions)).find((t) => t.n === n && t.start);
  if (!t) return undefined;
  // A fork continues from the turn's newest point, in the newest session of the line that holds the turn.
  const seg = [...line].reverse().find((s) => t.records.some((r) => s.records.includes(r) && s.records.some((x) => x.id === r.id)))!;
  const of = t.records.filter((r) => seg.records.includes(r));
  const head = lastTurn(of);
  return head ? { found: seg.found, n, until: of.at(-1)!.id, head } : undefined;
}

/** A turn by name, as `braid fork` takes it, or undefined when the name is a session's own. */
export function resolveTurn(repo: Repo, name: string, current: string | undefined, remote: string): Turn | undefined {
  const m = TURN.exec(name);
  if (!m || (m[1] && resolve(repo, name, remote).length > 0)) return undefined;
  const target = m[1] || current;
  if (!target) throw new Error(`no session: name one, as in braid fork <id>.${m[2]}, or run inside an agent session`);
  const found = resolve(repo, target, remote);
  if (found.length !== 1) throw new Error(found.length ? `${target} matches ${found.length} sessions; name one` : `no session matches ${target}`);
  const turn = findTurn(repo, found[0]!, Number(m[2]), remote);
  if (!turn) throw new Error(`${found[0]!.session.slice(0, 8)} has no turn ${m[2]}; braid log lists its turns`);
  return turn;
}
