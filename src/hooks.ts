// Agent hooks, Claude Code's and Codex's: SessionStart registers the session
// and saves what sessions that crashed left unsaved, PostToolUse saves a turn
// as it goes, Stop saves each turn, SessionEnd saves the rest and checks the
// session.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ago } from "./records.ts";
import { repoFor, type Repo } from "./repo.ts";
import { recordSession } from "./registry.ts";
import { behind, register, save } from "./save.ts";
import { cliPath, writePointer } from "./setup.ts";
import { loadState, saveState } from "./state.ts";
import type { Format } from "./transcript.ts";
import { turnName } from "./turns.ts";
import { verify } from "./verify.ts";

export interface HookInput {
  session_id?: string;
  transcript_path?: string | null;
  cwd?: string;
  source?: string;
  /** The agent that ran the hook, as its hook command names it. */
  agent?: Format;
}

const where = (input: HookInput, session: string): Repo => repoFor(session, input.cwd ?? process.cwd());

/** Runs braid in the background, so the hook returns at once. BRAID_BACKGROUND=0 runs nothing there, as braid's tests do. */
export function inBackground(args: string[], input?: HookInput): void {
  if (process.env.BRAID_BACKGROUND === "0") return;
  const cwd = input?.cwd && existsSync(input.cwd) ? input.cwd : undefined;
  const env = { ...process.env, ...(input ? { BRAID_HOOK_INPUT: JSON.stringify(input) } : {}) };
  spawn(process.execPath, [cliPath(), ...args], { detached: true, stdio: "ignore", cwd, env }).unref();
}

export function sessionStart(input: HookInput): string {
  const session = input.session_id;
  if (!session) return "";
  const transcript = input.transcript_path ?? undefined;
  writePointer();
  recordSession(session, { transcript });
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (envFile) {
    const bin = join(dirname(dirname(cliPath())), "bin");
    appendFileSync(envFile, `export BRAID_SESSION=${session}\nexport PATH="${bin}:$PATH"\n`);
  }
  const repo = where(input, session);
  register(repo, session, transcript, input.agent, input.cwd);
  // A session that crashed, or was force-quit, before its hooks saved its last lines: saved now, whichever it was.
  inBackground(["save", "--pending"]);
  // Coming back to a session: what it is about, for you. The model gets none of it.
  const message = input.source === "resume" ? recap(repo, session, input.agent ?? "claude-code") : "";
  return message ? JSON.stringify({ systemMessage: message }) : "";
}

/**
 * "braid · 5b0e2c1a.12 · Retry webhook deliveries". In Codex, which writes no
 * recaps, also Claude Code's latest recap of the session; Claude Code shows
 * its own again when it resumes a session.
 */
export function recap(repo: Repo, session: string, agent: Format): string {
  const state = loadState(repo, session);
  if (!state?.title && !state?.recap) return "";
  const name = state.turn ? turnName(session, state.turn) : session.slice(0, 8);
  const fork = state.forkedFrom ? `, a fork of ${turnName(state.forkedFrom.session, state.forkedFrom.turn)}` : "";
  const head = `braid · ${name}${state.title ? ` · ${state.title.text}` : ""}${fork}`;
  return state.recap && agent === "codex" ? `${head}\nLast recap, ${ago(state.recap.at)}: ${state.recap.text}` : head;
}

export function stop(input: HookInput): string {
  const session = input.session_id;
  if (!session) return "";
  const repo = where(input, session);
  save(repo, session, input.transcript_path ?? undefined, { agent: input.agent });
  return "";
}

/**
 * PostToolUse: what the turn wrote so far, saved in the background, at most
 * every ten seconds, so a crash or a force quit in the middle of a turn loses
 * at most those seconds, which the next session's start saves.
 */
export function postToolUse(input: HookInput): string {
  const session = input.session_id;
  if (!session) return "";
  const repo = where(input, session);
  const state = loadState(repo, session);
  if (!state || !behind(state, input.transcript_path ?? state.transcript)) return "";
  const stamp = join(repo.cache, `${session}.saving`);
  if (existsSync(stamp) && Date.now() - statSync(stamp).mtimeMs < 10_000) return "";
  mkdirSync(repo.cache, { recursive: true });
  writeFileSync(stamp, "");
  inBackground(["hook", "stop", ...(input.agent ? ["--agent", input.agent] : []), "--detached"], input);
  return "";
}

/** SessionEnd: saves the rest, and checks the session. */
export function sessionEnd(input: HookInput): string {
  const session = input.session_id;
  if (!session) return "";
  const repo = where(input, session);
  const { state } = save(repo, session, input.transcript_path ?? undefined, { agent: input.agent });
  if (state.chunks === 0) return "";
  // Each session is checked when it ends: saved as it happened, and loads back the same.
  const v = verify(repo, session);
  const s = loadState(repo, session);
  if (s) saveState(repo, { ...s, verified: { ok: v.problems.length === 0, at: new Date().toISOString(), ...(v.problems.length ? { problems: v.problems } : {}) } });
  // Logged by the hook runner; the status line shows ⚠ braid verify when the session is resumed.
  if (v.problems.length) throw new Error(`braid verify ${session} in ${repo.dir}: ${v.problems.join("; ")}`);
  return "";
}
