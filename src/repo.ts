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
  /** Git hooks: the agent's commits name its session, and git push publishes those sessions. On by default. */
  gitHooks: boolean;
  /** How commits name their sessions: a Braid-Session trailer, or only the commit labels inside the sessions. */
  link: "trailer" | "store";
  /** "on-push" publishes sessions with git push and braid push; "off" never publishes. */
  publish: "on-push" | "off";
  /** Where publish = "off" came from, when it came from the user's own config. */
  publishSource?: string;
  remote: string;
}

/** braid's per-user directory: ~/.config/braid. */
export function configDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "braid");
}

/**
 * The user's own defaults, from ~/.config/braid/config.toml: whether to
 * publish at all, and path prefixes to rewrite when replaying a session from
 * another machine, under [paths]:
 *
 *   publish = "off"
 *   [paths]
 *   "/Users/alice/dev" = "/home/alice/dev"
 */
export function userConfig(): { publish?: "on-push" | "off"; paths: [string, string][] } {
  const path = join(configDir(), "config.toml");
  if (!existsSync(path)) return { paths: [] };
  const text = readFileSync(path, "utf8");
  const top = text.split(/^\s*\[/m)[0] ?? "";
  const publish = /^\s*publish\s*=\s*"(on-push|off)"/m.exec(top)?.[1] as "on-push" | "off" | undefined;
  const section = /^\s*\[paths\]\s*$([\s\S]*?)(?=^\s*\[|$(?![\s\S]))/m.exec(text)?.[1] ?? "";
  const paths = [...section.matchAll(/^\s*"([^"]+)"\s*=\s*"([^"]+)"/gm)].map((m) => [m[1]!, m[2]!] as [string, string]);
  return { publish, paths };
}

/** Reads the few keys braid uses from `.braid/config.toml`, a flat `key = "value"` file. */
export function readConfig(repo: Repo): Config {
  const config: Config = { gitHooks: true, link: "trailer", publish: "off", remote: "origin" };
  const path = join(repo.top, ".braid", "config.toml");
  if (!existsSync(path)) return config;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([a-z_-]+)\s*=\s*"?([^"#\n]*?)"?\s*(#.*)?$/.exec(line);
    if (!m) continue;
    const [, key, value] = m;
    if (key === "git-hooks" && (value === "true" || value === "false")) config.gitHooks = value === "true";
    if (key === "publish" && (value === "on-push" || value === "off")) config.publish = value;
    if (key === "link" && (value === "trailer" || value === "store")) config.link = value;
    if (key === "remote" && value) config.remote = value;
  }
  // You can always keep your own sessions from being published.
  if (userConfig().publish === "off") Object.assign(config, { publish: "off", publishSource: "~/.config/braid/config.toml" });
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
