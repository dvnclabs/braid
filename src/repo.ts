// Where braid keeps things, for one repository.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
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
  /** Git hooks: commits name the agent session that made them, for autocommit and autopush. On by default. */
  gitHooks: boolean;
  /** Each code commit the agent makes commits its conversation too. Off by default: commit it after braid review. */
  autocommit: boolean;
  /** git push publishes the committed part of the sessions behind the pushed commits. On by default. */
  autopush: boolean;
  /** How commits name their sessions: a Braid-Session trailer, or only the labels inside the sessions. */
  link: "trailer" | "store";
  remote: string;
}

/** braid's per-user directory: ~/.config/braid. */
export function configDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "braid");
}

export interface UserConfig {
  autocommit?: boolean;
  autopush?: boolean;
  paths: [string, string][];
}

/**
 * The user's own settings, from ~/.config/braid/config.toml. autocommit and
 * autopush here win over the repository's. [paths] maps path prefixes for
 * forking a session from another machine:
 *
 *   autopush = false
 *   [paths]
 *   "/Users/alice/dev" = "/home/alice/dev"
 */
export function userConfig(): UserConfig {
  const path = join(configDir(), "config.toml");
  if (!existsSync(path)) return { paths: [] };
  const text = readFileSync(path, "utf8");
  const top = text.split(/^\s*\[/m)[0] ?? "";
  const flag = (key: string) => {
    const v = new RegExp(`^\\s*${key}\\s*=\\s*(true|false)\\b`, "m").exec(top)?.[1];
    return v === undefined ? undefined : v === "true";
  };
  const section = /^\s*\[paths\]\s*$([\s\S]*?)(?=^\s*\[|$(?![\s\S]))/m.exec(text)?.[1] ?? "";
  const paths = [...section.matchAll(/^\s*"([^"]+)"\s*=\s*"([^"]+)"/gm)].map((m) => [m[1]!, m[2]!] as [string, string]);
  return { autocommit: flag("autocommit"), autopush: flag("autopush"), paths };
}

/** Reads the few keys braid uses from `.braid/config.toml`, a flat `key = "value"` file, then the user's own settings. */
export function readConfig(repo: Repo): Config {
  const config: Config = { gitHooks: true, autocommit: false, autopush: true, link: "trailer", remote: "origin" };
  const path = join(repo.top, ".braid", "config.toml");
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = /^\s*([a-z_-]+)\s*=\s*"?([^"#\n]*?)"?\s*(#.*)?$/.exec(line);
      if (!m) continue;
      const [, key, value] = m;
      const flag = value === "true" ? true : value === "false" ? false : undefined;
      if (key === "git-hooks" && flag !== undefined) config.gitHooks = flag;
      if (key === "autocommit" && flag !== undefined) config.autocommit = flag;
      if (key === "autopush" && flag !== undefined) config.autopush = flag;
      if (key === "link" && (value === "trailer" || value === "store")) config.link = value;
      if (key === "remote" && value) config.remote = value;
    }
  }
  const own = userConfig();
  if (own.autocommit !== undefined) config.autocommit = own.autocommit;
  if (own.autopush !== undefined) config.autopush = own.autopush;
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
