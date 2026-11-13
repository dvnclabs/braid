// The sessions running on this machine, and the code repositories each one
// committed in. An agent often starts in one repository and commits in another
// (a nested repository, a worktree); the git hooks of that repository find the
// session's transcript here, and that repository's remote publishes it too.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Entry {
  transcript?: string;
  /** Working trees of the code repositories the session ran or committed in. */
  repos: string[];
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
  const projects = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
  const claude = list(projects).map((d) => join(projects, d, `${session}.jsonl`)).find((p) => existsSync(p));
  if (claude) return claude;
  const sessions = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
  // Newest days first: a session is most often looked for soon after it ran.
  for (const y of list(sessions).sort().reverse())
    for (const m of list(join(sessions, y)).sort().reverse())
      for (const d of list(join(sessions, y, m)).sort().reverse()) {
        const name = list(join(sessions, y, m, d)).find((f) => f.startsWith("rollout-") && f.endsWith(`-${session}.jsonl`));
        if (name) return join(sessions, y, m, d, name);
      }
  return undefined;
}

export function readEntry(session: string): Entry | undefined {
  const path = file(session);
  if (!path || !existsSync(path)) return undefined;
  try {
    const entry = JSON.parse(readFileSync(path, "utf8")) as Partial<Entry>;
    return { transcript: entry.transcript, repos: Array.isArray(entry.repos) ? entry.repos : [] };
  } catch {
    return undefined;
  }
}

/** Records a session's transcript and, when given, a repository it is saved in. */
export function recordSession(session: string, update: { transcript?: string; repo?: string }): void {
  const path = file(session);
  if (!path) return;
  const entry = readEntry(session) ?? { repos: [] };
  if (update.transcript) entry.transcript = update.transcript;
  if (update.repo && !entry.repos.includes(update.repo)) entry.repos.push(update.repo);
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry, null, 2) + "\n");
  renameSync(tmp, path);
}
