// Where braid keeps conversations: in the git repository the session runs in,
// inside its .git, or outside one in ~/.braid, a git repository of its own.
// The `repo` setting can name another path, a repository apart from the code.
// With autopilot (the default) braid works on this machine only: it never
// pushes, fetches or asks GitHub anything.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
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
  /** A git repository that holds conversations only, apart from the code. */
  separate?: boolean;
  /** For a separate repository: the code repository the command or session runs in, if any. */
  code?: string;
  /** A repository braid keeps conversations in on autopilot, without `.braid/config.toml`. */
  auto?: boolean;
}

export function findRepo(cwd: string): Repo | undefined {
  const top = gitMaybe(["rev-parse", "--show-toplevel"], { cwd })?.trim();
  if (!top) return undefined;
  const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: top }).trim();
  const dir = join(common, "braid");
  return { top, common, dir, store: join(dir, "store") };
}

/** braid is on for a repository once `.braid/config.toml` is committed or created there, and always where it located one itself. */
export function isEnabled(repo: Repo): boolean {
  return !!repo.separate || !!repo.auto || hasConfig(repo);
}

const hasConfig = (repo: Repo) => existsSync(join(repo.top, ".braid", "config.toml"));

/** The separate repository braid uses where no other is set: ~/.braid. */
export function defaultSeparate(): string {
  return process.env.BRAID_HOME || join(homedir(), ".braid");
}

/** A path from a setting: ~ is the home directory, and a relative path starts from `base`. */
export function expandPath(path: string, base: string): string {
  if (path === "~" || path.startsWith("~/")) return join(homedir(), path.slice(1));
  return isAbsolute(path) ? path : resolve(base, path);
}

/** A separate repository at `path`, created when `create` is set; undefined when there is none. */
export function separateRepo(path: string, code: string | undefined, create: boolean): Repo | undefined {
  if (!existsSync(join(path, ".git"))) {
    if (!create) return undefined;
    mkdirSync(path, { recursive: true });
    git(["init", "--quiet", path]);
  }
  const repo = findRepo(path);
  if (!repo) return undefined;
  return { ...repo, separate: true, code: code && code !== repo.top ? code : undefined };
}

/**
 * Where the conversations of sessions in `cwd` are kept, or undefined when
 * braid keeps none there: a repository set up with braid; with autopilot, any
 * git repository, inside its .git; else ~/.braid. braid init turns this on for
 * the machine, by creating ~/.braid.
 */
export function locate(cwd: string): Repo | undefined {
  const code = findRepo(cwd);
  const enabled = code && hasConfig(code) ? code : undefined;
  const setting = repoSetting(enabled);
  if (setting) return separateRepo(setting, code?.top, true);
  if (enabled) return enabled;
  const home = separateRepo(defaultSeparate(), code?.top, false);
  if (home && code && !home.code) return home; // inside ~/.braid itself
  if (home && code && readConfig(code).autopilot) return { ...code, auto: true };
  return home;
}

/** The path the `repo` setting names, from the user's config or the repository's, or undefined for "auto". */
export function repoSetting(code: Repo | undefined): string | undefined {
  const own = userConfig().repo;
  if (own !== undefined) return own === "auto" ? undefined : expandPath(own, homedir());
  const value = code ? readKeys(code).get("repo") : undefined;
  return value && value !== "auto" ? expandPath(value, code!.top) : undefined;
}

export function ensureStore(repo: Repo): void {
  if (existsSync(join(repo.store, "HEAD"))) return;
  mkdirSync(repo.dir, { recursive: true });
  git(["init", "--quiet", "--bare", repo.store]);
}

export interface Config {
  /** braid works on this machine only: it never pushes, fetches or asks GitHub anything. On by default. */
  autopilot: boolean;
  /** Before a turn that changes a lot, braid marks a point to fork from. On by default. */
  autofork: boolean;
  /** Where conversations are kept: undefined for the repository itself, or the path of a separate repository. */
  repo?: string;
  /** Git hooks: commits name the agent session that made them, for autocommit and autopush. On by default. */
  gitHooks: boolean;
  /** Each code commit the agent makes commits its conversation too. Off by default: commit it after braid edit. */
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
  /** "auto", or a path: then every conversation is kept in that separate repository. */
  repo?: string;
  autopilot?: boolean;
  autofork?: boolean;
  autocommit?: boolean;
  autopush?: boolean;
  paths: [string, string][];
}

/**
 * The user's own settings, from ~/.config/braid/config.toml. autocommit and
 * autopush here win over the repository's. [paths] maps path prefixes for
 * forking a session from another machine:
 *
 *   autopilot = false     # let braid push and fetch conversations
 *   autopush = false
 *   repo = "~/.braid"     # keep every conversation in this repository, apart from the code
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
  // publish = "off", from before autopush, still keeps git push from publishing.
  const autopush = flag("autopush") ?? (/^\s*publish\s*=\s*"off"/m.test(top) ? false : undefined);
  const repo = /^\s*repo\s*=\s*"([^"]+)"/m.exec(top)?.[1];
  return { repo, autopilot: flag("autopilot"), autofork: flag("autofork"), autocommit: flag("autocommit"), autopush, paths };
}

/** The `key = value` lines of a repository's `.braid/config.toml`, quotes and comments removed. */
function readKeys(repo: Repo): Map<string, string> {
  const keys = new Map<string, string>();
  const path = join(repo.top, ".braid", "config.toml");
  if (!existsSync(path)) return keys;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([a-z_-]+)\s*=\s*"?([^"#\n]*?)"?\s*(#.*)?$/.exec(line);
    if (m) keys.set(m[1]!, m[2]!);
  }
  return keys;
}

/**
 * Reads the few keys braid uses from `.braid/config.toml`, then the user's own
 * settings. A separate repository has no git hooks, autocommit or autopush;
 * on autopilot, nothing leaves the machine: no autopush, and no trailers.
 */
export function readConfig(repo: Repo): Config {
  const config: Config = { autopilot: true, autofork: true, gitHooks: true, autocommit: false, autopush: true, link: "trailer", remote: "origin" };
  // A separate repository follows the autopilot and autofork of the code repository it serves, if any.
  const fromCode = repo.code ? readKeys({ top: repo.code } as Repo) : new Map<string, string>();
  const keys = repo.separate ? new Map([...fromCode].filter(([k]) => k === "autopilot" || k === "autofork")) : readKeys(repo);
  const flag = (key: string) => (keys.get(key) === "true" ? true : keys.get(key) === "false" ? false : undefined);
  // braid installs git hooks only where it was set up, never in a repository it found on autopilot.
  config.gitHooks = hasConfig(repo) ? (flag("git-hooks") ?? true) : false;
  config.autopilot = flag("autopilot") ?? config.autopilot;
  config.autofork = flag("autofork") ?? config.autofork;
  config.autocommit = flag("autocommit") ?? config.autocommit;
  // A config written before autopush, with publish = "off" (public repositories), keeps git push from publishing.
  config.autopush = flag("autopush") ?? (keys.get("publish") === "off" ? false : config.autopush);
  const link = keys.get("link");
  if (link === "trailer" || link === "store") config.link = link;
  if (keys.get("remote")) config.remote = keys.get("remote")!;
  const own = userConfig();
  if (own.autopilot !== undefined) config.autopilot = own.autopilot;
  if (own.autofork !== undefined) config.autofork = own.autofork;
  if (own.autocommit !== undefined) config.autocommit = own.autocommit;
  if (own.autopush !== undefined) config.autopush = own.autopush;
  config.repo = repo.separate ? repo.top : repoSetting(repo);
  if (config.repo) [config.gitHooks, config.autocommit, config.autopush] = [false, false, false];
  if (config.autopilot) [config.autopush, config.link] = [false, "store"];
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
