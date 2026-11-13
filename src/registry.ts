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
 * named, else the one Claude Code names to the commands it runs, as in a
 * session that started before braid was installed. BRAID_SESSION set empty
 * names none.
 */
export function currentSession(): string | undefined {
  return (process.env.BRAID_SESSION ?? process.env.CLAUDE_CODE_SESSION_ID) || undefined;
}

/** A session's transcript: where its session-start hook found it, else where Claude Code keeps it. */
export function transcriptOf(session: string): string | undefined {
  const known = readEntry(session)?.transcript;
  if (known || !/^[A-Za-z0-9-]{8,80}$/.test(session)) return known;
  const projects = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
  let dirs: string[];
  try {
    dirs = readdirSync(projects);
  } catch {
    return undefined;
  }
  return dirs.map((d) => join(projects, d, `${session}.jsonl`)).find((p) => existsSync(p));
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
