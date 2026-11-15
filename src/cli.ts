// braid command line. Hooks call it too, so hook commands never fail loudly.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { sessionEnd, sessionStart, stop } from "./hooks.ts";
import { allSessions, resolve } from "./load.ts";
import { migrate, waitingToMove } from "./migrate.ts";
import { claudeEnv, harness } from "./harness.ts";
import { launchDir, replay, shellWord } from "./replay.ts";
import { currentAgent, currentSession, knownSessions, recordSession, transcriptOf } from "./registry.ts";
import { ago, describe, isTurn, printable, promptLine } from "./records.ts";
import { configDir, repoAt, repoFor, type Repo } from "./repo.ts";
import { save, saveAll, unsaved } from "./save.ts";
import { cliPath, init, setup } from "./setup.ts";
import { loadState, saveState } from "./state.ts";
import { computeStatus } from "./status.ts";
import { statusline } from "./statusline.ts";
import { readRecords, sessionFile } from "./store.ts";
import { findTurn, TURN, turnDetail, turnName, turnsOf } from "./turns.ts";
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
  braid status                this session: its newest turn, what it is about, and where it is kept
  braid sessions              the sessions this project keeps
  braid log [<session>] [--records]   a session's turns, each named <session>.<n>, with what it did;
                              --records: each record, under its turn
  braid fork [<session>|<session>.<n>|.<n>] [<prompt>]   the command to continue a session, or one from
                              the end of its turn n, in a new window; with none, this one. A prompt, last,
                              is the fork's first message: braid fork .5 "try the other approach"
    --to codex|claude-code    as a new session of that agent's (by default the agent it runs in)
    --new                     another session, even when the same fork was written before
  braid verify [<session>|--all]   check that a session was saved as it happened and loads back the same
  braid save                  save this session now (the Stop hook does this after each turn)
    --all                     every session on this machine that ran in this project, in any of its
                              worktrees, as those from before braid was installed
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

/**
 * One session, found by name, or the session a command runs in, with the
 * project that keeps it: this one, or, for a session id this project does not
 * keep, the project braid noted for it when it saved it.
 */
function oneSession(repo: Repo, target: string | undefined, current: string | undefined): { repo: Repo; session: string } {
  if (!target) return { repo, session: needSession(current) };
  const found = resolve(repo, target);
  if (found.length === 1) return { repo, session: found[0]!.session };
  if (found.length > 1) throw new Error(`${target} matches ${found.length} sessions; name one (braid sessions lists them)`);
  const elsewhere = knownSessions(target).filter((k) => k.project && existsSync(join(k.project, ".braid")));
  if (elsewhere.length === 1) return { repo: repoAt(elsewhere[0]!.project!), session: elsewhere[0]!.session };
  throw new Error(elsewhere.length ? `${target} matches ${elsewhere.length} sessions; name one` : `no session matches ${target}; braid sessions lists them`);
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
    case "git-hook":
      // braid 0.1's git hooks call this. They do nothing now, and braid init takes them out.
      return 0;
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
      if (waitingToMove()) for (const note of migrate()) if (/^(moved|took) /.test(note)) out(`braid: ${note}`);
      // The conversation braid init runs in is saved now, from its first turn.
      // A session that started before braid was installed has no BRAID_SESSION and no entry: Claude Code names it.
      const transcript = str("transcript") ?? (current ? transcriptOf(current) : undefined);
      if (current && transcript && existsSync(transcript)) {
        const repo = here();
        recordSession(current, { transcript });
        const r = save(repo, current, transcript);
        out(`braid: saved this conversation (${named(repo, current)}), ${r.added} records, in ${sessionFile(repo, current)}`);
      }
      // Sessions of this project from before braid was installed are saved when asked.
      const earlier = unsaved(process.cwd()).filter((s) => s.session !== current).length;
      if (earlier) out(`braid: ${earlier} earlier session${earlier === 1 ? "" : "s"} of this project on this machine ${earlier === 1 ? "is" : "are"} not saved: braid save --all saves them`);
      return 0;
    }
    case "migrate":
      for (const note of migrate()) out(`braid: ${note}`);
      return 0;
    case "save": {
      if (opts.all === true) {
        const { project, saved } = saveAll(process.cwd());
        if (saved.length === 0) {
          out(`braid: no Claude Code or Codex session on this machine ran in ${project}`);
          return 0;
        }
        const rows = saved
          .filter((r) => !r.error && r.state && r.state.chunks > 0)
          .map((r) => ({ r, name: named(r.repo, r.session), title: r.state?.title ? printable(r.state.title.text, 50) : "" }))
          .sort((a, b) => a.title.localeCompare(b.title));
        const width = Math.max(0, ...rows.map((x) => x.name.length));
        const fresh = rows.filter((x) => x.r.added > 0).length;
        out(`braid: ${rows.length} session${rows.length === 1 ? "" : "s"} of ${project}, kept in ${join(project, ".braid", "sessions")}; ${fresh} saved now, ${rows.length - fresh} up to date already`);
        for (const x of rows) out(`  ${x.name.padEnd(width)}  ${x.title}${x.r.added ? `  (${x.r.added} records saved)` : ""}`);
        for (const r of saved.filter((r) => r.error)) out(`  ${r.session.slice(0, 8)}  not saved: ${r.error}`);
        out("braid log <session> lists a session's turns; braid fork <session> continues it in a new window");
        return 0;
      }
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
      out(`  kept in ${sessionFile(repo, session)}`);
      if (state.ran && state.ran !== repo.top) out(`  ran in ${state.ran}`);
      if (s.broken) out(`  ⚠ braid verify found problems when it last ran: ${(state.verified?.problems ?? []).join("; ")}`);
      if (state.forkedFrom) out(`  a fork of ${turnName(state.forkedFrom.session, state.forkedFrom.turn)}`);
      return 0;
    }
    case "sessions": {
      // Newest first, each with its newest turn, what it is about, its agent and when it was last saved.
      const repo = here();
      const rows = allSessions(repo)
        .map((f) => ({ f, state: loadState(repo, f.session), file: sessionFile(repo, f.session) }))
        .filter((x) => x.state && x.state.chunks > 0 && existsSync(x.file))
        .map((x) => ({ ...x, at: statSync(x.file).mtime.toISOString() }))
        .sort((a, b) => b.at.localeCompare(a.at));
      if (rows.length === 0) out(`braid: no saved sessions in ${repo.dir}`);
      for (const { f, state, at } of rows) {
        // The worktree a session ran in, for a project whose worktrees share its sessions.
        const where = state!.ran && state!.ran !== repo.top ? `, in ${basename(state!.ran)}` : "";
        const fork = state!.forkedFrom ? `, a fork of ${turnName(state!.forkedFrom.session, state!.forkedFrom.turn)}` : "";
        out(`${named(repo, f.session).padEnd(14)} ${(state!.title?.text ?? "").slice(0, 50).padEnd(50)} ${state!.harness.padEnd(11)} ${ago(at)}${where}${fork}`);
      }
      return 0;
    }
    case "log": {
      const { repo, session } = oneSession(here(), args[0], current);
      const records = readRecords(repo, session);
      if (!records.length) throw new Error(`${session.slice(0, 8)} is not saved here`);
      const lines: string[] = [];
      for (const t of turnsOf(records)) {
        if (!t.start) continue;
        if (opts.records === true) {
          // Each record, under its turn's name.
          for (const r of t.records.filter(isTurn)) lines.push(`${turnName(session, t.n).padEnd(12)}  ${(r.role ?? r.type).padEnd(9)} ${describe(r, 160).split("\n")[0]}`);
        } else {
          const did = turnDetail(t.records);
          lines.push(`${turnName(session, t.n).padEnd(12)}  ${promptLine(t.start)}${did ? `  (${did})` : ""}`);
        }
      }
      page(lines.length ? `${lines.join("\n")}\n` : "");
      return 0;
    }
    case "fork": {
      const repo = here();
      // A fork continues in the agent it is asked from, unless another is named.
      const to = harness(str("to") ?? currentAgent());
      // What to fork first, then the prompt the fork starts with, last: braid fork .5 "try the other approach". A first
      // argument with a space in it that names no session is the prompt, for this session.
      const first = args[0];
      const target = first !== undefined && (!/\s/.test(first) || resolve(repo, first).length > 0) ? first : undefined;
      const prompt = (target === undefined ? args : args.slice(1)).join(" ").trim() || undefined;
      const start = (command: string) => (prompt ? `${command} ${shellWord(prompt)}` : command);
      const resume = (dir: string, id: string) => start(`  cd ${shellWord(dir)} && ${claudeEnv()}claude --resume ${id} --fork-session`);
      const fresh = opts.new === true;
      const wrote = (what: string, r: { cwd: string; session: string; existing?: boolean }) =>
        r.existing
          ? `braid: ${what} is already a ${to.title} session, from an earlier fork. To continue it in a new window, run in a terminal:\n  ${start(to.resume(r.cwd, r.session))}\nbraid fork --new writes another.`
          : `braid: wrote ${what} as a new ${to.title} session. To continue it in a new window, run in a terminal:\n  ${start(to.resume(r.cwd, r.session))}`;
      // This session's newest turns are saved first.
      if (current) {
        const transcript = loadState(repo, current)?.transcript ?? transcriptOf(current);
        if (transcript && existsSync(transcript)) save(repo, current, transcript);
      }
      // A turn: <session>.<n>, or .<n> for this session's. A fork continues from the end of that turn.
      const m = target ? TURN.exec(target) : null;
      if (m && !(m[1] && resolve(repo, target!).length)) {
        const { repo: kept, session } = oneSession(repo, m[1] || undefined, current);
        const turn = findTurn(kept, { session }, Number(m[2]));
        if (!turn) throw new Error(`${session.slice(0, 8)} has no turn ${m[2]}; braid log lists its turns`);
        out(wrote(`the conversation up to ${turnName(session, turn.n)}`, replay(kept, { session }, to, { cwd: str("cwd"), fresh, until: turn.until, prompted: !!prompt })));
        return 0;
      }
      const { repo: kept, session } = oneSession(repo, target, current);
      const state = loadState(kept, session);
      if (!state || state.chunks === 0) throw new Error(`${session.slice(0, 8)} is not saved yet`);
      // A Claude Code session of this machine, continued in Claude Code: Claude Code forks it, with everything it holds.
      const dir = to.agent === "claude-code" && state.harness === "claude-code" && !str("cwd") && !fresh ? launchDir(state.transcript) : undefined;
      if (dir) {
        const what = session === current ? "this conversation" : named(kept, session);
        out([`braid: to branch ${what} into a new window, run in a terminal:`, resume(dir, session), ...(session === current ? ["or /branch to branch it in this window. braid saves the branch as a session of its own."] : [])].join("\n"));
        return 0;
      }
      out(wrote(session === current ? "this conversation" : named(kept, session), replay(kept, { session }, to, { cwd: str("cwd"), fresh, prompted: !!prompt })));
      return 0;
    }
    case "verify": {
      // Saved as it happened, and loads back as it was saved: this session, one named, or all of them.
      const repo = here();
      const ids = opts.all === true ? allSessions(repo).filter((f) => (loadState(repo, f.session)?.chunks ?? 0) > 0).map((f) => ({ repo, session: f.session })) : [oneSession(repo, args[0], current)];
      let bad = 0;
      for (const { repo, session: id } of ids) {
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

