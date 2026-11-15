// Agent hooks, Claude Code's and Codex's: SessionStart registers the session,
// Stop saves each turn, SessionEnd saves the rest and checks the session.
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ago } from "./records.ts";
import { repoFor, type Repo } from "./repo.ts";
import { recordSession } from "./registry.ts";
import { register, save } from "./save.ts";
import { cliPath, writePointer } from "./setup.ts";
import { loadState, saveState } from "./state.ts";
import { computeStatus } from "./status.ts";
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
  const name = (id: string) => (state.turn ? turnName(id, state.turn) : id.slice(0, 8));
  // A fork not saved yet stands at the turn it forks from.
  const fork = state.forkFrom ? `, a fork of ${name(state.forkFrom.session)}` : "";
  const head = `braid · ${name(session)}${state.title ? ` · ${state.title.text}` : ""}${fork}`;
  return state.recap && agent === "codex" ? `${head}\nLast recap, ${ago(state.recap.at)}: ${state.recap.text}` : head;
}

export function stop(input: HookInput): string {
  const session = input.session_id;
  if (!session) return "";
  const repo = where(input, session);
  save(repo, session, input.transcript_path ?? undefined, { agent: input.agent });
  // A branch of this conversation with turns to merge: said once, under the reply.
  const waiting = computeStatus(repo, session).waiting;
  const signature = waiting.map((w) => `${w.session}:${w.count}`).join(",");
  const state = loadState(repo, session);
  if (!state || signature === (state.notified ?? "")) return "";
  state.notified = signature;
  saveState(repo, state);
  if (!signature) return "";
  const what = waiting.map((w) => `${w.name} +${w.count}`).join(", ");
  return JSON.stringify({ systemMessage: `braid: ${what} waiting to be merged into this session. /braid:merge to merge.` });
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
