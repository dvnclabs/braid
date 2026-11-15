// braid command line. Hooks call it too, so hook commands never fail loudly.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { sessionEnd, sessionStart, stop } from "./hooks.ts";
import { allSessions, resolve } from "./load.ts";
import { context, pick, record } from "./merge.ts";
import { migrate, waitingToMove } from "./migrate.ts";
import { claudeEnv, harness } from "./harness.ts";
import { launchDir, replay, shellWord } from "./replay.ts";
import { currentAgent, currentSession, recordSession, transcriptOf } from "./registry.ts";
import { ago, describe, isTurn, promptLine } from "./records.ts";
import { configDir, repoFor, type Repo } from "./repo.ts";
import { save } from "./save.ts";
import { cliPath, init, setup } from "./setup.ts";
import { loadState, saveState } from "./state.ts";
import { computeStatus } from "./status.ts";
import { statusline } from "./statusline.ts";
import { readRecords, recordsFile } from "./store.ts";
import { conversationSessions, lineOf, numbering, resolveTurn, TURN, turnDetail, turnName, turnsAlong } from "./turns.ts";
import { verify } from "./verify.ts";
import { VERSION } from "./version.ts";

const HELP = `braid ${VERSION}: efficient session manager

Saves every Claude Code and Codex session, as it happens, in the project it runs in:
.braid/sessions/<id>.jsonl, one record per line, in a folder git does not see. Each command
works on the session it runs in ($BRAID_SESSION, else Claude Code's $CLAUDE_CODE_SESSION_ID or
Codex's $CODEX_THREAD_ID), or the one named with --session <id>.

  braid init                  this machine: the braid command, the status line, braid's hooks in
                              Codex when it is installed; and this project's .braid folder
    --undo                    put back the status line braid replaced, and take braid's hooks out of Codex
  braid status                this session: its newest turn, what it is about, and branches to merge
  braid sessions              the sessions this project keeps
  braid log [<session>] [--records]   a session's turns, each named <session>.<n>, with what it did;
                              --records: each record, under its turn
  braid fork [<session>|<session>.<n>|.<n>]   the command to continue a session, or one from the end
                              of its turn n, in a new window; with none, this one
    --to codex|claude-code    as a new session of that agent's (by default the agent it runs in)
    --new                     another session, even when the same fork was written before
  braid merge [<session>]     what another session has that this one lacks, for the agent to merge
  braid merge --record <id> --instruction "<text>"   record a merge; the summary on stdin
  braid merge --skip <id>     mark a session seen without adopting anything
  braid verify [<session>|--all]   check that a session was saved as it happened and loads back the same
  braid save                  save this session now (the Stop hook does this after each turn)
  braid migrate               move conversations from braid 0.1's ~/.braid into their projects

  <session> is a session id or its first characters, or the name you gave it with /rename.
  braid sessions lists them.
`;

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function logError(err: unknown): void {
  try {
    mkdirSync(configDir(), { recursive: true });
    appendFileSync(join(configDir(), "errors.log"), `${new Date().toISOString()} ${err instanceof Error ? err.stack : String(err)}\n`);
  } catch {
    // nowhere to log
  }
}

function needSession(flag: string | undefined): string {
  const session = flag ?? currentSession();
  if (!session) throw new Error("no session: run inside an agent session with braid installed, or pass --session <id>");
  return session;
}

/** Long output goes through a pager on a terminal, as git does. */
function page(text: string): void {
  const rows = process.stdout.rows ?? 0;
  if (!process.stdout.isTTY || text.split("\n").length < rows) {
    process.stdout.write(text);
    return;
  }
  const r = spawnSync(process.env.PAGER || "less", { input: text, stdio: ["pipe", "inherit", "inherit"], shell: true, env: { LESS: "FRX", ...process.env } });
  if (r.error || r.status === 127) process.stdout.write(text);
}

/** A session's name with its newest turn: 5b0e2c1a.12. */
const named = (repo: Repo, session: string): string => {
  const turn = loadState(repo, session)?.turn;
  return turn ? turnName(session, turn) : session.slice(0, 8);
};

/** One session, found by name, or the session a command runs in. */
function oneSession(repo: Repo, target: string | undefined, current: string | undefined): string {
  if (!target) return needSession(current);
  const found = resolve(repo, target);
  if (found.length !== 1) throw new Error(found.length ? `${target} matches ${found.length} sessions; name one (braid sessions lists them)` : `no session matches ${target}; braid sessions lists them`);
  return found[0]!.session;
}

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  const { values: opts, positionals: args } = parseArgs({
    args: rest,
    allowPositionals: true,
    strict: false,
    options: {
      session: { type: "string" },
      transcript: { type: "string" },
      to: { type: "string" },
      agent: { type: "string" },
      detached: { type: "boolean" },
      record: { type: "string" },
      skip: { type: "string" },
      instruction: { type: "string" },
      strategy: { type: "string" },
      all: { type: "boolean" },
      undo: { type: "boolean" },
      new: { type: "boolean" },
      records: { type: "boolean" },
      cwd: { type: "string" },
    },
  });
  const str = (k: string) => (typeof opts[k] === "string" ? (opts[k] as string) : undefined);
  const out = (s: string) => s && process.stdout.write(s.endsWith("\n") ? s : `${s}\n`);
  const current = str("session") ?? currentSession();
  // Where this session is kept: with its conversation, else in this project.
  const here = () => repoFor(current, process.cwd());

  switch (command) {
    case "hook": {
      // Hooks must never break the session: errors go to the log.
      try {
        const input = JSON.parse((opts.detached === true ? process.env.BRAID_HOOK_INPUT : readStdin()) || "{}");
        const agent = str("agent") === "codex" ? "codex" : undefined;
        if (args[0] === "session-end" && agent && opts.detached !== true) {
          // Codex gives a SessionEnd hook three seconds at most: the save and the check go on after it returns.
          const env = { ...process.env, BRAID_HOOK_INPUT: JSON.stringify(input) };
          spawn(process.execPath, [cliPath(), "hook", "session-end", "--agent", agent, "--detached"], { detached: true, stdio: "ignore", env }).unref();
          return 0;
        }
        const handlers: Record<string, (i: typeof input) => string> = { "session-start": sessionStart, stop, "session-end": sessionEnd };
        out(handlers[args[0] ?? ""]?.({ ...input, ...(agent ? { agent } : {}) }) ?? "");
      } catch (err) {
        logError(err);
      }
      return 0;
    }
    case "statusline":
      try {
        out(statusline(readStdin()));
      } catch (err) {
        logError(err);
      }
      return 0;
    case "init": {
      if (opts.undo === true) {
        for (const note of setup({ undo: true })) out(`braid: ${note}`);
        return 0;
      }
      for (const note of init(process.cwd())) out(`braid: ${note}`);
      // Conversations braid 0.1 kept in ~/.braid move into their projects.
      if (waitingToMove()) for (const note of migrate()) if (/^moved /.test(note)) out(`braid: ${note}`);
      // The conversation braid init runs in is saved now, from its first turn.
      // A session that started before braid was installed has no BRAID_SESSION and no entry: Claude Code names it.
      const transcript = str("transcript") ?? (current ? transcriptOf(current) : undefined);
      if (current && transcript && existsSync(transcript)) {
        const repo = here();
        recordSession(current, { transcript });
        const r = save(repo, current, transcript);
        out(`braid: saved this conversation (${named(repo, current)}), ${r.added} records, in ${recordsFile(repo, current)}`);
      }
      return 0;
    }
    case "migrate":
      for (const note of migrate()) out(`braid: ${note}`);
      return 0;
    case "save": {
      const session = needSession(current);
      const repo = here();
      const known = loadState(repo, session)?.transcript;
      const r = save(repo, session, str("transcript") ?? (known ? undefined : transcriptOf(session)));
      out(`braid: saved ${r.added} records${r.state.turn ? `, up to ${turnName(session, r.state.turn)}` : ""}`);
      return 0;
    }
    case "status": {
      const session = needSession(current);
      const repo = here();
      const state = loadState(repo, session);
      if (!state || state.chunks === 0) {
        out(`braid · ${session.slice(0, 8)}: not saved yet; braid saves it when this turn ends`);
        return 0;
      }
      const s = computeStatus(repo, session);
      out(`braid · ${named(repo, session)}${state.title ? ` · ${state.title.text}` : ""}`);
      if (state.recap) out(`  recap, ${ago(state.recap.at)}: ${state.recap.text}`);
      out(`  kept in ${recordsFile(repo, session)}`);
      if (state.ran && state.ran !== repo.top) out(`  ran in ${state.ran}`);
      if (s.broken) out(`  ⚠ braid verify found problems when it last ran: ${(state.verified?.problems ?? []).join("; ")}`);
      for (const w of s.waiting) out(`  ↓ ${w.name} (${w.session.slice(0, 8)}) has ${w.count} records this session has not merged: /braid:merge`);
      const others = allSessions(repo).filter((f) => f.conv === state.conv && f.session !== session);
      if (others.length) out(`  this conversation: ${others.map((f) => named(repo, f.session)).join(", ")}`);
      return 0;
    }
    case "sessions": {
      // Newest first, each with its newest turn, what it is about, its agent and when it was last saved.
      const repo = here();
      const rows = allSessions(repo)
        .map((f) => ({ f, state: loadState(repo, f.session), file: recordsFile(repo, f.session) }))
        .filter((x) => x.state && x.state.chunks > 0 && existsSync(x.file))
        .map((x) => ({ ...x, at: statSync(x.file).mtime.toISOString() }))
        .sort((a, b) => b.at.localeCompare(a.at));
      if (rows.length === 0) out(`braid: no saved sessions in ${repo.dir}`);
      for (const { f, state, at } of rows) {
        // The worktree a session ran in, for a project whose worktrees share its sessions.
        const where = state!.ran && state!.ran !== repo.top ? `, in ${basename(state!.ran)}` : "";
        const fork = f.conv !== f.session ? `, in ${f.conv.slice(0, 8)}'s conversation` : "";
        out(`${named(repo, f.session).padEnd(14)} ${(state!.title?.text ?? "").slice(0, 50).padEnd(50)} ${state!.harness.padEnd(11)} ${ago(at)}${where}${fork}`);
      }
      return 0;
    }
    case "log": {
      const repo = here();
      const session = oneSession(repo, args[0], current);
      const state = loadState(repo, session);
      if (!state) throw new Error(`${session.slice(0, 8)} is not saved here`);
      const sessions = conversationSessions(repo, state.conv);
      const turns = numbering(sessions);
      const lines: string[] = [];
      if (opts.records === true) {
        // This session's records, each under its turn's name.
        const mine = turns.get(session);
        for (const r of readRecords(repo, session)) {
          if (!isTurn(r)) continue;
          const kind = r.type === "branch_summary" ? "merge" : (r.role ?? r.type);
          lines.push(`${turnName(session, mine?.get(r.id) ?? 0).padEnd(12)}  ${kind.padEnd(9)} ${describe(r, 160).split("\n")[0]}`);
        }
      } else {
        // One line per turn along the session's line, the sessions it forks from included, as git log shows history.
        for (const t of turnsAlong(lineOf(sessions, session), turns)) {
          if (!t.start) continue;
          const said = t.start.type === "branch_summary" ? `merge: ${describe(t.start, 100).split("\n")[0]}` : promptLine(t.start);
          const did = turnDetail(t.records);
          lines.push(`${turnName(t.session, t.n).padEnd(12)}  ${said}${did ? `  (${did})` : ""}`);
        }
      }
      page(lines.length ? `${lines.join("\n")}\n` : "");
      return 0;
    }
    case "fork": {
      const repo = here();
      // A fork continues in the agent it is asked from, unless another is named.
      const to = harness(str("to") ?? currentAgent());
      const resume = (dir: string, id: string) => `  cd ${shellWord(dir)} && ${claudeEnv()}claude --resume ${id} --fork-session`;
      const fresh = opts.new === true;
      const wrote = (what: string, r: { cwd: string; session: string; existing?: boolean }) =>
        r.existing
          ? `braid: ${what} is already a ${to.title} session, from an earlier fork. To continue it in a new window, run in a terminal:\n  ${to.resume(r.cwd, r.session)}\nbraid fork --new writes another.`
          : `braid: wrote ${what} as a new ${to.title} session. To continue it in a new window, run in a terminal:\n  ${to.resume(r.cwd, r.session)}`;
      // This session's newest turns are saved first.
      if (current) {
        const transcript = loadState(repo, current)?.transcript ?? transcriptOf(current);
        if (transcript && existsSync(transcript)) save(repo, current, transcript);
      }
      // A turn: <session>.<n>, or .<n> for this session's. A fork continues from the end of that turn.
      const turn = args[0] && TURN.test(args[0]) ? resolveTurn(repo, args[0], current) : undefined;
      if (turn) {
        out(wrote(`the conversation up to ${turnName(turn.found.session, turn.n)}`, replay(repo, turn.found, to, { cwd: str("cwd"), fresh, until: turn.until })));
        return 0;
      }
      const session = oneSession(repo, args[0], current);
      const state = loadState(repo, session);
      if (!state || state.chunks === 0) throw new Error(`${session.slice(0, 8)} is not saved yet`);
      // A Claude Code session of this machine, continued in Claude Code: Claude Code forks it, with everything it holds.
      const dir = to.agent === "claude-code" && state.harness === "claude-code" && !str("cwd") && !fresh ? launchDir(state.transcript) : undefined;
      if (dir) {
        const what = session === current ? "this conversation" : named(repo, session);
        out([`braid: to branch ${what} into a new window, run in a terminal:`, resume(dir, session), ...(session === current ? ["or /branch to branch it in this window. braid files the branch in this conversation."] : [])].join("\n"));
        return 0;
      }
      const found = allSessions(repo).find((f) => f.session === session)!;
      out(wrote(session === current ? "this conversation" : named(repo, session), replay(repo, found, to, { cwd: str("cwd"), fresh })));
      return 0;
    }
    case "merge": {
      const session = needSession(current);
      const repo = here();
      const target = str("record") ?? str("skip") ?? args[0];
      const { waiting, chosen } = pick(repo, session, target);
      if (!chosen) {
        if (waiting.length === 0) out("braid: nothing waiting to be merged into this session; name a session to merge (braid sessions lists them)");
        else out(["braid: several sessions are waiting; name one:", ...waiting.map((w) => `  ${w.session.slice(0, 8)} ${w.name} +${w.count}`)].join("\n"));
        return 0;
      }
      if (chosen.records.length === 0 && !str("skip")) {
        out(`braid: nothing to merge from ${chosen.name}: this session already has all of it`);
        return 0;
      }
      if (str("skip")) {
        record(repo, session, chosen, { instruction: "skip", summary: `Skipped ${chosen.name}: seen, nothing adopted.`, strategy: "skip" });
        out(`braid: ${chosen.name} marked as seen; the merge record is written when this turn ends`);
      } else if (str("record")) {
        const summary = readStdin();
        if (!summary.trim()) throw new Error("the merge summary goes on stdin");
        record(repo, session, chosen, { instruction: str("instruction") ?? "", summary, strategy: str("strategy") ?? "default" });
        out(`braid: merge of ${chosen.name} recorded; it is written into this session when this turn ends`);
      } else {
        out(context(chosen));
      }
      return 0;
    }
    case "verify": {
      // Saved as it happened, and loads back as it was saved: this session, one named, or all of them.
      const repo = here();
      const ids = opts.all === true ? allSessions(repo).filter((f) => (loadState(repo, f.session)?.chunks ?? 0) > 0).map((f) => f.session) : [oneSession(repo, args[0], current)];
      let bad = 0;
      for (const id of ids) {
        const v = verify(repo, id);
        bad += v.problems.length ? 1 : 0;
        const st = loadState(repo, id);
        if (st) saveState(repo, { ...st, verified: { ok: !v.problems.length, at: new Date().toISOString(), ...(v.problems.length ? { problems: v.problems } : {}) } });
        out(`braid verify ${named(repo, id)}: ${v.problems.length ? `${v.problems.length} problems` : "ok"}`);
        for (const p of v.problems) out(`  ✗ ${p}`);
        for (const c of v.checked) out(`  ✓ ${c}`);
        for (const n of v.notes) out(`  · ${n}`);
      }
      return bad ? 1 : 0;
    }
    case "version":
    case "--version":
      out(VERSION);
      return 0;
    case undefined:
    case "help":
    case "--help":
      out(HELP);
      return 0;
    default:
      process.stderr.write(`braid: unknown command ${command}\n\n${HELP}`);
      return 2;
  }
}

// Output cut short by its reader, as `braid log | head` does, ends the command quietly.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code !== "EPIPE") throw err;
  process.exit(process.exitCode ?? 0);
});

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`braid: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}

