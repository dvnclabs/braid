// Saving: import what a harness wrote since the last save into the store.
import { existsSync, readdirSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { appendChunk, readRecords } from "./chunks.ts";
import { config, forEachRef, gitMaybe } from "./git.ts";
import { lastTurn, withBraid, type Actor, type Rec } from "./records.ts";
import { ensureStore, SESSION_REFS, storeRef, type Repo } from "./repo.ts";
import { loadState, newState, saveState, withLock, type SessionState } from "./state.ts";
import { intact, readWindow, START } from "./transcript.ts";
import { VERSION } from "./version.ts";

export function actorId(repo: Repo): string {
  return config("user.email", { cwd: repo.top }) ?? `${userInfo().username}@${hostname()}`;
}

function nativeVersion(r: Rec): string | undefined {
  const native = r.native as { records?: { version?: unknown }[] } | undefined;
  const v = native?.records?.[0]?.version;
  return typeof v === "string" ? v : undefined;
}

function modelOf(r: Rec): string | undefined {
  const m = r.model as { provider?: string; id?: string } | undefined;
  return r.role === "assistant" && m?.id ? `${m.provider ?? "unknown"}:${m.id}` : undefined;
}

function header(h: Record<string, unknown>, session: string): Rec {
  return {
    type: "transcript",
    atxf: "0.1",
    id: session,
    time: String(h.time ?? new Date().toISOString()),
    ...(h.title ? { title: h.title } : {}),
    source: { agent: "braid", version: VERSION },
    ...(h.workspace ? { workspace: h.workspace } : {}),
    fidelity: { topology: "tree", native: "all" },
    ext: { braid: { version: 1 } },
  };
}

export interface SaveResult {
  added: number;
  state: SessionState;
}

/**
 * The conversation this session was copied from. Claude Code's /branch and
 * --fork-session copy the transcript with the same record ids, so a new
 * session whose first message belongs to a saved session is a fork of it.
 */
function forkSource(repo: Repo, session: string, native: Rec[]): { conv: string; known: Set<string> } | undefined {
  const firstMessage = native.find((r) => r.type === "message")?.id;
  const dir = join(repo.dir, "sessions");
  if (!firstMessage || !existsSync(dir)) return undefined;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json") || name === `${session}.json`) continue;
    const other = loadState(repo, name.slice(0, -".json".length));
    if (!other || other.first !== firstMessage || other.chunks === 0) continue;
    const known = new Set<string>();
    for (const { ref } of forEachRef([`${SESSION_REFS}/${other.conv}/`], { gitDir: repo.store })) {
      for (const r of readRecords(ref, { gitDir: repo.store })) known.add(r.id);
    }
    return { conv: other.conv, known };
  }
  return undefined;
}

/**
 * Saves a session: converts what the harness wrote since the previous save
 * with ATXF's converter and appends it to the session's ref as one chunk, or
 * as several bounded chunks for a large file read for the first time. A save
 * commits the conversation, as a label on its newest turn, for each code
 * commit made since the previous save and for `opts.commit`.
 */
export function save(repo: Repo, session: string, transcript?: string, opts: { commit?: string } = {}): SaveResult {
  ensureStore(repo);
  return withLock(repo, `save-${session}`, () => {
    const state = loadState(repo, session) ?? newState(session, transcript);
    if (transcript) state.transcript = transcript;
    const path = state.transcript;
    if (!path || !existsSync(path)) {
      if (opts.commit !== undefined) throw new Error("this session is not saved yet: braid saves sessions that start after it is set up");
      return { added: 0, state };
    }

    // A rewritten file, or a session saved before braid kept cursors, is read again from the start, keeping only unsaved records.
    const rewritten = state.cursor ? !intact(path, state.cursor) : state.chunks > 0;
    let cursor = rewritten || !state.cursor ? START : state.cursor;
    let saved: Set<string> | undefined;
    const savedIds = () => (saved ??= new Set(readRecords(storeRef(state.conv, session), { gitDir: repo.store }).map((r) => r.id)));
    let source: ReturnType<typeof forkSource>;
    let added = 0;

    const fresh = (native: Rec[]): Rec[] => {
      if (source) return native.filter((r) => !source!.known.has(r.id));
      if (state.chunks === 0 && !state.last) return native;
      if (!rewritten && state.last) {
        const i = native.findIndex((r) => r.id === state.last);
        if (i >= 0) return native.slice(i + 1);
      }
      return native.filter((r) => !savedIds().has(r.id));
    };

    let window = readWindow(path, cursor, session);
    if (window && state.chunks === 0 && !state.forkFrom) {
      source = forkSource(repo, session, window.records);
      if (source) state.conv = source.conv;
    }
    for (;;) {
      const records = window ? fresh(window.records) : [];
      for (const r of records) saved?.add(r.id);
      const final = !window?.more;
      state.first ??= window?.records.find((r) => r.type === "message")?.id;
      const pending = final && (state.pendingMerge || (state.commits ?? []).length > 0 || opts.commit !== undefined);
      if (records.length > 0 || pending) added += writeChunk(repo, state, records, window?.header, final, opts);
      if (window) cursor = window.cursor;
      state.cursor = cursor;
      if (final) break;
      window = readWindow(path, cursor, session);
      if (!window) break;
    }
    saveState(repo, state);
    if (state.chunks > 0 && state.chunks % 50 === 0) gitMaybe(["gc", "--auto", "--quiet"], { gitDir: repo.store });
    return { added, state };
  });
}

/**
 * Appends one chunk with the records and returns how many it wrote. A final
 * chunk also carries the merge waiting to be written, and a commit label for
 * each code commit since the previous save and for `opts.commit`.
 */
function writeChunk(repo: Repo, state: SessionState, fresh: Rec[], nativeHeader: Record<string, unknown> | undefined, final: boolean, opts: { commit?: string }): number {
  const session = state.session;
  const first = state.chunks === 0;
  if (first && state.forkFrom) state.conv = state.forkFrom.conv;
  for (const r of fresh) {
    state.userAgent = nativeVersion(r) ? `claude-code/${nativeVersion(r)}` : state.userAgent;
    state.model = modelOf(r) ?? state.model;
  }
  const actor: Actor = { actorId: actorId(repo), userAgent: state.userAgent ?? "claude-code" };
  const now = new Date().toISOString();

  const out: Rec[] = [];
  if (first && state.conv === session) out.push(header(nativeHeader ?? {}, session));
  for (const r of fresh) {
    let rec: Rec = { ...r };
    // A session forked from another before its first save continues from it.
    if (first && state.forkFrom && rec.parentId == null) rec.parentId = state.forkFrom.head;
    if (state.reparent && rec.parentId === state.reparent.from) rec.parentId = state.reparent.to;
    rec = withBraid(rec, { actor, session });
    if (state.pendingMerge) rec = withBraid(rec, { partOf: state.pendingMerge.id });
    out.push(rec);
  }
  const lastNative = fresh.at(-1)?.id ?? state.last ?? state.head ?? null;

  if (first && state.forkFrom?.actor && state.forkFrom.actor !== actor.actorId) {
    const target = fresh.find((r) => r.type === "message")?.id;
    if (target) {
      out.push({
        type: "label",
        id: `braid-label-${randomUUID()}`,
        time: now,
        targetId: target,
        label: `review/${actor.actorId.split("@")[0]}`,
        ext: { braid: { actor, session } },
      });
      state.review = true;
    }
  }
  delete state.forkFrom;

  const codeCommits = final ? (state.commits ?? []) : [];
  if (final && state.pendingMerge && lastNative) {
    const pm = state.pendingMerge;
    out.push({
      type: "branch_summary",
      id: pm.id,
      parentId: lastNative,
      time: now,
      fromId: pm.fromHead,
      summary: pm.summary,
      ext: {
        braid: {
          actor: { actorId: actor.actorId, userAgent: `${actor.userAgent} braid/${VERSION}` },
          session,
          merge: {
            base: pm.base,
            heads: [lastNative, pm.fromHead],
            instruction: pm.instruction,
            strategy: pm.strategy,
            model: state.model ?? "unknown",
            conflicts: [],
          },
        },
      },
    });
    state.reparent = { from: lastNative, to: pm.id };
    delete state.pendingMerge;
  }

  if (final) {
    const target = lastTurn(out) ?? state.head;
    const commits = codeCommits.map((sha) => ({ sha, message: gitMaybe(["log", "-1", "--format=%s", sha], { cwd: repo.top })?.trim() ?? "" }));
    if (opts.commit !== undefined) commits.push({ sha: "", message: opts.commit });
    if (opts.commit !== undefined && !target) throw new Error("nothing to commit: this session has no saved turns yet");
    for (const c of target ? commits : []) {
      out.push({
        type: "label",
        id: `braid-commit-${randomUUID()}`,
        time: now,
        targetId: target,
        label: c.message || "commit",
        ext: { braid: { actor, session, commit: c.sha ? { sha: c.sha } : {} } },
      });
    }
  }
  if (out.length === 0) return 0;

  const head = gitMaybe(["rev-parse", "-q", "--verify", "HEAD"], { cwd: repo.top })?.trim();
  appendChunk(storeRef(state.conv, session), out, { time: now, head, commits: codeCommits }, { gitDir: repo.store });
  state.last = fresh.at(-1)?.id ?? state.last;
  state.head = lastTurn(out) ?? state.head;
  state.chunks += 1;
  if (final) state.commits = [];
  return out.length;
}

/** Registers a session with its transcript, without saving anything yet. */
export function register(repo: Repo, session: string, transcript?: string): SessionState {
  ensureStore(repo);
  const state = loadState(repo, session) ?? newState(session, transcript);
  if (transcript) state.transcript = transcript;
  saveState(repo, state);
  return state;
}


