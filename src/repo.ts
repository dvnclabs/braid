// Where braid keeps conversations: in the braid repository (~/.braid), apart
// from any code, each conversation under its own refs. A session that runs in
// a code repository takes its settings, rules and git hooks from it, and
// publishes to its remote; the conversation itself stays in the braid
// repository. The `repo` setting can name another braid repository. With
// autopilot (the default) braid works on this machine only: it never pushes,
// fetches or asks GitHub anything.
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { git, gitMaybe } from "./git.ts";

export interface Repo {
  /** Top of the code repository's working tree; for a session outside any, the braid repository's. */
  top: string;
  /** Its git directory, shared by all worktrees. */
  common: string;
  /** The braid repository, apart from the code: every conversation, each under its own refs. */
  home: string;
  /** braid's own directory in the braid repository: session state and locks. */
  dir: string;
  /** The unredacted session store, a bare repository in the braid repository. */
  store: string;
  /** What braid caches about the code repository: commit links, the status line, the last fetch. */
  cache: string;
  /** The session runs in no code repository: `top` is the braid repository itself. */
  separate?: boolean;
  /** A code repository braid keeps conversations for on autopilot, without `.braid/config.toml`. */
  auto?: boolean;
}

const real = (path: string) => (existsSync(path) ? realpathSync(path) : path);

/** The code repository `cwd` is in, with braid's storage in the braid repository; undefined outside any git repository. */
export function findRepo(cwd: string): Repo | undefined {
  const top = gitMaybe(["rev-parse", "--show-toplevel"], { cwd })?.trim();
  if (!top) return undefined;
  const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: top }).trim();
  const home = homeFor(top);
  const dir = join(home, ".git", "braid");
  const separate = real(home) === real(top);
  return { top, common, home, dir, store: join(dir, "store"), cache: join(dir, "cache", separate ? "home" : common.replace(/[^A-Za-z0-9]/g, "-")), ...(separate ? { separate } : {}) };
}

/** braid is on for a repository once `.braid/config.toml` is committed or created there, and always where it located one itself. */
export function isEnabled(repo: Repo): boolean {
  return !!repo.separate || !!repo.auto || hasConfig(repo);
}

const hasConfig = (repo: Pick<Repo, "top">) => existsSync(join(repo.top, ".braid", "config.toml"));

/** The braid repository where no other is set: ~/.braid. */
export function defaultHome(): string {
  return process.env.BRAID_HOME || join(homedir(), ".braid");
}

/** The braid repository for sessions in the code repository at `top`: the `repo` setting's, else the default. */
export function homeFor(top: string | undefined): string {
  return repoSetting(top) ?? defaultHome();
}

/** A path from a setting: ~ is the home directory, and a relative path starts from `base`. */
export function expandPath(path: string, base: string): string {
  if (path === "~" || path.startsWith("~/")) return join(homedir(), path.slice(1));
  return isAbsolute(path) ? path : resolve(base, path);
}

/**
 * A git repository made at `path`: its .git directory holds a HEAD. A .git
 * folder without one is none, such as one a cache or a lock made before the
 * braid repository was; making the repository there keeps what it holds.
 */
export const isRepo = (path: string): boolean => existsSync(join(path, ".git", "HEAD"));

/** The braid repository at `path`, created when `create` is set; undefined when there is none. */
export function homeRepo(path: string, create: boolean): Repo | undefined {
  if (!isRepo(path)) {
    if (!create) return undefined;
    mkdirSync(path, { recursive: true });
    git(["init", "--quiet", path]);
  }
  const repo = findRepo(path);
  return repo?.separate ? repo : undefined;
}

/**
 * Where the conversations of sessions in `cwd` are kept, with the code
 * repository they run in, or undefined when braid keeps none: in a repository
 * set up with braid, always; elsewhere once braid init created the braid
 * repository on this machine, for any code repository and outside one.
 */
export function locate(cwd: string): Repo | undefined {
  const code = findRepo(cwd);
  if (code && !code.separate && hasConfig(code)) return code;
  const home = code?.home ?? defaultHome();
  if (!isRepo(home)) return undefined;
  if (code && !code.separate) return { ...code, auto: true };
  return homeRepo(home, false);
}

/** The path the `repo` setting names, from the user's config or the code repository's, or undefined for "auto". */
export function repoSetting(top: string | undefined): string | undefined {
  const own = userConfig().repo;
  if (own !== undefined) return own === "auto" ? undefined : expandPath(own, homedir());
  const value = top ? readKeys({ top }).get("repo") : undefined;
  return value && value !== "auto" ? expandPath(value, top!) : undefined;
}

/** Creates the braid repository and its store, the first time a session is saved there. */
export function ensureStore(repo: Repo): void {
  if (existsSync(join(repo.store, "HEAD"))) return;
  if (!isRepo(repo.home)) homeRepo(repo.home, true);
  mkdirSync(repo.dir, { recursive: true });
  git(["init", "--quiet", "--bare", repo.store]);
}

export interface Config {
  /** braid works on this machine only: it never pushes, fetches or asks GitHub anything. On by default. */
  autopilot: boolean;
  /** Before a turn that changes a lot, braid marks a point to fork from. On by default. */
  autofork: boolean;
  /** The braid repository conversations are kept in, when the `repo` setting names one: undefined for ~/.braid. */
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
  /** "auto" (~/.braid), or the path of the braid repository every conversation is kept in. */
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
 *   repo = "~/convos"     # keep every conversation in this braid repository, instead of ~/.braid
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
  const autopush = flag("autopush");
  const repo = /^\s*repo\s*=\s*"([^"]+)"/m.exec(top)?.[1];
  return { repo, autopilot: flag("autopilot"), autofork: flag("autofork"), autocommit: flag("autocommit"), autopush, paths };
}

/** The `key = value` lines of a repository's `.braid/config.toml`, quotes and comments removed. */
function readKeys(repo: Pick<Repo, "top">): Map<string, string> {
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
 * Reads the few keys braid uses from the code repository's
 * `.braid/config.toml`, then the user's own settings. On autopilot, nothing
 * leaves the machine: no autopush, and no trailers.
 */
export function readConfig(repo: Repo): Config {
  const config: Config = { autopilot: true, autofork: true, gitHooks: true, autocommit: false, autopush: true, link: "trailer", remote: "origin" };
  const keys = repo.separate ? new Map<string, string>() : readKeys(repo);
  const flag = (key: string) => (keys.get(key) === "true" ? true : keys.get(key) === "false" ? false : undefined);
  // braid installs git hooks only where it was set up, never in a repository it found on autopilot.
  config.gitHooks = hasConfig(repo) ? (flag("git-hooks") ?? true) : false;
  config.autopilot = flag("autopilot") ?? config.autopilot;
  config.autofork = flag("autofork") ?? config.autofork;
  config.autocommit = flag("autocommit") ?? config.autocommit;
  config.autopush = flag("autopush") ?? config.autopush;
  const link = keys.get("link");
  if (link === "trailer" || link === "store") config.link = link;
  if (keys.get("remote")) config.remote = keys.get("remote")!;
  const own = userConfig();
  if (own.autopilot !== undefined) config.autopilot = own.autopilot;
  if (own.autofork !== undefined) config.autofork = own.autofork;
  if (own.autocommit !== undefined) config.autocommit = own.autocommit;
  if (own.autopush !== undefined) config.autopush = own.autopush;
  config.repo = repoSetting(repo.separate ? undefined : repo.top);
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
