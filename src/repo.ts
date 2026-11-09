// Where braid keeps things, for one repository.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { git, gitMaybe } from "./git.ts";

export interface Repo {
  /** Top of the working tree. */
  top: string;
  /** The git directory shared by all worktrees. */
  common: string;
  /** braid's own directory: <common>/braid. */
  dir: string;
  /** The unredacted session store, a separate bare repository. */
  store: string;
}

export function findRepo(cwd: string): Repo | undefined {
  const top = gitMaybe(["rev-parse", "--show-toplevel"], { cwd })?.trim();
  if (!top) return undefined;
  const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: top }).trim();
  const dir = join(common, "braid");
  return { top, common, dir, store: join(dir, "store") };
}

/** braid is on for a repository once `.braid/config.toml` is committed or created there. */
export function isEnabled(repo: Repo): boolean {
  return existsSync(join(repo.top, ".braid", "config.toml"));
}

export function ensureStore(repo: Repo): void {
  if (existsSync(join(repo.store, "HEAD"))) return;
  mkdirSync(repo.dir, { recursive: true });
  git(["init", "--quiet", "--bare", repo.store]);
}

export interface Config {
  /** "on-push" publishes sessions with git push; "off" never publishes. */
  publish: "on-push" | "off";
  remote: string;
}

/** Reads the few keys braid uses from `.braid/config.toml`, a flat `key = "value"` file. */
export function readConfig(repo: Repo): Config {
  const config: Config = { publish: "off", remote: "origin" };
  const path = join(repo.top, ".braid", "config.toml");
  if (!existsSync(path)) return config;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([a-z_]+)\s*=\s*"?([^"#\n]*?)"?\s*(#.*)?$/.exec(line);
    if (!m) continue;
    const [, key, value] = m;
    if (key === "publish" && (value === "on-push" || value === "off")) config.publish = value;
    if (key === "remote" && value) config.remote = value;
  }
  return config;
}

export const SESSION_REFS = "refs/sessions";
export const PUBLISHED_REFS = "refs/braid/sessions";

export function remoteRefs(remote: string): string {
  return `refs/braid/remotes/${remote}/sessions`;
}

/** Ref of a session in the store. */
export function storeRef(conv: string, session: string): string {
  return `${SESSION_REFS}/${conv}/${session}`;
}
