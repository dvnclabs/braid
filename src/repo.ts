// Where braid keeps conversations: in the project they ran in, in a .braid
// folder that git never sees. A project is a git repository's main checkout,
// so its worktrees share one folder and deleting a worktree keeps its
// conversations; outside any repository, it is the folder a session started
// in. Every session of a conversation stays where the conversation started.
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { gitMaybe } from "./git.ts";
import { readEntry } from "./registry.ts";

export interface Repo {
  /** The project: a git repository's main checkout, or the folder a session started in. */
  top: string;
  /** braid's folder in it, `.braid`. */
  dir: string;
  /** Each session's records, `<id>.jsonl.gz`, and its state, `<id>.json`. */
  sessions: string;
  /** What the status line caches. */
  cache: string;
}

const real = (path: string) => (existsSync(path) ? realpathSync(path) : path);

/** The checkout a folder is in, or the folder itself outside any repository. */
export function checkoutOf(cwd: string): string {
  return real(gitMaybe(["rev-parse", "--show-toplevel"], { cwd })?.trim() || cwd);
}

/**
 * The project a folder is in: its git repository's main checkout, which holds
 * the .git that all its worktrees share; for worktrees of a bare repository,
 * the bare repository itself; outside any repository, the folder.
 */
export function projectOf(cwd: string): string {
  const top = gitMaybe(["rev-parse", "--show-toplevel"], { cwd })?.trim();
  if (!top) return real(cwd);
  const common = gitMaybe(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: top })?.trim();
  if (!common) return real(top);
  return real(basename(common) === ".git" ? dirname(common) : common);
}

/** braid's folder in a project. */
export function repoAt(project: string): Repo {
  const dir = join(project, ".braid");
  return { top: project, dir, sessions: join(dir, "sessions"), cache: join(dir, "cache") };
}

/** braid's folder for sessions started in `cwd`. */
export function locate(cwd: string): Repo {
  return repoAt(projectOf(cwd));
}

/** Where a session is kept: where it was first kept, as a fork is with the session it forks; else the project of `cwd`. */
export function repoFor(session: string | undefined, cwd: string): Repo {
  const known = session ? readEntry(session)?.project : undefined;
  return known && existsSync(join(known, ".braid")) ? repoAt(known) : locate(cwd);
}

/** Creates braid's folder, hidden from git by a .gitignore of its own, so no project's files change. */
export function ensureStore(repo: Repo): void {
  mkdirSync(repo.sessions, { recursive: true });
  const ignore = join(repo.dir, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "# braid: conversations stay out of git.\n*\n");
}

/** braid's per-user directory: ~/.config/braid. */
export function configDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "braid");
}
