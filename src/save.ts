// Saving: append what an agent wrote since the last save to the session's file.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { appendRecords, readAgents, readRecords } from "./store.ts";
import { config } from "./git.ts";
import { about, lastTurn, withBraid, type Actor, type Rec } from "./records.ts";
import { allSessions, conversation } from "./load.ts";
import { checkoutOf, ensureStore, type Repo } from "./repo.ts";
import { recordSession } from "./registry.ts";
import { replayedIds } from "./replay.ts";
import { loadState, newState, saveState, withLock, type SessionState } from "./state.ts";
import { codexLine, formatOf, intact, readWindow, START, type Format, type Window } from "./transcript.ts";
import { newestTurn, startsTurn } from "./turns.ts";
import { VERSION } from "./version.ts";

export function actorId(repo: Repo): string {
  return config("user.email", { cwd: repo.top }) ?? `${userInfo().username}@${hostname()}`;
}

/** The Claude Code version that wrote a record, from its line. */
function nativeVersion(r: Rec): string | undefined {
  const native = r.native as { source?: string; records?: { version?: unknown }[] } | undefined;
  const v = native?.source === "claude-code" ? native.records?.[0]?.version : undefined;
  return typeof v === "string" ? v : undefined;
}

/** The model a record names: Claude Code names it on each response, Codex on the settings of each turn. */
function modelOf(r: Rec): string | undefined {
  const m = r.model as { provider?: string; id?: string } | undefined;
  return (r.role === "assistant" || r.type === "settings") && m?.id ? `${m.provider ?? "unknown"}:${m.id}` : undefined;
}

/** The agent a session's transcript was written by: as its hook said, else as the transcript reads. */
export function harnessOf(state: SessionState | undefined, path: string | undefined, agent?: Format): SessionState["harness"] {
  if (agent) return agent;
  if (state && (state.chunks > 0 || state.harness !== "claude-code")) return state.harness;
  return formatOf(path) ?? state?.harness ?? "claude-code";
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
  if (!firstMessage) return undefined;
  for (const other of allSessions(repo)) {
    if (other.session === session) continue;
    const state = loadState(repo, other.session);
    if (!state || state.first !== firstMessage || state.chunks === 0) continue;
    const known = new Set<string>();
    for (const s of allSessions(repo).filter((s) => s.conv === state.conv)) for (const r of readRecords(repo, s.session)) known.add(r.id);
    return { conv: state.conv, known };
  }
  return undefined;
}

/** For a file read again from the start: whether a record is past the copies of its id the session holds already. */
function unsavedOf(saved: Rec[]): (r: Rec) => boolean {
  const left = new Map<string, number>();
  for (const r of saved) left.set(r.id, (left.get(r.id) ?? 0) + 1);
  return (r) => {
    const n = left.get(r.id) ?? 0;
    if (n > 0) left.set(r.id, n - 1);
    return n === 0;
  };
}

/**
 * Saves a session: converts what the agent wrote since the previous save with
 * ATXF's converter and appends it to the session's file, in bounded windows
 * for a large file read for the first time.
 */
export function save(repo: Repo, session: string, transcript?: string, opts: { agent?: Format } = {}): SaveResult {
  ensureStore(repo);
  recordSession(session, { project: repo.top });
  return withLock(repo, `save-${session}`, () => {
    const prior = loadState(repo, session);
    const state = prior ?? newState(session, transcript);
    if (transcript) state.transcript = transcript;
    const path = state.transcript;
    state.harness = harnessOf(prior, path, opts.agent);
    const format: Format = state.harness === "codex" ? "codex" : "claude-code";
    if (!path || !existsSync(path)) {
      saveState(repo, state);
      return { added: 0, state };
    }

    // A rewritten file, or a session saved before braid kept cursors, is read again from the start, keeping only unsaved records.
    // A session saved before braid kept titles: once, from what it holds.
    if (state.chunks > 0 && !state.title) Object.assign(state, about(readRecords(repo, session), state));
    const rewritten = state.cursor ? !intact(path, state.cursor) : state.chunks > 0;
    let cursor = rewritten || !state.cursor ? START : state.cursor;
    // A rewritten file is read again from the start: its first copies of each record are the saved ones.
    const unseen = rewritten ? unsavedOf(readRecords(repo, session)) : undefined;
    let source: ReturnType<typeof forkSource>;
    let added = 0;

    // The lines after the cursor: the window's overlap was read by the save before.
    const fresh = (w: Window): Rec[] => {
      const native = unseen ? w.records.slice(w.fresh).filter(unseen) : w.records.slice(w.fresh);
      // A rollout braid wrote for Codex starts with copies of the source's records: what Codex adds continues the source.
      if (copiedLines !== undefined) {
        return native
          .filter((r) => !(codexLine(r.id) <= copiedLines))
          .map((r) => (r.parentId && codexLine(r.parentId) <= copiedLines ? { ...r, parentId: state.forkFrom?.head ?? null } : r));
      }
      if (replayed) {
        return native
          .filter((r) => !replayed.has(r.id) && !copied(r))
          .map((r) => (r.parentId && replayed.has(r.parentId) ? { ...r, parentId: replayed.get(r.parentId) } : r));
      }
      if (source) return native.filter((r) => !source!.known.has(r.id));
      return native;
    };

    // Codex keeps a subagent in a rollout of its own, which braid does not save yet.
    const agents = format === "claude-code" ? collectAgents(repo, state, path) : new Map<string, NewAgent>();
    // A replayed session's file starts with copies of the source's records, under uuids derived from their ids;
    // the copied lines without a uuid (the session's settings) are named after their line, among the first it wrote.
    // A Codex rollout has no ids: its first lines are the copies.
    const replaying = state.chunks === 0 && !!state.forkFrom?.replayed;
    if (replaying && format === "codex") state.copied = state.forkFrom?.lines ?? 0;
    const copiedLines = format === "codex" ? state.copied : undefined;
    const replayed = replaying && format === "claude-code" ? replayedIds(conversation(repo, state.forkFrom!.conv).values()) : undefined;
    const wrote = replayed ? (state.forkFrom?.lines ?? 0) : 0;
    const copied = (r: Rec) => Number(/^claude-line-(\d+)@/.exec(r.id)?.[1] ?? Infinity) <= wrote;
    const read = () => readWindow(path, cursor, session, {}, format);
    let window = read();
    if (window && format === "claude-code" && state.chunks === 0 && !state.forkFrom) {
      source = forkSource(repo, session, window.records);
      if (source) state.conv = source.conv;
    }
    for (;;) {
      const records = window ? fresh(window) : [];
      const final = !window?.more;
      state.first ??= window?.records.find((r) => r.type === "message")?.id;
      const pending = final && (state.pendingMerge || agents.size > 0);
      if (records.length > 0 || pending) added += writeChunk(repo, state, records, window?.header, final, final ? agents : new Map());
      if (window) cursor = window.cursor;
      state.cursor = cursor;
      if (final) break;
      window = read();
      if (!window) break;
    }
    saveState(repo, state);
    // A session's first save, or one saved before braid counted turns: its turns, counted along its line once it is on disk.
    if (state.chunks > 0 && state.turn === undefined) {
      state.turn = newestTurn(repo, state.conv, session);
      saveState(repo, state);
    }
    return { added, state };
  });
}

/** Appends the records of one window to the session's file, and returns how many it wrote. A final one also carries the merge waiting to be written. */
function writeChunk(repo: Repo, state: SessionState, fresh: Rec[], nativeHeader: Record<string, unknown> | undefined, final: boolean, agents: Map<string, NewAgent>): number {
  const session = state.session;
  const first = state.chunks === 0;
  if (first && state.forkFrom) state.conv = state.forkFrom.conv;
  for (const r of fresh) {
    state.userAgent = nativeVersion(r) ? `claude-code/${nativeVersion(r)}` : state.userAgent;
    state.model = modelOf(r) ?? state.model;
  }
  Object.assign(state, about(fresh, state));
  // A rollout braid wrote names no version of Codex's (ATXF writes 0.0.0); Codex writes its own in a rollout it starts.
  const version = (nativeHeader?.source as { agent?: string; version?: string } | undefined)?.version;
  if (state.harness === "codex" && version && version !== "0.0.0") state.userAgent = `codex/${version}`;
  const actor: Actor = { actorId: actorId(repo), userAgent: state.userAgent ?? state.harness };
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
  delete state.forkFrom;

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

  const agentRecords = new Map<string, Rec[]>();
  for (const [id, a] of agents) {
    agentRecords.set(id, a.records.map((r) => withBraid(r, { actor, session, agent: id })));
    if (!a.link) continue;
    const spawnedBy = toolCallRecord(repo, state, out, a.link.toolUseId) ?? lastNative;
    out.push({
      type: "agent_link",
      id: `braid-agent-${id}`,
      parentId: spawnedBy,
      time: now,
      relation: "spawn",
      transcriptId: id,
      ...(a.link.agentType || a.link.description ? { agent: { name: a.link.agentType ?? "subagent", ...(a.link.description ? { role: a.link.description } : {}) } } : {}),
      ...(a.link.toolUseId ? { toolCallId: a.link.toolUseId } : {}),
      ext: { braid: { actor, session } },
    });
  }
  if (out.length === 0 && agentRecords.size === 0) return 0;

  appendRecords(repo, session, out, agentRecords);
  state.last = fresh.at(-1)?.id ?? state.last;
  state.head = lastTurn(out) ?? state.head;
  if (state.turn !== undefined) state.turn += out.filter(startsTurn).length;
  state.chunks += 1;
  return out.length;
}

interface NewAgent {
  records: Rec[];
  /** Set the first time the subagent is saved: what its meta file says about it. */
  link?: { toolUseId?: string; description?: string; agentType?: string };
}

/**
 * New records of the subagents Claude Code wrote next to the transcript, in
 * <transcript>/subagents/agent-<id>.jsonl, each read from its own cursor.
 */
function collectAgents(repo: Repo, state: SessionState, path: string): Map<string, NewAgent> {
  const out = new Map<string, NewAgent>();
  const dir = join(path.replace(/\.jsonl$/, ""), "subagents");
  if (!existsSync(dir)) return out;
  state.agents ??= {};
  for (const file of readdirSync(dir).sort()) {
    const id = /^agent-([A-Za-z0-9_-]+)\.jsonl$/.exec(file)?.[1];
    if (!id) continue;
    const fp = join(dir, file);
    const prior = state.agents[id];
    const rescan = !!prior && !intact(fp, prior.cursor);
    const st = rescan || !prior ? { cursor: START, linked: prior?.linked } : prior;
    const unseen = rescan ? unsavedOf(readAgents(repo, state.session).get(id) ?? []) : undefined;
    const records: Rec[] = [];
    for (let w = readWindow(fp, st.cursor, id); w; w = w.more ? readWindow(fp, st.cursor, id) : undefined) {
      const fresh = unseen ? w.records.slice(w.fresh).filter(unseen) : w.records.slice(w.fresh);
      records.push(...fresh);
      st.cursor = w.cursor;
      st.last = fresh.at(-1)?.id ?? st.last;
    }
    state.agents[id] = st;
    if (records.length === 0) continue;
    let link: NewAgent["link"];
    if (!st.linked) {
      st.linked = true;
      try {
        const meta = JSON.parse(readFileSync(join(dir, `agent-${id}.meta.json`), "utf8")) as Record<string, unknown>;
        const str = (k: string) => (typeof meta[k] === "string" ? (meta[k] as string) : undefined);
        link = { toolUseId: str("toolUseId"), description: str("description"), agentType: str("agentType") };
      } catch {
        link = {};
      }
    }
    out.set(id, { records, link });
  }
  return out;
}

/** The record holding tool call `id`: among the records being written, else among those saved. */
function toolCallRecord(repo: Repo, state: SessionState, out: Rec[], id: string | undefined): string | undefined {
  if (!id) return undefined;
  const holds = (r: Rec) => Array.isArray(r.content) && (r.content as { type?: string; id?: string }[]).some((b) => b?.type === "tool_call" && b.id === id);
  return (out.find(holds) ?? readRecords(repo, state.session).findLast(holds))?.id;
}

/** Registers a session with its transcript and the checkout it runs in, without saving anything yet. */
export function register(repo: Repo, session: string, transcript?: string, agent?: Format, cwd?: string): SessionState {
  ensureStore(repo);
  recordSession(session, { project: repo.top });
  const prior = loadState(repo, session);
  const state = prior ?? newState(session, transcript);
  if (transcript) state.transcript = transcript;
  state.harness = harnessOf(prior, state.transcript, agent);
  if (cwd) state.ran ??= checkoutOf(cwd);
  saveState(repo, state);
  return state;
}
