// Saving: append what an agent wrote since the last save to the session's file.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { appendRecords, readAgents, readRecords } from "./store.ts";
import { config } from "./git.ts";
import { about, lastTurn, withBraid, type Actor, type Rec } from "./records.ts";
import { checkoutOf, ensureStore, projectOf, repoAt, repoFor, type Repo } from "./repo.ts";
import { knownEntries, recordSession, sessionsOnMachine, type OnMachine } from "./registry.ts";
import { loadState, newState, saveState, withLock, type SessionState } from "./state.ts";
import { formatOf, intact, readWindow, START, type Format, type Window } from "./transcript.ts";
import { startsTurn } from "./turns.ts";
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
    const firstSave = state.chunks === 0;
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
    let added = 0;

    // The lines after the cursor: the window's overlap was read by the save before.
    const fresh = (w: Window): Rec[] => (unseen ? w.records.slice(w.fresh).filter(unseen) : w.records.slice(w.fresh));

    // Codex keeps a subagent in a rollout of its own, which braid does not save yet.
    const agents = format === "claude-code" ? collectAgents(repo, state, path) : new Map<string, NewAgent>();
    const read = () => readWindow(path, cursor, session, {}, format);
    let window = read();
    for (;;) {
      const records = window ? fresh(window) : [];
      const final = !window?.more;
      if (records.length > 0 || (final && agents.size > 0)) added += writeChunk(repo, state, records, window?.header, final ? agents : new Map());
      if (window) cursor = window.cursor;
      state.cursor = cursor;
      if (final) break;
      window = read();
      if (!window) break;
    }
    saveState(repo, state);
    // A session's first save, or one saved before braid counted turns: its turns, counted in its file.
    if (state.chunks > 0 && (firstSave || state.turn === undefined)) {
      state.turn = readRecords(repo, session).filter(startsTurn).length;
      saveState(repo, state);
    }
    return { added, state };
  });
}

/** Appends the records of one window to the session's file, and returns how many it wrote. */
function writeChunk(repo: Repo, state: SessionState, fresh: Rec[], nativeHeader: Record<string, unknown> | undefined, agents: Map<string, NewAgent>): number {
  const session = state.session;
  const first = state.chunks === 0;
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
  if (first) out.push(header(nativeHeader ?? {}, session));
  for (const r of fresh) out.push(withBraid({ ...r }, { actor, session }));
  const lastNative = fresh.at(-1)?.id ?? state.last ?? state.head ?? null;

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

export interface Saved {
  session: string;
  repo: Repo;
  added: number;
  state?: SessionState;
  error?: string;
}

/**
 * `braid save --all`: every Claude Code and Codex session on this machine that
 * ran in the project `cwd` is in, in any of its worktrees, saved up to now, as
 * sessions that started before braid was installed. A session saved already
 * gets only what it wrote since. A session that ran in a folder since deleted,
 * as a removed worktree, cannot be told apart and is left out.
 */
export function saveAll(cwd: string): { project: string; saved: Saved[] } {
  const { project, sessions } = projectSessions(cwd);
  const saved = sessions.map((s): Saved => {
      const repo = repoFor(s.session, s.cwd);
    try {
      register(repo, s.session, s.transcript, s.agent, s.cwd);
      return { session: s.session, repo, ...save(repo, s.session, s.transcript, { agent: s.agent }) };
    } catch (err) {
      return { session: s.session, repo, added: 0, error: err instanceof Error ? err.message : String(err) };
    }
  });
  return { project, saved };
}

/** The sessions on this machine that ran in the project `cwd` is in, in any of its worktrees. */
export function projectSessions(cwd: string): { project: string; sessions: OnMachine[] } {
  const project = projectOf(cwd);
  const projects = new Map<string, string>();
  const projectAt = (dir: string) => {
    if (!projects.has(dir)) projects.set(dir, existsSync(dir) ? projectOf(dir) : "");
    return projects.get(dir);
  };
  return { project, sessions: sessionsOnMachine().filter((s) => projectAt(s.cwd) === project) };
}

/** Sessions of the project `cwd` is in that ran on this machine and braid has not saved, as those from before it was installed. */
export function unsaved(cwd: string): OnMachine[] {
  return projectSessions(cwd).sessions.filter((s) => !((loadState(repoFor(s.session, s.cwd), s.session)?.chunks ?? 0) > 0));
}

/** Whether a session's agent wrote lines since braid last saved it: to its transcript, or to a subagent's. */
export function behind(state: SessionState, transcript = state.transcript): boolean {
  if (!transcript || !existsSync(transcript)) return false;
  if (statSync(transcript).size > (state.cursor?.offset ?? 0)) return true;
  if (state.harness !== "claude-code") return false;
  const dir = join(transcript.replace(/\.jsonl$/, ""), "subagents");
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((f) => {
    const id = /^agent-([A-Za-z0-9_-]+)\.jsonl$/.exec(f)?.[1];
    return !!id && statSync(join(dir, f)).size > (state.agents?.[id]?.cursor.offset ?? 0);
  });
}

/**
 * `braid save --pending`: every session on this machine that its agent wrote
 * more of since braid last saved it, as one that crashed or was force-quit
 * before its hooks ran, saved now. A session counts once it ran: saved before,
 * registered by its agent's hook, or, for a fork braid wrote, grown past what
 * braid wrote, as where braid's hooks do not run; a fork nobody opened does
 * not. Sessions whose project's .braid folder is gone stay as they are.
 */
export function savePending(): Saved[] {
  return knownEntries().flatMap(({ session, project }): Saved[] => {
    if (!project || !existsSync(join(project, ".braid"))) return [];
    const repo = repoAt(project);
    const state = loadState(repo, session);
    const continued = state?.written !== undefined && !!state.transcript && existsSync(state.transcript) && statSync(state.transcript).size > state.written;
    if (!state || !(state.chunks > 0 || state.ran || continued) || !behind(state)) return [];
    try {
      return [{ session, repo, ...save(repo, session) }];
    } catch (err) {
      return [{ session, repo, added: 0, error: err instanceof Error ? err.message : String(err) }];
    }
  });
}
