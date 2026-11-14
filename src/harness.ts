// The agents a session can continue in. A session is braid's own: its records,
// in ATXF, are the same whichever agent wrote them, and braid writes them out
// for any of these agents, as a new session of theirs that continues it.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { codex } from "@leostera/atxf/codex";
import { asCodexShowed, forModel, type Rec } from "./records.ts";
import { forkText, keptUuids, linear, ownLine, rewrite, shellWord, type ForkRecords, type Line } from "./replay.ts";

export interface Written {
  /** The new session's id, as the agent knows it. */
  session: string;
  file: string;
  /** Lines written. */
  lines: number;
}

export interface Harness {
  /** As ATXF names the agent. */
  agent: "claude-code" | "codex";
  /** As people name it. */
  title: string;
  /** The model provider this agent talks to: reasoning only its models wrote goes back to it. */
  provider: string;
  /** Writes a fork as session `session` of this agent's, in `cwd`, with paths moved by `pairs`. */
  write(fork: ForkRecords, all: Map<string, Rec>, cwd: string, pairs: [string, string][], session: string): Written;
  /** The file of session `session`, when this agent already has it where it would resume it from `cwd`. */
  existing(session: string, cwd: string): string | undefined;
  /** The command that continues a session written here, in a terminal. */
  resume(dir: string, session: string): string;
}

type Attachment = { type?: string; prompt?: unknown; commandMode?: string; origin?: { kind?: string } };

/**
 * Claude Code's records as its model read them, for another agent. Claude Code
 * attaches a message typed while the agent worked to the turn: the user's own
 * is the user's message, and one from another session a note. A message in
 * the user's place that the user did not write, such as a notice that a
 * background task finished, is a note too; older versions also wrote those
 * notices as typed messages, which stay behind.
 */
function asClaudeCodeShowed(records: Rec[]): Rec[] {
  return records.map((r) => {
    const line = ownLine(r);
    const origin = (line?.origin as { kind?: string } | undefined)?.kind;
    if (r.type === "message" && r.role === "user" && origin && origin !== "human") return { ...r, display: false };
    const a = line?.attachment as Attachment | undefined;
    if (r.type !== "custom" || a?.type !== "queued_command" || a.commandMode !== "prompt" || typeof a.prompt !== "string") return r;
    if (a.prompt.trimStart().startsWith("<task-notification>")) return r;
    const own = !a.origin || a.origin.kind === "human";
    return { type: "message", id: r.id, parentId: r.parentId, time: r.time, role: "user", content: a.prompt, ...(own ? {} : { display: false }) };
  });
}

const responseOf = (r: Rec): string | undefined => (r.type === "message" && r.role === "assistant" && typeof r.responseId === "string" ? r.responseId : undefined);

/**
 * Each response whole before what came back while it was written: a model API
 * takes a batch of parallel calls as the calls, then their results, and Claude
 * Code writes a result that came back early between two calls of the batch.
 */
function batched(records: Rec[]): Rec[] {
  const last = new Map<string, number>();
  records.forEach((r, i) => {
    const id = responseOf(r);
    if (id) last.set(id, i);
  });
  const out: Rec[] = [];
  let held: Rec[] = [];
  let until = -1;
  records.forEach((r, i) => {
    const id = responseOf(r);
    if (id) {
      out.push(r);
      until = Math.max(until, last.get(id)!);
    } else if (i < until) held.push(r);
    else out.push(r);
    if (i >= until && held.length) {
      out.push(...held);
      held = [];
    }
  });
  return [...out, ...held];
}

/**
 * What came back after a response, its results before the notes on them, as
 * a model API takes them and Claude Code sends them: a note hangs from its
 * result, and with several results it would otherwise come between two.
 */
function resultsFirst(records: Rec[]): Rec[] {
  const isResult = (r: Rec) => r.role === "tool";
  const isNote = (r: Rec) => r.type === "custom" || (r.type === "message" && r.role === "user" && r.display === false);
  const out: Rec[] = [];
  let run: Rec[] = [];
  const flush = () => {
    out.push(...run.filter(isResult), ...run.filter((r) => !isResult(r)));
    run = [];
  };
  for (const r of records) {
    if (isResult(r) || (run.length && isNote(r))) run.push(r);
    else {
      flush();
      out.push(r);
    }
  }
  flush();
  return out;
}

/** A failed tool call's result as its text: Codex keeps a result as text, which says how the call failed. */
const asText = (r: Rec): Rec => (r.role === "tool" && r.isError ? { ...r, isError: undefined } : r);

const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
/** Where Claude Code keeps session `session` of a directory, and finds it to resume it there. */
const claudeFile = (session: string, cwd: string) => join(claudeHome(), "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${session}.jsonl`);
const codexHome = () => process.env.CODEX_HOME || join(homedir(), ".codex");
const pad = (n: number) => String(n).padStart(2, "0");

export const CLAUDE_CODE: Harness = {
  agent: "claude-code",
  title: "Claude Code",
  provider: "anthropic",
  write(fork, _all, cwd, pairs, session) {
    const text = forkText(fork, session, cwd, pairs);
    const file = claudeFile(session, cwd);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    return { session, file, lines: text.split("\n").filter(Boolean).length };
  },
  existing: (session, cwd) => (existsSync(claudeFile(session, cwd)) ? claudeFile(session, cwd) : undefined),
  resume: (dir, session) => `cd ${shellWord(dir)} && claude --resume ${session}`,
};

/**
 * Codex keeps each session as a rollout, `sessions/YYYY/MM/DD/rollout-<local
 * time>-<id>.jsonl` under CODEX_HOME, and resumes one by its id. A rollout is
 * one line of history: the fork's context path as the model read it, with what
 * a compaction kept after its summary, as Claude Code puts it back, and each
 * batch of parallel calls before its results, and the results before the
 * notes on them. Codex adds its own instructions and environment when it
 * resumes, so those of a Codex session stay behind.
 */
/**
 * A result goes back to Codex as the output of the kind of call it answers:
 * the converter writes every result as a function call's output, and a custom
 * tool's call (apply_patch) takes a custom tool call's output.
 */
function outputsAnswerCalls(text: string): string {
  const custom = new Set<string>();
  return text
    .split("\n")
    .map((l) => {
      if (!l) return l;
      const line = JSON.parse(l) as { type?: string; payload?: { type?: string; call_id?: string } };
      const p = line.payload;
      if (line.type !== "response_item" || !p?.call_id) return l;
      if (p.type === "custom_tool_call") custom.add(p.call_id);
      if (p.type !== "function_call_output" || !custom.has(p.call_id)) return l;
      return JSON.stringify({ ...line, payload: { ...p, type: "custom_tool_call_output" } });
    })
    .join("\n");
}

/** The Codex line a record was read from, as braid keeps it. */
export function codexLineOf(r: Rec): Line | undefined {
  const n = r.native as { source?: string; records?: unknown[] } | undefined;
  const line = n?.source === "codex" && n.records?.length === 1 ? n.records[0] : undefined;
  return line && typeof line === "object" ? (line as Line) : undefined;
}

/** Records of other agents as Codex lines: the conversation as their model read it, converted by ATXF. The first line is a session_meta. */
function converted(records: Rec[], cwd: string, pairs: [string, string][], session: string, now: Date): Line[] {
  const prepared = linear(resultsFirst(batched(forModel(rewrite(asCodexShowed(asClaudeCodeShowed(records), "codex"), pairs), CODEX.provider).map(asText))));
  const header = { type: "transcript", atxf: "0.1", id: session, time: now.toISOString(), source: { agent: "braid", sessionId: session }, workspace: { cwd } };
  return codex
    .fromAtxf({ header, records: prepared } as never, { carry: false })
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Line);
}

/**
 * A fork as a Codex rollout of session `session`, written at `now`. Each line
 * Codex wrote goes out as it wrote it, its bookkeeping too (turn settings,
 * token counts, events, what it knew of the environment), so Codex resumes the
 * fork as it resumes the rollout itself: the lines on the context path, and
 * those it wrote after the fork's head. Records of other agents between them
 * are converted. The session_meta line is the newest session's, under the new
 * id, time and directory.
 */
export function codexText(fork: ForkRecords, all: Map<string, Rec>, cwd: string, pairs: [string, string][], session: string, now: Date): string {
  const kept = fork.path[0] ? keptUuids(ownLine(fork.path[0])).flatMap((u) => (all.has(u) ? [all.get(u)!] : [])) : [];
  const path = kept.length ? [...fork.path.slice(0, 2), ...kept, ...fork.path.slice(2)] : fork.path;
  const onPath = new Set(path.map((r) => r.id));
  const sequence = [...path, ...fork.records.filter((r) => codexLineOf(r) && !onPath.has(r.id))];
  if (!sequence.some((r) => codexLineOf(r))) return outputsAnswerCalls(converted(path, cwd, pairs, session, now).map((l) => JSON.stringify(l)).join("\n") + "\n");
  const out: Line[] = [];
  let meta: Line | undefined;
  let made: Line | undefined;
  let run: Rec[] = [];
  const flush = () => {
    if (!run.length) return;
    const [first, ...lines] = converted(run, cwd, pairs, session, now);
    made ??= first;
    out.push(...lines);
    run = [];
  };
  for (const r of sequence) {
    const line = codexLineOf(r);
    if (!line) run.push(r);
    else if (line.type === "session_meta") meta = line;
    else {
      flush();
      out.push(rewrite(line, pairs));
    }
  }
  flush();
  const stamp = now.toISOString();
  const payload = meta ? { ...rewrite(meta.payload as Line, pairs), id: session, ...((meta.payload as Line).session_id ? { session_id: session } : {}), timestamp: stamp, cwd } : undefined;
  const head = meta ? { ...meta, timestamp: stamp, payload } : (made ?? { timestamp: stamp, type: "session_meta", payload: { id: session, timestamp: stamp, cwd, originator: "atxf", cli_version: "0.0.0", source: "cli" } });
  return outputsAnswerCalls([head, ...out].map((l) => JSON.stringify(l)).join("\n") + "\n");
}

export const CODEX: Harness = {
  agent: "codex",
  title: "Codex",
  provider: "openai",
  write(fork, all, cwd, pairs, session) {
    const now = new Date();
    const text = codexText(fork, all, cwd, pairs, session, now);
    const dir = join(codexHome(), "sessions", String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()));
    mkdirSync(dir, { recursive: true });
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    const file = join(dir, `rollout-${stamp}-${session}.jsonl`);
    writeFileSync(file, text);
    return { session, file, lines: text.split("\n").filter(Boolean).length };
  },
  existing(session) {
    // Codex finds a rollout by its id, under any day.
    const root = join(codexHome(), "sessions");
    if (!existsSync(root)) return undefined;
    const name = readdirSync(root, { recursive: true }).map(String).find((f) => f.endsWith(`-${session}.jsonl`));
    return name ? join(root, name) : undefined;
  },
  resume: (dir, session) => `cd ${shellWord(dir)} && codex resume ${session}`,
};

export const HARNESSES: Record<string, Harness> = { "claude-code": CLAUDE_CODE, claude: CLAUDE_CODE, codex: CODEX };

/** The agent `name` names: claude-code (or claude) or codex. */
export function harness(name: string | undefined): Harness {
  if (name === undefined) return CLAUDE_CODE;
  const h = HARNESSES[name.toLowerCase()];
  if (!h) throw new Error(`braid writes sessions for claude-code and codex, not ${name}`);
  return h;
}
