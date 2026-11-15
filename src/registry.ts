// The sessions on this machine: each one's transcript, and the project whose
// .braid folder keeps it. A session is kept where its conversation started, so
// a fork opened in another folder is found here.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Entry {
  transcript?: string;
  /** The project whose .braid folder keeps the session. */
  project?: string;
}

function file(session: string): string | undefined {
  if (!/^[A-Za-z0-9-]{8,80}$/.test(session)) return undefined;
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "braid", "sessions", `${session}.json`);
}

/**
 * The agent session a command runs in: the one braid's session-start hook
 * named, else the one the agent names to the commands it runs (Claude Code's
 * CLAUDE_CODE_SESSION_ID, Codex's CODEX_THREAD_ID), as in a session that
 * started before braid was installed. BRAID_SESSION set empty names none.
 */
export function currentSession(): string | undefined {
  return (process.env.BRAID_SESSION ?? process.env.CLAUDE_CODE_SESSION_ID ?? process.env.CODEX_THREAD_ID) || undefined;
}

/** The agent a command runs in: Claude Code names its session to the commands it runs, and so does Codex. */
export function currentAgent(): "claude-code" | "codex" | undefined {
  if (process.env.BRAID_SESSION || process.env.CLAUDE_CODE_SESSION_ID) return "claude-code";
  return process.env.CODEX_THREAD_ID ? "codex" : undefined;
}

const list = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/**
 * A session's transcript: where its session-start hook found it, else where
 * the agent keeps it. Claude Code keeps a session as projects/<dir>/<id>.jsonl
 * under its config directory, and Codex as sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl
 * under CODEX_HOME.
 */
export function transcriptOf(session: string): string | undefined {
  const known = readEntry(session)?.transcript;
  if (known || !/^[A-Za-z0-9-]{8,80}$/.test(session)) return known;
  const projects = claudeProjects();
  const claude = list(projects).map((d) => join(projects, d, `${session}.jsonl`)).find((p) => existsSync(p));
  if (claude) return claude;
  // Newest days first: a session is most often looked for soon after it ran.
  for (const dir of codexDays().reverse()) {
    const name = list(dir).find((f) => f.startsWith("rollout-") && f.endsWith(`-${session}.jsonl`));
    if (name) return join(dir, name);
  }
  return undefined;
}

const claudeProjects = () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");

/** Codex's sessions/YYYY/MM/DD folders, oldest first. */
function codexDays(): string[] {
  const sessions = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
  const sub = (dir: string) => list(dir).sort().map((d) => join(dir, d));
  return sub(sessions).flatMap(sub).flatMap(sub);
}

/** A session's transcript on this machine, and the folder the session ran in. */
export interface OnMachine {
  session: string;
  transcript: string;
  agent: "claude-code" | "codex";
  cwd: string;
}

/**
 * The folder a session ran in, as its transcript first names it: Claude Code
 * names it on each record, Codex in the session_meta line a rollout starts
 * with. A first line can be long, as one holding a pasted image is, so the file
 * is searched as text, a block at a time.
 */
function cwdOf(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const block = Buffer.alloc(1 << 16);
    let text = "";
    for (let at = 0; at < 1 << 23; ) {
      const n = readSync(fd, block, 0, block.length, at);
      if (n === 0) return undefined;
      at += n;
      text += block.subarray(0, n).toString("latin1");
      const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(text);
      if (m) return JSON.parse(Buffer.from(`"${m[1]}"`, "latin1").toString("utf8")) as string;
      text = text.slice(-4096);
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Every Claude Code and Codex session on this machine, with the folder it ran in. */
export function sessionsOnMachine(): OnMachine[] {
  const out: OnMachine[] = [];
  const add = (session: string, transcript: string, agent: OnMachine["agent"]) => {
    const cwd = cwdOf(transcript);
    if (cwd) out.push({ session, transcript, agent, cwd });
  };
  const projects = claudeProjects();
  for (const d of list(projects))
    for (const f of list(join(projects, d))) {
      const session = /^([A-Za-z0-9-]{8,80})\.jsonl$/.exec(f)?.[1];
      if (session) add(session, join(projects, d, f), "claude-code");
    }
  for (const dir of codexDays())
    for (const f of list(dir)) {
      const session = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(f)?.[1];
      if (session) add(session, join(dir, f), "codex");
    }
  return out;
}

export function readEntry(session: string): Entry | undefined {
  const path = file(session);
  if (!path || !existsSync(path)) return undefined;
  try {
    const entry = JSON.parse(readFileSync(path, "utf8")) as Partial<Entry>;
    return { transcript: entry.transcript, project: entry.project };
  } catch {
    return undefined;
  }
}

/** Sessions on this machine whose id starts with `prefix`, with the project that keeps each. */
export function knownSessions(prefix: string): { session: string; project?: string }[] {
  if (!/^[A-Za-z0-9-]{4,80}$/.test(prefix)) return [];
  const dir = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "braid", "sessions");
  return list(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .map((session) => ({ session, project: readEntry(session)?.project }));
}

/** Records a session's transcript, or the project that keeps it. */
export function recordSession(session: string, update: { transcript?: string; project?: string }): void {
  const path = file(session);
  if (!path) return;
  const entry = readEntry(session) ?? {};
  if (update.transcript) entry.transcript = update.transcript;
  if (update.project) entry.project = update.project;
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry, null, 2) + "\n");
  renameSync(tmp, path);
}
