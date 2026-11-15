// Test helpers: an isolated home, a bare remote, clones, and Claude Code transcripts.
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

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

/** A session's saved records, from the project's .braid folder: its own, or one subagent's. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function saved(project: string, session: string, agent?: string): any[] {
  const file = join(project, ".braid", "sessions", `${session}.jsonl.gz`);
  if (!existsSync(file)) return [];
  return gunzipSync(readFileSync(file))
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => (r.ext?.braid?.agent ?? undefined) === agent);
}

export function run(env: NodeJS.ProcessEnv, cwd: string, cmd: string, args: string[], input?: string) {
  const r = spawnSync(cmd, args, { cwd, env, input, encoding: "utf8" });
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

/** Clones the sandbox remote as a person with their own git identity. */
export function clone(s: Env, name: string, email: string): string {
  const dir = join(s.root, name);
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

  /** A line as Claude Code writes it outside the chain, such as a title. */
  raw(entry: object): void {
    appendFileSync(this.path, JSON.stringify(entry) + "\n");
  }

  /** A system line in the chain, such as the recap Claude Code writes when you come back. */
  system(subtype: string, content: string): string {
    this.n += 1;
    const uuid = `${this.session.slice(0, 8)}-0000-4000-8000-${String(this.n).padStart(12, "0")}`;
    const time = new Date(Date.UTC(2026, 10, 9, 10, 0, this.n)).toISOString();
    this.raw({ parentUuid: this.last, isSidechain: false, type: "system", subtype, content, isMeta: false, uuid, timestamp: time, cwd: "/work", sessionId: this.session, version: "2.1.222", userType: "external" });
    this.last = uuid;
    return uuid;
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

/** Writes a Codex rollout as Codex writes it (0.169): one {timestamp, type, payload} line per item or event, appending. */
export class Rollout {
  readonly path: string;
  readonly session: string;
  private n = 0;

  /** A rollout under `codexHome`, where Codex keeps it, started in `cwd`. */
  constructor(codexHome: string, session: string, cwd: string) {
    this.session = session;
    const dir = join(codexHome, "sessions", "2026", "11", "09");
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, `rollout-2026-11-09T10-00-00-${session}.jsonl`);
    writeFileSync(this.path, "");
    this.line("session_meta", { id: session, session_id: session, timestamp: "2026-11-09T10:00:00.000Z", cwd, originator: "codex_exec", cli_version: "0.169.0", source: "exec", model_provider: "openai" });
  }

  line(type: string, payload: object): void {
    this.n += 1;
    appendFileSync(this.path, JSON.stringify({ timestamp: new Date(Date.UTC(2026, 10, 9, 10, 0, this.n)).toISOString(), type, payload }) + "\n");
  }

  item(payload: object): void {
    this.line("response_item", payload);
  }

  /** What Codex writes when a turn starts: its instructions and the environment, the turn's settings, the prompt. */
  turn(prompt: string, cwd: string, context = true): void {
    this.line("event_msg", { type: "task_started", turn_id: `turn-${this.n}` });
    if (context) {
      this.item({ type: "message", role: "developer", content: [{ type: "input_text", text: "<permissions instructions>\nYou may write in the workspace.\n</permissions instructions>" }] });
      this.item({ type: "message", role: "user", content: [{ type: "input_text", text: `<environment_context>\n  <cwd>${cwd}</cwd>\n</environment_context>` }] });
      this.item({ type: "message", role: "user", content: [{ type: "input_text", text: `# AGENTS.md instructions for ${cwd}\n\n<INSTRUCTIONS>\nUse tabs.\n</INSTRUCTIONS>` }] });
    }
    this.line("turn_context", { turn_id: `turn-${this.n}`, cwd, model: "gpt-5.5", model_provider: "openai", effort: "medium" });
    this.user(prompt);
  }

  user(text: string): void {
    this.item({ type: "message", role: "user", content: [{ type: "input_text", text }] });
  }

  assistant(text: string): void {
    this.item({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
  }

  reasoning(summary: string): void {
    this.item({ type: "reasoning", summary: [{ type: "summary_text", text: summary }], content: null, encrypted_content: `gAAAA-${this.n}` });
  }

  call(name: string, args: object, id: string): void {
    this.item({ type: "function_call", name, arguments: JSON.stringify(args), call_id: id });
  }

  patch(input: string, id: string): void {
    this.item({ type: "custom_tool_call", name: "apply_patch", input, call_id: id });
  }

  output(id: string, output: string | object, custom = false): void {
    this.item({ type: custom ? "custom_tool_call_output" : "function_call_output", call_id: id, output });
  }

  end(): void {
    this.line("token_usage_record", { total_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } });
    this.line("event_msg", { type: "task_complete", turn_id: `turn-${this.n}` });
  }
}
