// braid init: once per machine (the braid command, the status line, and the
// braid repository that keeps every conversation), and once per code
// repository whose sessions braid saves (its settings, rules and git hooks).
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installHooks, uninstallHooks } from "./githooks.ts";
import { configDir, ensureStore, expandPath, findRepo, homeFor, homeRepo, isRepo, readConfig, userConfig, type Repo } from "./repo.ts";

export { configDir };

/** Absolute path of the running CLI script. */
export function cliPath(): string {
  return resolve(process.argv[1] ?? fileURLToPath(import.meta.url));
}

/** Records where the CLI lives, so git hooks and the shim find it after plugin updates. */
export function writePointer(): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(join(configDir(), "cli"), cliPath());
}

function visibility(repo: Repo): string | undefined {
  const r = spawnSync("gh", ["repo", "view", "--json", "visibility", "-q", ".visibility"], { cwd: repo.top, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

const TEMPLATE = (s: Settings) =>
  [
    "# braid: efficient session manager. https://github.com/gbarbalinardo/braid",
    "# autopilot: braid works on this machine only. It keeps conversations in the braid",
    "#   repository, and never pushes, fetches or asks GitHub anything. false: git push can",
    "#   publish them to this repository's remote, for teammates and pull request reviews.",
    "# autofork: before a turn that changes a lot, braid marks a point to fork from",
    "#   (braid fork @N). false: no points.",
    '# repo: the braid repository conversations are kept in, apart from the code. "auto":',
    '#   ~/.braid. A path, such as "~/work-convos": that git repository instead.',
    "# git-hooks: commits name the agent session that made them (a Braid-Session trailer), so",
    "#   autocommit and autopush can follow them. false: braid leaves git alone.",
    "# autocommit: each commit the agent makes commits its conversation too. false: you commit",
    "#   it with /braid:commit, after /braid:edit.",
    "# autopush: git push publishes the committed part of the sessions behind the pushed",
    "#   commits. false: publish with /braid:push.",
    "# Your own ~/.config/braid/config.toml can set any of these over the repository's.",
    '# link = "store" names sessions inside the sessions only, without a Braid-Session trailer.',
    `autopilot = ${s.autopilot}`,
    `autofork = ${s.autofork}`,
    `repo = "${s.repo}"`,
    `git-hooks = ${s["git-hooks"]}`,
    `autocommit = ${s.autocommit}`,
    `autopush = ${s.autopush}`,
    'remote = "origin"',
    "",
  ].join("\n");

type Settings = { autopilot: boolean; autofork: boolean; repo: string; "git-hooks": boolean; autocommit: boolean; autopush: boolean };

/** A setting's value as written in a config file: booleans bare, strings quoted. */
const tomlValue = (value: string | boolean) => (typeof value === "boolean" ? String(value) : JSON.stringify(value));

const IGNORE_TEMPLATE = [
  "# braid: tool calls on these paths, and their results, are never published.",
  "# Same syntax as .gitignore. Commit this file so that it applies to everyone.",
  ".env",
  ".env.*",
  "!.env.example",
  "*.pem",
  "*.key",
  "",
].join("\n");

/**
 * `braid init`: the machine, then the repository `cwd` is in, if any. Outside
 * a repository, `repo` sets where all conversations are kept, in the user's config.
 */
export function init(cwd: string, opts: Partial<Settings> = {}): string[] {
  const notes = setup();
  const code = findRepo(cwd);
  if (code && !code.separate) {
    notes.push(...initRepo(code, opts));
  } else {
    // Outside a code repository, settings go to the user's own config, for every repository.
    for (const [key, value] of Object.entries(opts)) if (value !== undefined) notes.push(...setUserKey(key, value));
  }
  // The machine's braid repository, and the one this code repository's `repo` setting names, if another; read
  // again, as initRepo may just have set it. Each keeps its store where the sessions it is named for save.
  const named = code && !code.separate ? findRepo(code.top) : undefined;
  const homes = new Map<string, Repo | undefined>([[homeFor(undefined), undefined]]);
  if (named) homes.set(named.home, named);
  for (const [home, repo] of homes) {
    if (!isRepo(home)) notes.push(`created ${home}, the braid repository: every conversation is kept there, apart from the code`);
    const target = repo ?? homeRepo(home, true);
    if (!target) throw new Error(`${home} is set as the braid repository, and its own .braid/config.toml names another`);
    ensureStore(target);
  }
  return notes;
}

/** Writes `key = value` into ~/.config/braid/config.toml. */
function setUserKey(key: string, value: string | boolean): string[] {
  const file = join(configDir(), "config.toml");
  let text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const line = `${key} = ${tomlValue(value)}`;
  const re = new RegExp(`^${key}\\s*=.*$`, "m");
  // Top-level keys go before the first [section].
  if (re.test(text)) text = text.replace(re, line);
  else {
    const at = text.search(/^\s*\[/m);
    text = at < 0 ? `${text.trimEnd()}${text.trim() ? "\n" : ""}${line}\n` : `${text.slice(0, at)}${line}\n${text.slice(at)}`;
  }
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(file, text);
  const notes = [`set ${line} in ${file.replace(homedir(), "~")}`];
  if (key === "repo" && typeof value === "string" && value !== "auto") notes.push(`conversations are kept in ${homeRepo(expandPath(value, homedir()), true)!.top}`);
  return notes;
}

/** Once per code repository: `.braid/config.toml`, `.braidignore`, and the git hooks when git-hooks is on. */
function initRepo(repo: Repo, opts: Partial<Settings>): string[] {
  const notes: string[] = [];
  const file = join(repo.top, ".braid", "config.toml");
  const autopilot = opts.autopilot ?? (existsSync(file) ? readConfig(repo).autopilot : (userConfig().autopilot ?? true));
  // Leaving autopilot, git push publishes in private repositories and not in public ones, unless asked; on autopilot, GitHub is not asked.
  const pushDefault = (): [boolean, string] => {
    if (opts.autopush !== undefined) return [opts.autopush, "as asked"];
    const own = userConfig().autopush;
    if (own !== undefined) return [own, "your default in ~/.config/braid/config.toml"];
    if (autopilot) return [false, "autopilot"];
    const vis = visibility(repo);
    return [vis === "PRIVATE" || vis === "INTERNAL", vis ? `repository is ${vis.toLowerCase()}` : "visibility unknown"];
  };
  if (!existsSync(file)) {
    const [autopush, why] = pushDefault();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      TEMPLATE({ autopilot, autofork: opts.autofork ?? true, repo: opts.repo ?? "auto", "git-hooks": opts["git-hooks"] ?? true, autocommit: opts.autocommit ?? false, autopush }),
    );
    notes.push(
      autopilot
        ? "wrote .braid/config.toml (autopilot: conversations stay on this machine; braid init --no-autopilot lets git push publish them)"
        : `wrote .braid/config.toml (autocommit = ${opts.autocommit ?? false}, autopush = ${autopush}: ${why})`,
    );
    notes.push("commit it so teammates get braid too: git add .braid .braidignore && git commit -m 'Set up braid'");
  } else {
    let text = readFileSync(file, "utf8");
    const leaving = opts.autopilot === false && readConfig(repo).autopilot && opts.autopush === undefined;
    const given = { ...opts, ...(leaving ? { autopush: pushDefault()[0] } : {}) };
    const changes = Object.entries(given).filter(([, value]) => value !== undefined);
    for (const [key, value] of changes) {
      const line = `${key} = ${tomlValue(value!)}`;
      const re = new RegExp(`^${key}\\s*=.*$`, "m");
      text = re.test(text) ? text.replace(re, line) : `${text.trimEnd()}\n${line}\n`;
      notes.push(`set ${line} in .braid/config.toml`);
    }
    if (changes.length) writeFileSync(file, text);
  }
  const ignore = join(repo.top, ".braidignore");
  if (!existsSync(ignore)) {
    writeFileSync(ignore, IGNORE_TEMPLATE);
    notes.push("wrote .braidignore: tool calls on .env files and keys are never published; add your own paths");
  }
  const config = readConfig(repo);
  notes.push(...(config.gitHooks ? installHooks(repo) : uninstallHooks(repo)));
  if (config.repo) notes.push(`conversations here are kept in ${config.repo}, apart from the code`);
  return notes;
}

function settingsPath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json");
}

const SHIM = `#!/bin/sh
# braid: runs the braid CLI wherever the Claude Code plugin installed it.
cli="\${XDG_CONFIG_HOME:-$HOME/.config}/braid/cli"
[ -f "$cli" ] || { echo "braid: start a Claude Code session with the braid plugin once, then run /braid:init" >&2; exit 1; }
exec node "$(cat "$cli")" "$@"
`;

/** Per machine: a `braid` command on PATH, and braid's part in Claude Code's status line. `undo` restores the previous status line. */
export function setup(opts: { undo?: boolean } = {}): string[] {
  const notes: string[] = [];
  const settingsFile = settingsPath();
  const saved = join(configDir(), "statusline.json");
  const settings = existsSync(settingsFile) ? (JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, unknown>) : {};
  const current = settings.statusLine as { command?: string; refreshInterval?: number } | undefined;

  if (opts.undo) {
    const prev = existsSync(saved) ? (JSON.parse(readFileSync(saved, "utf8")) as { previous?: string; refreshInterval?: number }) : {};
    if (prev.previous) settings.statusLine = { type: "command", command: prev.previous, ...(prev.refreshInterval ? { refreshInterval: prev.refreshInterval } : {}) };
    else delete settings.statusLine;
    writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
    return [`restored the previous status line in ${settingsFile}`];
  }

  writePointer();
  const bin = join(homedir(), ".local", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "braid"), SHIM);
  chmodSync(join(bin, "braid"), 0o755);
  notes.push(`installed ${join(bin, "braid")}`);
  if (!(process.env.PATH ?? "").split(":").includes(bin)) notes.push(`add ${bin} to your PATH to run braid from a terminal`);

  const command = `${join(bin, "braid")} statusline`;
  if (current?.command !== command) {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(saved, JSON.stringify({ previous: current?.command ?? "", refreshInterval: current?.refreshInterval }, null, 2) + "\n");
    settings.statusLine = { type: "command", command, refreshInterval: 30 };
    mkdirSync(dirname(settingsFile), { recursive: true });
    writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
    notes.push(`status line set in ${settingsFile}${current?.command ? "; braid runs your previous one first" : ""}`);
  }
  return notes;
}
