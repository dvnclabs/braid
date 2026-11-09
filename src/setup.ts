// Setup: `braid init` once per repository, `braid setup` once per machine.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installHooks } from "./githooks.ts";
import { ensureStore, type Repo } from "./repo.ts";

export function configDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "braid");
}

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

export function init(repo: Repo): string[] {
  const notes: string[] = [];
  const file = join(repo.top, ".braid", "config.toml");
  if (!existsSync(file)) {
    const vis = visibility(repo);
    const publish = vis === "PRIVATE" || vis === "INTERNAL" ? "on-push" : "off";
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      [
        "# braid: https://github.com/gbarbalinardo/braid",
        '# publish = "on-push" publishes the sessions behind your commits when you git push.',
        '# publish = "off" keeps every session on this machine.',
        `publish = "${publish}"`,
        'remote = "origin"',
        "",
      ].join("\n"),
    );
    notes.push(`wrote .braid/config.toml (publish = "${publish}"${vis ? `, repository is ${vis.toLowerCase()}` : ", visibility unknown"})`);
    notes.push("commit it so teammates get braid too: git add .braid && git commit -m 'Set up braid'");
  }
  ensureStore(repo);
  notes.push(...installHooks(repo));
  writePointer();
  return notes;
}

function settingsPath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json");
}

const SHIM = `#!/bin/sh
# braid: runs the braid CLI wherever the Claude Code plugin installed it.
cli="\${XDG_CONFIG_HOME:-$HOME/.config}/braid/cli"
[ -f "$cli" ] || { echo "braid: start a Claude Code session with the braid plugin once, or run braid setup" >&2; exit 1; }
exec node "$(cat "$cli")" "$@"
`;

/** Per machine: a `braid` command on PATH, and braid's part in Claude Code's status line. */
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
