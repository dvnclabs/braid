// braid init: once per machine, a `braid` command, braid's part of Claude
// Code's status line, and its hooks in Codex. Each project's .braid folder is
// made the first time a session there is saved.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gitMaybe } from "./git.ts";
import { configDir, ensureStore, locate } from "./repo.ts";
import { shellWord } from "./replay.ts";

export { configDir };

/** Absolute path of the running CLI script. */
export function cliPath(): string {
  return resolve(process.argv[1] ?? fileURLToPath(import.meta.url));
}

/** Records where the CLI lives, so the shim finds it after plugin updates. */
export function writePointer(): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(join(configDir(), "cli"), cliPath());
}

function settingsPath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json");
}

const SHIM = `#!/bin/sh
# braid: runs the braid CLI wherever the Claude Code plugin installed it, through the launcher next to it, which runs
# it with Node 22 or later, else bun.
cli="\${XDG_CONFIG_HOME:-$HOME/.config}/braid/cli"
[ -f "$cli" ] || { echo "braid: start a Claude Code session with the braid plugin once, then run /braid:init" >&2; exit 1; }
cli=$(cat "$cli")
launcher="$(dirname "$(dirname "$cli")")/bin/braid"
[ -f "$launcher" ] && exec sh "$launcher" "$@"
exec node "$cli" "$@"
`;

const codexHome = () => process.env.CODEX_HOME || join(homedir(), ".codex");

type HookGroup = { matcher?: string; hooks?: { type?: string; command?: string; timeout?: number }[] };

/** braid's own hook commands in Codex's hooks.json, by the command they run. */
const isBraidHook = (h: { command?: string }) => / hook (session-start|post-tool-use|stop|session-end) --agent codex$/.test(h.command ?? "");

/**
 * braid's hooks in Codex's hooks.json, when Codex is on this machine: Stop
 * saves each turn, PostToolUse a turn as it goes, SessionStart registers a
 * session and saves what crashed sessions left unsaved, SessionEnd saves the
 * rest and checks it (Codex gives it three seconds, so braid does that work after).
 * `undo` takes them out. Other hooks stay as they are.
 */
function codexHooks(bin: string, undo: boolean): string[] {
  const home = codexHome();
  if (!existsSync(home)) return [];
  const file = join(home, "hooks.json");
  let config: { hooks?: Record<string, HookGroup[]>; [k: string]: unknown } = {};
  if (existsSync(file)) {
    try {
      config = JSON.parse(readFileSync(file, "utf8")) as typeof config;
    } catch {
      return [`left ${file} alone: it is not valid JSON, so braid cannot add its hooks to it`];
    }
  }
  const hooks: Record<string, HookGroup[]> = { ...(config.hooks ?? {}) };
  for (const event of Object.keys(hooks)) {
    hooks[event] = (hooks[event] ?? []).map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isBraidHook(h)) })).filter((g) => (g.hooks ?? []).length > 0);
    if (hooks[event]!.length === 0) delete hooks[event];
  }
  if (!undo) {
    const command = (name: string) => `${shellWord(bin)} hook ${name} --agent codex`;
    const add = (event: string, name: string, timeout: number) => (hooks[event] = [...(hooks[event] ?? []), { hooks: [{ type: "command", command: command(name), timeout }] }]);
    add("SessionStart", "session-start", 15);
    add("PostToolUse", "post-tool-use", 10);
    add("Stop", "stop", 30);
    add("SessionEnd", "session-end", 3);
  }
  const text = JSON.stringify({ ...config, hooks }, null, 2) + "\n";
  if (existsSync(file) && readFileSync(file, "utf8") === text) return [];
  writeFileSync(file, text);
  return undo
    ? [`took braid's hooks out of ${file}`]
    : [`added braid's hooks to ${file}, so braid saves Codex sessions too: open /hooks in Codex once to trust them`];
}

/**
 * braid 0.1's git hooks in a repository, taken out, and the hooks they ran
 * first (kept as <hook>.local) put back. Hooks a hook manager runs, through
 * core.hooksPath, are left to it.
 */
export function removeOldGitHooks(cwd: string): string[] {
  const dir = gitMaybe(["rev-parse", "--path-format=absolute", "--git-path", "hooks"], { cwd })?.trim();
  if (!dir || !existsSync(dir)) return [];
  if (gitMaybe(["config", "core.hooksPath"], { cwd })?.trim()) return [];
  const notes: string[] = [];
  for (const hook of ["prepare-commit-msg", "post-commit", "post-rewrite", "pre-push"]) {
    const path = join(dir, hook);
    if (!existsSync(path) || !readFileSync(path, "utf8").includes("# braid hook")) continue;
    rmSync(path);
    if (existsSync(`${path}.local`)) renameSync(`${path}.local`, path);
    notes.push(`took braid 0.1's ${hook} hook out of ${dir}`);
  }
  return notes;
}

/** Whether a status line command is braid's own, wherever that braid is installed. */
export const isBraidLine = (command?: string): boolean => !!command && /(^|[/\s"'])braid(\.mjs)?["']? statusline\s*$/.test(command.trim());

/** Per machine: a `braid` command on PATH, braid's part in Claude Code's status line, and its hooks in Codex. `undo` restores the previous status line and takes the hooks out. */
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
    return [`restored the previous status line in ${settingsFile}`, ...codexHooks(join(homedir(), ".local", "bin", "braid"), true)];
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
    // Another braid's status line, from a copy set up under another home, is braid's own: what ran before it stays the previous one.
    if (!isBraidLine(current?.command)) writeFileSync(saved, JSON.stringify({ previous: current?.command ?? "", refreshInterval: current?.refreshInterval }, null, 2) + "\n");
    settings.statusLine = { type: "command", command, refreshInterval: 30 };
    mkdirSync(dirname(settingsFile), { recursive: true });
    writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
    notes.push(`status line set in ${settingsFile}${current?.command ? "; braid runs your previous one first" : ""}`);
  }
  notes.push(...codexHooks(join(bin, "braid"), false));
  return notes;
}

/** `braid init`: the machine, and the .braid folder of the project `cwd` is in. */
export function init(cwd: string): string[] {
  const notes = [...setup(), ...removeOldGitHooks(cwd)];
  const repo = locate(cwd);
  const made = !existsSync(repo.dir);
  ensureStore(repo);
  notes.push(`${made ? "made" : "found"} ${repo.dir}: this project's conversations, one file each, which git does not see`);
  return notes;
}
