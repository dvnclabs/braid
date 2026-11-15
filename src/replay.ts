// Forking into a new window: write a saved session back out as a Claude Code
// transcript under a new session id, so `claude --resume` continues it here,
// on another machine, or as a second direction from the same point. Paths from
// the source checkout are rewritten to this one.
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, realpathSync } from "node:fs";
import { claudeCode, uuidFor } from "@leostera/atxf/claude-code";
import { readRecords } from "./chunks.ts";
import { conversation, type Found } from "./load.ts";
import { about, asCodexShowed, braidOf, contextPath, forModel, lastTurn, type Rec } from "./records.ts";
import type { Harness } from "./harness.ts";
import { userConfig, type Repo } from "./repo.ts";
import { loadState, newState, saveState } from "./state.ts";
import { conversationSessions, numbering } from "./turns.ts";

/** The directory a Claude Code session started in, from its transcript: where `claude --resume` finds it. */
export function launchDir(transcript: string | undefined): string | undefined {
  if (!transcript || !existsSync(transcript)) return undefined;
  const buf = Buffer.alloc(256 * 1024);
  const fd = openSync(transcript, "r");
  let n: number;
  try {
    n = readSync(fd, buf, 0, buf.length, 0);
  } finally {
    closeSync(fd);
  }
  for (const line of buf.subarray(0, n).toString("utf8").split("\n")) {
    try {
      const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
      if (typeof cwd === "string") return cwd;
    } catch {
      // a partial last line
    }
  }
  return undefined;
}

/** A word for sh: as is when safe, else single-quoted. */
export const shellWord = (s: string): string => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** Replaces path prefixes in every string, except in reasoning, which its signature covers, and in images. */
export function rewrite<T>(value: T, pairs: [string, string][]): T {
  if (typeof value === "string") {
    let s: string = value;
    for (const [from, to] of pairs) if (from && from !== to) s = s.split(from).join(to);
    return s as T;
  }
  if (Array.isArray(value)) return value.map((v) => rewrite(v, pairs)) as T;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (KEEP.has(String(obj.type))) return value;
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, k === "native" || k === "replay" ? v : rewrite(v, pairs)])) as T;
  }
  return value;
}

const KEEP = new Set(["reasoning", "thinking", "redacted_thinking", "image", "base64"]);

export type Line = Record<string, unknown>;

/** The Claude Code line a record was read from, when braid keeps it and the record is the first read from it. */
export function ownLine(r: Rec): Line | undefined {
  const n = r.native as { source?: string; records?: unknown[] } | undefined;
  const line = n?.source === "claude-code" && n.records?.length === 1 ? n.records[0] : undefined;
  return line && typeof line === "object" ? (line as Line) : undefined;
}

/** The record read before this one from the same line, if any. */
const readWith = (r: Rec): string | undefined => (r.native as { of?: string } | undefined)?.of;

/** Lines that belong to the source session alone: its request log, file history, input queue and last prompt. */
export const SOURCE_ONLY = new Set(["api-request", "api-request-blob", "api-request-shape", "file-history-snapshot", "file-history-delta", "queue-operation", "last-prompt"]);

/** Native uuids of the messages a compaction kept from before its summary; Claude Code puts them back after it. */
export function keptUuids(boundary: Line | undefined): string[] {
  if (boundary?.subtype !== "compact_boundary") return [];
  const kept = (boundary.compactMetadata as { preservedMessages?: { allUuids?: unknown; uuids?: unknown } } | undefined)?.preservedMessages;
  const list = kept?.allUuids ?? kept?.uuids;
  return Array.isArray(list) ? list.filter((u): u is string => typeof u === "string") : [];
}

/** What a fork holds: the records it writes, in order, and the context path among them. */
export interface ForkRecords {
  records: Rec[];
  path: Rec[];
}

/**
 * The records a fork of a session at `head` holds, `own` being the session's
 * records and `all` its conversation's. Of the session itself, everything it
 * wrote since its last compaction, in the order it wrote it, with the
 * messages the compaction kept: Claude Code reads more than the context path
 * to resume a session (the rest of a parallel response, notes on results,
 * how the tools it may call changed, even on branches left behind), so a fork
 * holds it all and Claude Code reads it as it reads the source. Of the
 * sessions it continues, the context path.
 */
export function forkRecords(all: Map<string, Rec>, own: Rec[], head: string): ForkRecords {
  const path = contextPath(head, all);
  const mine = new Set(own.map((r) => r.id));
  const kept = new Set(path[0] ? keptUuids(ownLine(path[0])) : []);
  const compacted = path[0] && ownLine(path[0])?.subtype === "compact_boundary" ? path[0].id : undefined;
  const from = Math.max(0, own.findIndex((r) => r.id === compacted));
  const before = [...[...kept].flatMap((u) => (mine.has(u) || !all.has(u) ? [] : [all.get(u)!])), ...path.filter((r) => !mine.has(r.id))];
  const since = own.filter((r, i) => (i >= from || kept.has(r.id)) && !SOURCE_ONLY.has(String(ownLine(r)?.type)));
  return { records: [...before, ...since], path };
}

/** Records as one line of history, each the child of the one before: the order an agent reads them in. */
export const linear = (records: Rec[]): Rec[] => records.map((r, i) => ({ ...r, parentId: i ? records[i - 1]!.id : null }));

/**
 * Another agent's responses as Claude Code writes them: a response is one
 * message, written a block per line under the response's id, and a model API
 * takes a batch of parallel tool calls as one message, then their results.
 * Codex writes each item of a response on its own, so the assistant messages
 * between two others make one response.
 */
function asResponses(records: Rec[]): Rec[] {
  let response: string | undefined;
  return records.map((r) => {
    if (r.type !== "message") return r;
    if (r.role !== "assistant" || ownLine(r) || typeof r.responseId === "string") {
      response = undefined;
      return r;
    }
    response ??= `msg_${r.id}`;
    return { ...r, responseId: response };
  });
}

/**
 * A Claude Code transcript of a fork under a new session id. Each record goes
 * out as the very line Claude Code wrote, when braid keeps it, so Claude Code
 * resumes the fork as it resumes the source. Records from elsewhere (a
 * published session, a merge, another agent's session) are written by ATXF's
 * converter when they are on the context path, as their agent showed them to
 * its model; a record it writes nothing for (another agent's settings, its
 * bookkeeping) passes its place in the chain to its children. Lines keep their
 * links to each other, under uuids derived from the records' ids.
 */
export function forkText(fork: ForkRecords, session: string, cwd: string, pairs: [string, string][] = []): string {
  const { records, path } = fork;
  const header = { type: "transcript", atxf: "0.1", id: session, time: path[0]?.time ?? new Date().toISOString(), source: { agent: "braid", sessionId: session }, workspace: { cwd } };
  // The converter writes the context path as one chain; it ends where a record left out would break it.
  const encoded = claudeCode
    .fromAtxf({ header, records: linear(asResponses(forModel(rewrite(asCodexShowed(path, "claude-code"), pairs), "anthropic"))) } as never, { carry: false, sessionId: session })
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Line);
  const byUuid = new Map(encoded.map((l) => [l.uuid, l]));
  const lines: { r: Rec; line: Line }[] = [];
  // The line each record is read back from: its own, or the one it shares with the record before it.
  const lineOf = new Map<string, string>();
  for (const r of records) {
    const own = ownLine(r);
    const of = readWith(r);
    if (own) lines.push({ r, line: rewrite(own, pairs) });
    else if (of && lineOf.has(of)) {
      lineOf.set(r.id, lineOf.get(of)!);
      continue;
    } else {
      const line = byUuid.get(uuidFor(r.id));
      if (!line) {
        // Nothing written for it: its children continue from the line it continues from.
        const parent = r.parentId ? lineOf.get(r.parentId) : undefined;
        if (parent) lineOf.set(r.id, parent);
        continue;
      }
      lines.push({ r, line });
      // A record the converter writes as several lines, as a compaction with the messages it kept: the rest follow
      // it, and its children continue from the last.
      let last = r.id;
      for (let n = 2; byUuid.has(uuidFor(`${r.id}#${n}`)); n++) {
        const id = `${r.id}#${n}`;
        lines.push({ r: { ...r, id, parentId: last }, line: byUuid.get(uuidFor(id))! });
        lineOf.set(id, uuidFor(id));
        last = id;
      }
      lineOf.set(r.id, uuidFor(last));
      continue;
    }
    lineOf.set(r.id, uuidFor(r.id));
  }
  // A line that names another (a tool result its call, a compaction what it kept, a tools record the change it
  // announced) names it by its new uuid, wherever it does outside the message. Other ids stay as they are.
  const renamed = new Map(lines.flatMap(({ r, line }) => (typeof line.uuid === "string" ? [[line.uuid, uuidFor(r.id)] as const] : [])));
  const rename = (v: unknown): unknown =>
    typeof v === "string" ? (renamed.get(v) ?? v) : Array.isArray(v) ? v.map(rename) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rename(x)])) : v;
  let previous: string | null = null;
  const out = lines.map(({ r, line }) => {
    const next: Line = { ...(Object.fromEntries(Object.entries(line).map(([k, v]) => [k, k === "message" ? v : rename(v)])) as Line), sessionId: session };
    if ("uuid" in next) {
      // A parent the fork does not hold stays named as it was: Claude Code stops there, as it does in the source.
      const kept = typeof line.parentUuid === "string" && !renamed.has(line.parentUuid) ? line.parentUuid : previous;
      const parent = r.parentId == null ? null : (lineOf.get(r.parentId) ?? lineOf.get(r.parentId.split(":")[0]!) ?? kept);
      Object.assign(next, { parentUuid: parent, uuid: uuidFor(r.id), isSidechain: false });
      previous = next.uuid as string;
    }
    return JSON.stringify(next);
  });
  return out.length ? `${out.join("\n")}\n` : "";
}

/** The working directory the source session ran in, as its records name it. */
function sourceCwd(records: Rec[]): string | undefined {
  for (const r of records) {
    const ws = (r.workspace as { cwd?: unknown } | undefined)?.cwd;
    if (r.type === "transcript" && typeof ws === "string") return ws;
    const native = (r.native as { records?: { cwd?: unknown }[] } | undefined)?.records?.[0]?.cwd;
    if (typeof native === "string") return native;
  }
  return undefined;
}

export interface Replayed {
  session: string;
  file: string;
  cwd: string;
  records: number;
  /** Written before: the same fork was asked for already, and this is the session it wrote. */
  existing?: boolean;
}

/**
 * Writes a fork of a saved session as a new session of `to`'s, which
 * continues it there. The same fork, of the same point of the same session
 * into the same agent and directory, is one session: asked for again, it is
 * the session written the first time, as it stands, continued or not. With
 * `fresh`, a fork is another session each time.
 */
export function replay(repo: Repo, found: Found, remote: string, to: Harness, opts: { cwd?: string; fresh?: boolean; until?: string } = {}): Replayed {
  const all = conversation(repo, found.conv, remote);
  const read = readRecords(found.ref, found.opts);
  // From a turn: the session up to that turn's last record.
  const own = opts.until ? read.slice(0, read.findIndex((r) => r.id === opts.until) + 1) : read;
  if (opts.until && own.length === 0) throw new Error(`session ${found.session.slice(0, 8)} has no record ${opts.until}`);
  const head = lastTurn(own) ?? own.at(-1)?.id;
  if (!head) throw new Error(`session ${found.session.slice(0, 8)} has no records to replay`);
  const fork = forkRecords(all, own, head);

  const cwd = realpathSync(opts.cwd ?? process.cwd());
  const from = sourceCwd([...all.values()]);
  // Paths move to another checkout; within the same tree (a subdirectory of it, say) they stay as they are.
  const within = !!from && (from === cwd || cwd.startsWith(`${from}/`) || from.startsWith(`${cwd}/`));
  const pairs: [string, string][] = [...(from && !within ? [[from, cwd] as [string, string]] : []), ...userConfig().paths];
  const derived = uuidFor(`braid fork ${found.session} ${head} ${to.agent} ${cwd}`);
  const before = opts.fresh ? undefined : to.existing(derived, cwd);
  if (before) return { session: derived, file: before, cwd, records: 0, existing: true };
  // A fork that was continued, saved, and its file then removed keeps its id: this one is another.
  const session = opts.fresh || (loadState(repo, derived)?.chunks ?? 0) > 0 ? randomUUID() : derived;
  const { file, lines } = to.write(fork, all, cwd, pairs, session);

  // The new session continues the source: its first save keeps only what the agent adds after the copy.
  const state = loadState(repo, session) ?? newState(session, file, to.agent);
  const first = own.find((r) => braidOf(r).actor);
  state.forkFrom = { session: found.session, conv: found.conv, head, actor: first ? braidOf(first).actor?.actorId : undefined, replayed: true, lines };
  // The fork is about what its source was about at the point it forks from; from the newest, as it is now.
  const upTo = head === lastTurn(own) ? own.length - 1 : own.findIndex((r) => r.id === head);
  Object.assign(state, about(upTo >= 0 ? own.slice(0, upTo + 1) : own, state));
  // Its turns continue the numbering from the turn it forks at.
  state.turn = numbering(conversationSessions(repo, found.conv, remote)).get(found.session)?.get(head) ?? 0;
  saveState(repo, state);
  return { session, file, cwd, records: lines };
}

/** For the first save of a replayed session: native uuid of each copied record → its id in the source. */
export function replayedIds(records: Iterable<Rec>): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of records) {
    map.set(uuidFor(r.id), r.id);
    // A record read after another from the same line is read back from the fork's copy of that line, under its new uuid.
    const of = readWith(r);
    if (of && r.id.startsWith(`${of}:`)) map.set(`${uuidFor(of)}${r.id.slice(of.length)}`, r.id);
  }
  return map;
}
