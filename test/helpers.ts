// Test helpers: an isolated home, a bare remote, clones, and Claude Code transcripts.
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve(import.meta.dirname, "..", "src", "cli.ts");

export interface Env {
  root: string;
  env: NodeJS.ProcessEnv;
}

/** A temp root with its own HOME, a `braid` command on PATH, and a bare remote. */
export function sandbox(): Env {
  const root = mkdtempSync(join(tmpdir(), "braid-test-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  writeFileSync(join(bin, "braid"), `#!/bin/sh\nexec node "${CLI}" "$@"\n`);
  chmodSync(join(bin, "braid"), 0o755);
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    BRAID_STATUS_NO_PR: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  run(env, root, "git", ["init", "--quiet", "--bare", "--initial-branch=main", "remote.git"]);
  return { root, env };
}

// Clones on another machine, and the braid repository there.
const people = new Map<string, string>();

/** The braid repository of whoever works in `dir`: on another machine, theirs there; else the sandbox's ~/.braid. */
export function braidHome(env: NodeJS.ProcessEnv, dir: string): string {
  for (const [clone, home] of people) if (dir === clone || dir.startsWith(`${clone}/`)) return home;
  return join(env.HOME!, ".braid");
}

/** The store in the braid repository of whoever works in `dir`. */
export function storeOf(env: NodeJS.ProcessEnv, dir: string): string {
  return join(braidHome(env, dir), ".git", "braid", "store");
}

export function run(env: NodeJS.ProcessEnv, cwd: string, cmd: string, args: string[], input?: string) {
  const home = [...people].find(([clone]) => cwd === clone || cwd.startsWith(`${clone}/`))?.[1];
  const r = spawnSync(cmd, args, { cwd, env: home && !env.BRAID_HOME ? { ...env, BRAID_HOME: home } : env, input, encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function must(env: NodeJS.ProcessEnv, cwd: string, cmd: string, args: string[], input?: string): string {
  const r = run(env, cwd, cmd, args, input);
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr}${r.stdout}`);
  return r.stdout;
}

export function braid(env: NodeJS.ProcessEnv, cwd: string, args: string[], input?: string, extra: NodeJS.ProcessEnv = {}) {
  return run({ ...env, ...extra }, cwd, "braid", args, input);
}

/**
 * Clones the sandbox remote as a person with their own git identity. Someone
 * on another `machine` has their own braid repository there.
 */
export function clone(s: Env, name: string, email: string, machine?: string): string {
  const dir = join(s.root, name);
  if (machine) people.set(dir, join(s.root, "machines", machine, ".braid"));
  must(s.env, s.root, "git", ["clone", "--quiet", join(s.root, "remote.git"), dir]);
  must(s.env, dir, "git", ["config", "user.name", name]);
  must(s.env, dir, "git", ["config", "user.email", email]);
  must(s.env, dir, "git", ["config", "init.defaultBranch", "main"]);
  return dir;
}

/** Writes Claude Code transcript entries, appending to the file. */
export class Transcript {
  readonly path: string;
  readonly session: string;
  private last: string | null = null;
  private n = 0;

  constructor(dir: string, session: string) {
    this.session = session;
    this.path = join(dir, `${session}.jsonl`);
    writeFileSync(this.path, "");
  }

  add(type: "user" | "assistant", message: object, extra: object = {}): string {
    this.n += 1;
    const uuid = `${this.session.slice(0, 8)}-0000-4000-8000-${String(this.n).padStart(12, "0")}`;
    const entry = {
      parentUuid: this.last,
      isSidechain: false,
      type,
      message,
      uuid,
      timestamp: new Date(Date.UTC(2026, 10, 9, 10, 0, this.n)).toISOString(),
      cwd: "/work",
      sessionId: this.session,
      version: "2.1.222",
      userType: "external",
      ...extra,
    };
    appendFileSync(this.path, JSON.stringify(entry) + "\n");
    this.last = uuid;
    return uuid;
  }

  /** A copy under a new session id with the same record uuids, as Claude Code's /branch and --fork-session write it. */
  fork(dir: string, session: string): Transcript {
    const t = new Transcript(dir, session);
    const lines = readFileSync(this.path, "utf8").split("\n").filter(Boolean);
    writeFileSync(t.path, lines.map((l) => JSON.stringify({ ...JSON.parse(l), sessionId: session }) + "\n").join(""));
    t.last = this.last;
    t.n = this.n;
    return t;
  }

  /** An assistant turn that calls a tool, and the tool's result. */
  toolCall(name: string, input: object, id: string, result: string): string {
    this.add("assistant", {
      id: `msg_${this.n}`,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5-5",
      content: [{ type: "tool_use", id, name, input }],
      stop_reason: "tool_use",
    });
    return this.add("user", { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: result }] });
  }

  user(text: string): string {
    return this.add("user", { role: "user", content: text });
  }

  assistant(text: string): string {
    return this.add("assistant", {
      id: `msg_${this.n}`,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5-5",
      content: [
        { type: "thinking", thinking: "private reasoning", signature: "sig" },
        { type: "text", text },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  }
}
