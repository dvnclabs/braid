// braid command line. Hooks call it too, so hook commands never fail loudly.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { readAgents, readRecords } from "./chunks.ts";
import { fetchSessions } from "./fetch.ts";
import { postCommit, postRewrite, prePush, prepareCommitMsg } from "./githooks.ts";
import { sessionEnd, sessionStart, stop } from "./hooks.ts";
import { allSessions, briefing, markFork, resolve } from "./load.ts";
import { context, pick, record } from "./merge.ts";
import { launchDir, replay, shellWord } from "./replay.ts";
import { readEntry } from "./registry.ts";
import { editRecord, hide, lineText, pickLines, renderEdit, editLines, setPrivate, withhold, withholdRecent } from "./edit.ts";
import { importOpenclaw, openclawDatabases } from "./openclaw.ts";
import { points } from "./points.ts";
import { publish, view, type PublishResult } from "./publish.ts";
import { braidOf, describe, isTurn, type Rec } from "./records.ts";
import { findRepo, isEnabled, locate, readConfig, type Repo } from "./repo.ts";
import { save } from "./save.ts";
import { configDir, init, setup } from "./setup.ts";
import { loadState, saveState } from "./state.ts";
import { cleanName, computeStatus, render, sessionName, sessionTitle } from "./status.ts";
import { statusline } from "./statusline.ts";
import { verify } from "./verify.ts";
import { VERSION } from "./version.ts";

const HELP = `braid ${VERSION}: efficient session manager

Save, edit, commit, push, fork and merge coding-agent sessions with git. Each command
works on the session it runs in ($BRAID_SESSION), or the one named with --session <id>.

Set up
  braid init                  this machine: the braid command, the status line, and ~/.braid, the
                              braid repository that keeps every conversation. Inside a git
                              repository, braid there too: .braid/config.toml, .braidignore, git hooks
    --autopilot|--no-autopilot  braid works on this machine only: no push, fetch or GitHub (on by default)
    --autofork|--no-autofork    mark a fork point before each big turn (on by default)
    --repo <path>|auto        keep conversations in another braid repository, or in ~/.braid
                              (auto, the default)
    --autocommit|--no-autocommit  a code commit commits the conversation too (off by default)
    --autopush|--no-autopush      git push publishes the committed conversation (on by default)
    --no-git-hooks            leave git alone
    --undo                    put back the status line braid replaced

Everyday
  braid status                where this session stands, and the sessions around it
  braid edit                  this session as it would be published, one numbered line per record
  braid edit 4 7-9 12.3       withhold records (a tool call takes its result, a subagent all its records)
  braid edit --rewrite 5      rewrite a record's text in your editor (or from stdin); empty it to withhold it
  braid edit --hide "<s>"     hide text everywhere in this session
  braid edit --last 30m | --all   withhold recent records, or the whole session
  braid edit --undo ...       put back records, text (--undo --hide), a record's own text (--undo --rewrite 5) or the session (--undo --all)
  braid commit -m "<message>" commit the conversation: publishing goes up to the last commit
  braid push [--dry-run]      publish the committed part now (git push does this with autopush)
  braid fork [<session>|@N]   the command to continue a session, or fork point N, in a new window; with none, this one
  braid fork <session> --here continue from another session in this one, before its first turn is saved
  braid merge [<session>]     show what another session has that this one lacks, for the agent to merge
  braid merge --record <id> --instruction "<text>"   record a merge; summary on stdin
  braid merge --skip <id>     mark a session seen without adopting anything
  braid review <N>            continue from the sessions behind pull request N in this session, to review it

  <session> is a session id or its first characters, a name such as review/bob, or pr:N for the
  sessions behind pull request N. braid sessions lists them.

Other
  braid show <session>        read a session as a briefing, without linking to it
  braid sessions              every session braid can see here
  braid log [<session>]       the turns and commits of a session
  braid verify [<session>|--all]   check that a session was saved as it happened and loads back the same
  braid fetch [--all]         fetch published sessions
  braid import openclaw [--session <key|id>] [--db <path>]   import OpenClaw sessions
  braid save                  save the current session now (the Stop hook does this)
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

/** Where this directory's conversations are kept; a git repository without braid, for reading. */
function needRepo(): Repo {
  const repo = locate(process.cwd()) ?? findRepo(process.cwd());
  if (!repo) throw new Error("braid keeps no conversations here: run braid init");
  return repo;
}

function needSession(flag: string | undefined): string {
  const session = flag ?? process.env.BRAID_SESSION;
  if (!session) throw new Error("no session: run inside an agent session with braid installed, or pass --session <id>");
  return session;
}

function summarize(results: PublishResult[]): string[] {
  return results.flatMap((r) => [
    r.pushed
      ? `braid: published ${r.session.slice(0, 8)}, ${r.records} records${r.redactions ? `, ${r.redactions} redacted` : ""}${r.uncommitted ? `; ${r.uncommitted} newer records are not committed` : ""}`
      : `braid: ${r.session.slice(0, 8)} not published: ${r.reason}`,
    ...(r.replaced ? [`braid: replaced ${r.replaced} records published before; anyone who fetched them keeps their copy`] : []),
    ...(r.conflicts?.length
      ? [`braid: ${r.conflicts.length} records of ${r.session.slice(0, 8)} differ from the copy published from another machine; this machine's were kept: ${r.conflicts.slice(0, 3).join(", ")}`]
      : []),
  ]);
}

/** One line per subagent of a session: its id, what it was asked to do, and its size. */
function agentLines(records: Rec[], agents: Map<string, Rec[]>): string[] {
  return [...agents].map(([id, recs]) => {
    const link = records.find((r) => r.type === "agent_link" && r.transcriptId === id);
    const agent = link?.agent as { name?: string; role?: string } | undefined;
    const what = agent ? `${cleanName(agent.name ?? "subagent")}: ${String(agent.role ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 60)}` : "subagent";
    return `↳ ${id.slice(0, 8)}  ${what}  ${recs.filter(isTurn).length} records`;
  });
}

/** The session to edit: named, the agent's own, or else the newest saved here (for reading only). */
function editSession(repo: Repo, remote: string, flag: string | undefined): { id: string; explicit: boolean } {
  const named = flag ?? process.env.BRAID_SESSION;
  if (named) {
    const own = resolve(repo, named, remote).filter((f) => f.opts.gitDir);
    if (own.length === 1) return { id: own[0]!.session, explicit: true };
    if (own.length > 1) throw new Error(`${named} matches ${own.length} of your sessions; name one`);
    return { id: named, explicit: true };
  }
  // The braid repository holds every conversation: the newest that ran here.
  const dir = join(repo.dir, "sessions");
  const here = (id: string) => repo.separate || loadState(repo, id)?.code === repo.top;
  const newest = (existsSync(dir) ? readdirSync(dir) : [])
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ id: f.slice(0, -".json".length), at: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.at - a.at)
    .find((f) => here(f.id));
  if (!newest) throw new Error("no saved session in this repository");
  return { id: newest.id, explicit: false };
}

/** Opens text in $VISUAL or $EDITOR, as git commit does, and returns what was saved. */
function editInEditor(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "braid-edit-"));
  const file = join(dir, "RECORD.md");
  try {
    writeFileSync(file, `${text}\n`);
    const editor = process.env.VISUAL || process.env.EDITOR || "vi";
    const r = spawnSync(`${editor} ${shellWord(file)}`, { shell: true, stdio: "inherit" });
    if (r.status !== 0) throw new Error(`${editor} exited with ${r.status}; nothing changed`);
    return readFileSync(file, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

function duration(text: string): number {
  const m = /^(\d+)\s*(m|h|d)$/.exec(text.trim());
  if (!m) throw new Error(`not a duration: ${text} (use 30m, 2h or 1d)`);
  return Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"];
}

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  const { values: opts, positionals: args } = parseArgs({
    args: rest,
    allowPositionals: true,
    strict: false,
    options: {
      session: { type: "string" },
      message: { type: "string", short: "m" },
      "git-hooks": { type: "boolean" },
      "no-git-hooks": { type: "boolean" },
      transcript: { type: "string" },
      remote: { type: "string" },
      record: { type: "string" },
      skip: { type: "string" },
      instruction: { type: "string" },
      strategy: { type: "string" },
      last: { type: "string" },
      all: { type: "boolean" },
      quiet: { type: "boolean" },
      force: { type: "boolean" },
      undo: { type: "boolean" },
      "dry-run": { type: "boolean" },
      hide: { type: "string" },
      rewrite: { type: "boolean" },
      repo: { type: "string" },
      here: { type: "boolean" },
      autocommit: { type: "boolean" },
      "no-autocommit": { type: "boolean" },
      autopush: { type: "boolean" },
      "no-autopush": { type: "boolean" },
      autopilot: { type: "boolean" },
      "no-autopilot": { type: "boolean" },
      autofork: { type: "boolean" },
      "no-autofork": { type: "boolean" },
      cwd: { type: "string" },
      db: { type: "string" },
    },
  });
  const str = (k: string) => (typeof opts[k] === "string" ? (opts[k] as string) : undefined);
  const out = (s: string) => s && process.stdout.write(s.endsWith("\n") ? s : `${s}\n`);

  switch (command) {
    case "hook": {
      // Hooks must never break the session: errors go to the log.
      try {
        const input = JSON.parse(readStdin() || "{}");
        const handlers: Record<string, (i: typeof input) => string> = { "session-start": sessionStart, stop, "session-end": sessionEnd };
        out(handlers[args[0] ?? ""]?.(input) ?? "");
      } catch (err) {
        logError(err);
      }
      return 0;
    }
    case "git-hook": {
      try {
        const repo = needRepo();
        const [hook, ...hookArgs] = args;
        if (hook === "prepare-commit-msg" && hookArgs[0]) prepareCommitMsg(repo, hookArgs[0]);
        if (hook === "post-commit") postCommit(repo);
        if (hook === "post-rewrite") postRewrite(repo, readStdin());
        if (hook === "pre-push") {
          const { refuse, results } = prePush(repo, hookArgs[0] ?? "origin", readStdin());
          if (refuse) {
            process.stderr.write(`${refuse}\n`);
            return 1;
          }
          for (const line of summarize(results.filter((r) => r.pushed || r.reason !== "up to date"))) process.stderr.write(`${line}\n`);
        }
      } catch (err) {
        logError(err);
        process.stderr.write(`braid: ${err instanceof Error ? err.message : String(err)}\n`);
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
      const toggle = (key: string) => (opts[`no-${key}`] === true ? false : opts[key] === true ? true : undefined);
      const settings = {
        autopilot: toggle("autopilot"),
        autofork: toggle("autofork"),
        repo: str("repo"),
        "git-hooks": toggle("git-hooks"),
        autocommit: toggle("autocommit"),
        autopush: toggle("autopush"),
      };
      for (const note of init(process.cwd(), settings)) out(`braid: ${note}`);
      // The conversation braid init runs in is saved now, from its first turn.
      const session = str("session") ?? process.env.BRAID_SESSION;
      const transcript = str("transcript") ?? (session ? readEntry(session)?.transcript : undefined);
      const repo = locate(process.cwd());
      if (session && repo && transcript && existsSync(transcript)) {
        const r = save(repo, session, transcript);
        out(`braid: saved this conversation (${session.slice(0, 8)}), ${r.added} records, in ${repo.home}`);
      }
      return 0;
    }
    case "save": {
      const repo = needRepo();
      const r = save(repo, needSession(str("session")), str("transcript"));
      out(`braid: saved ${r.added} records`);
      return 0;
    }
    case "commit": {
      const repo = needRepo();
      const message = str("message") ?? args.join(" ");
      if (!message.trim()) throw new Error('usage: braid commit -m "<message>"');
      const r = save(repo, needSession(str("session")), str("transcript"), { commit: message.trim() });
      const p = publish(repo, r.state.session, { dryRun: true });
      const what = p.reason === "dry run" ? `${p.records} records${p.redactions ? `, ${p.redactions} redacted` : ""}` : p.reason;
      const next = readConfig(repo).autopush ? "the next git push of this session's commits publishes it, or braid push" : "braid push publishes it";
      out(`braid: committed ${r.state.session.slice(0, 8)}: ${message.trim()} (${what}); ${next}`);
      return 0;
    }
    case "push": {
      const repo = needRepo();
      const session = needSession(str("session"));
      save(repo, session);
      const r = publish(repo, session, { remote: str("remote"), dryRun: opts["dry-run"] === true });
      if (!opts["dry-run"]) {
        for (const line of summarize([r])) out(line);
        return 0;
      }
      const list = (m: Map<string, number>) => [...m].map(([k, n]) => `${k} ${n}`).join(", ") || "none";
      const would = r.reason === "dry run" ? `would publish ${r.records} records` : `would not publish: ${r.reason}`;
      out(`braid: dry run for ${session.slice(0, 8)}: ${would}${r.uncommitted ? `; ${r.uncommitted} newer records are not committed` : ""}`);
      if (r.report) {
        out(`  redacted: ${list(r.report.counts)}`);
        out(`  withheld: ${list(r.report.withheld)}`);
        out(`  rules: built in${r.report.sources.map((s) => `, ${s}`).join("")}`);
        for (const p of r.report.problems) out(`  problem: ${p}`);
      }
      return 0;
    }
    case "fetch": {
      const repo = needRepo();
      const n = fetchSessions(repo, str("remote") ?? readConfig(repo).remote, { all: opts.all === true });
      if (!opts.quiet) out(`braid: fetched ${n} conversations`);
      return 0;
    }
    case "status": {
      const repo = needRepo();
      const remote = str("remote") ?? readConfig(repo).remote;
      const session = needSession(str("session"));
      const s = computeStatus(repo, session, remote);
      if (!isEnabled(repo)) {
        out("braid keeps no conversations here: run braid init");
        return 0;
      }
      out(`session ${session.slice(0, 8)}${s.conv ? ` (conversation ${s.conv.slice(0, 8)})` : ""}: ${render(s)}`);
      for (const w of s.waiting) out(`  waiting: ${w.name} (${w.session.slice(0, 8)}), ${w.count} records not merged, forked at ${w.base ?? "?"}`);
      if (s.conv) {
        out("sessions in this conversation:");
        for (const f of allSessions(repo, remote).filter((f) => f.conv === s.conv)) {
          const records = readRecords(f.ref, f.opts);
          const actor = records.map((r) => braidOf(r).actor).find(Boolean);
          const mark = f.session === session ? "  (this session)" : "";
          out(`  ${f.session.slice(0, 8)}  ${sessionName(records, f.session).padEnd(12)} ${actor?.actorId ?? "?"}  ${records.filter(isTurn).length} records${mark}`);
          for (const line of agentLines(records, readAgents(f.ref, f.opts))) out(`      ${line}`);
        }
      }
      return 0;
    }
    case "sessions": {
      const repo = needRepo();
      const remote = str("remote") ?? readConfig(repo).remote;
      for (const f of allSessions(repo, remote)) {
        const records = readRecords(f.ref, f.opts);
        const actor = records.map((r) => braidOf(r).actor).find(Boolean);
        const ran = f.opts.gitDir ? loadState(repo, f.session)?.code : undefined;
        out(`${f.session.slice(0, 8)}  conv ${f.conv.slice(0, 8)}  ${sessionName(records, f.session).padEnd(12)} ${actor?.actorId ?? "?"}  ${records.filter(isTurn).length} records${f.opts.gitDir ? `  (yours${ran ? `, in ${ran.replace(homedir(), "~")}` : ""})` : ""}`);
        for (const line of agentLines(records, readAgents(f.ref, f.opts))) out(`    ${line}`);
      }
      return 0;
    }
    case "log": {
      const repo = needRepo();
      const remote = str("remote") ?? readConfig(repo).remote;
      const found = resolve(repo, args[0] ?? needSession(str("session")), remote);
      if (found.length !== 1) throw new Error(found.length ? "more than one session matches" : "no such session");
      for (const p of found[0]!.opts.gitDir ? points(repo, found[0]!.session) : []) out(`${`@${p.n}`.padEnd(12)}  ${"fork".padEnd(9)} ${p.what}`);
      for (const r of readRecords(found[0]!.ref, found[0]!.opts)) {
        const code = r.type === "label" ? braidOf(r).code : undefined;
        const commit = r.type === "label" ? (braidOf(r).commit ?? code) : undefined;
        if (!isTurn(r) && !commit) continue;
        const kind = code ? "code" : commit ? "commit" : r.type === "branch_summary" ? "merge" : (r.role ?? r.type);
        const text = commit ? `${String(r.label)}${commit.sha ? ` (${commit.sha.slice(0, 7)})` : ""}` : describe(r, 160).split("\n")[0];
        out(`${r.id.slice(0, 12)}  ${kind.padEnd(9)} ${text}`);
      }
      return 0;
    }
    case "show": {
      const repo = needRepo();
      const remote = str("remote") ?? readConfig(repo).remote;
      if (!args[0]) throw new Error("usage: braid show <id|name|pr:N>");
      const found = resolve(repo, args[0], remote).filter((f) => f.session !== process.env.BRAID_SESSION);
      if (found.length === 0) throw new Error(`no session matches ${args[0]}; try braid fetch --all, then braid sessions`);
      for (const f of found) out(briefing(repo, f, remote).text);
      return 0;
    }
    case "fork": {
      const repo = needRepo();
      const remote = str("remote") ?? readConfig(repo).remote;
      const current = str("session") ?? process.env.BRAID_SESSION;
      const resume = (dir: string, id: string, fork: boolean) => `  cd ${shellWord(dir)} && claude --resume ${id}${fork ? " --fork-session" : ""}`;
      if (!args[0]) {
        if (!current) throw new Error("no session to branch: run inside an agent session, or pass --session <id>");
        const dir = launchDir(loadState(repo, current)?.transcript ?? readEntry(current)?.transcript) ?? process.cwd();
        out(["braid: to branch this conversation into a new window, run in a terminal:", resume(dir, current, true), "or /branch to branch it in this window. braid files the branch in this conversation."].join("\n"));
        return 0;
      }
      const at = /^(.*)@(\d+)$/.exec(args[0]);
      if (at) {
        // A fork point: the session as it stood before a big turn.
        const name = at[1] || current;
        if (!name) throw new Error("no session: name one, as in braid fork <id>@2, or run inside an agent session");
        const own = resolve(repo, name, remote).filter((f) => f.opts.gitDir);
        if (own.length !== 1) throw new Error(own.length ? `${name} matches ${own.length} sessions; name one` : `no session of yours matches ${name}`);
        const point = points(repo, own[0]!.session).find((p) => p.n === Number(at[2]));
        if (!point) throw new Error(`${own[0]!.session.slice(0, 8)} has no fork point @${at[2]}; braid log lists them`);
        const r = replay(repo, { ...own[0]!, ref: point.commit }, remote, { cwd: str("cwd") });
        out([`braid: wrote the conversation as it was ${point.what} as a new Claude Code session. To continue it in a new window, run in a terminal:`, resume(r.cwd, r.session, false)].join("\n"));
        return 0;
      }
      const found = resolve(repo, args[0], remote).filter((f) => f.session !== current);
      if (found.length === 0) throw new Error(`no session matches ${args[0]}; try braid fetch --all, then braid sessions`);
      const read = found.map((f) => ({ f, records: readRecords(f.ref, f.opts) }));
      const last = (x: (typeof read)[number]) => x.records.findLast(isTurn)?.time ?? "";
      const newest = read.reduce((a, b) => (last(b) > last(a) ? b : a));
      const from = newest.f;
      if (opts.here === true) {
        if (!current) throw new Error("no session to fork into: run inside an agent session, or pass --session <id>");
        // The others are read too, as a review of a pull request with several sessions needs; this one continues from the newest.
        for (const f of found.filter((f) => f !== from)) out(briefing(repo, f, remote).text);
        const b = briefing(repo, from, remote);
        out(b.text);
        markFork(repo, current, b);
        out(`braid: this session continues from ${from.session.slice(0, 8)} (${b.head.slice(0, 12)})`);
        return 0;
      }
      const name = sessionTitle(newest.records, from.session);
      const others = found.length > 1 ? [`braid: ${args[0]} has ${found.length} sessions; this is the newest. To fork another, name it: ${found.filter((f) => f !== from).map((f) => f.session.slice(0, 8)).join(", ")}`] : [];
      // Your own session, with its transcript on this machine: Claude Code forks it, with everything it holds.
      const own = from.opts.gitDir ? loadState(repo, from.session) : undefined;
      const dir = own?.harness === "claude-code" ? launchDir(own.transcript) : undefined;
      if (dir) {
        out([`braid: to fork ${name} into a new window, run in a terminal:`, resume(dir, from.session, true), ...others].join("\n"));
        return 0;
      }
      const r = replay(repo, from, remote, { cwd: str("cwd") });
      out([`braid: wrote ${name} as a new Claude Code session. To continue it in a new window, run in a terminal:`, resume(r.cwd, r.session, false), ...others].join("\n"));
      return 0;
    }
    case "import": {
      const repo = needRepo();
      if (args[0] !== "openclaw") throw new Error("usage: braid import openclaw [--session <key|id>] [--db <path>]");
      const dbs = str("db") ? [str("db")!] : openclawDatabases();
      if (dbs.length === 0) throw new Error("no OpenClaw database found under ~/.openclaw/agents; pass --db <path>");
      for (const db of dbs) {
        for (const r of importOpenclaw(repo, db, str("session"))) out(`braid: ${r.session.slice(0, 8)} ${r.name}: ${r.added ? `imported ${r.added} records` : "up to date"}`);
      }
      return 0;
    }
    case "merge": {
      const repo = needRepo();
      const remote = str("remote") ?? readConfig(repo).remote;
      const session = needSession(str("session"));
      const target = str("record") ?? str("skip") ?? args[0];
      const { waiting, chosen } = pick(repo, session, remote, target);
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
    case "review": {
      // A pull request, reviewed together with the sessions behind it.
      const target = args[0];
      if (!target) throw new Error("usage: braid review <pull request number>; to edit this session before a commit, braid edit");
      const pass = ["session", "remote"].flatMap((k) => (str(k) ? [`--${k}`, str(k)!] : []));
      return main(["fork", /^\d+$/.test(target) ? `pr:${target}` : target, "--here", ...pass]);
    }
    case "edit": {
      const repo = needRepo();
      const remote = str("remote") ?? readConfig(repo).remote;
      const session = editSession(repo, remote, str("session"));
      save(repo, session.id);
      const state = loadState(repo, session.id);
      if (!state || state.chunks === 0) throw new Error("this session is not saved yet");
      const v = view(repo, state, remote);
      const lines = editLines(repo, v, remote);
      const undo = opts.undo === true;
      const width = process.stdout.isTTY ? process.stdout.columns || 100 : 120;
      const edit = opts.all === true || opts.rewrite === true || str("last") !== undefined || str("hide") !== undefined || args.length > 0;
      if (!edit) {
        const text = renderEdit(v, lines, width).join("\n");
        const hint = session.explicit ? "" : `\n(newest session here; to edit it, add --session ${session.id.slice(0, 8)})`;
        page(`${text}${hint}\n`);
        return 0;
      }
      if (!session.explicit) throw new Error("name the session to edit: run inside an agent session, or pass --session <id>");
      if (opts.all === true) {
        setPrivate(repo, session.id, !undo);
        out(undo ? "braid: this session can be published again" : "braid: this session will not be published");
        return 0;
      }
      if (opts.rewrite === true) {
        const picked = pickLines(lines, args);
        if (picked.length !== 1) throw new Error("--rewrite takes one record number");
        const l = picked[0]!;
        if (undo) {
          editRecord(repo, v, l, undefined);
          out(`braid: ${l.num} is published with its own text again`);
          return 0;
        }
        const current = lineText(l);
        if (current === undefined) throw new Error(`${l.num} is a tool call, with no text to rewrite: withhold it (braid edit ${l.num}), or hide text in it (--hide)`);
        const typed = process.stdin.isTTY ? editInEditor(current) : readStdin();
        const next = typed.replace(/\s+$/, "");
        if (!next.trim()) {
          if (!process.stdin.isTTY) throw new Error("pipe the new text on stdin, or run braid edit --rewrite in a terminal to rewrite it in your editor");
          const w = withhold(repo, v, lines, [l], false);
          out(`braid: ${l.num} emptied, so withheld${w.changed.length > 1 ? ` with ${w.changed.length - 1} records that go with it` : ""}`);
          return 0;
        }
        if (next === current.replace(/\s+$/, "")) {
          out(`braid: ${l.num} unchanged`);
          return 0;
        }
        editRecord(repo, v, l, next);
        out(`braid: ${l.num} rewritten${l.published ? "; it is already published: the next push replaces the published copy (braid push does it now)" : ""}`);
        return 0;
      }
      const text = str("hide");
      const result = text !== undefined ? hide(repo, v, lines, text, undo) : str("last") !== undefined ? withholdRecent(repo, v, lines, duration(str("last")!), undo) : withhold(repo, v, lines, pickLines(lines, args), undo);
      const verb = text !== undefined ? (undo ? `shown again` : `hidden`) : undo ? "put back" : "withheld";
      const what = text !== undefined ? `${JSON.stringify(text)} ${verb} in ${result.changed.length} records` : `${result.changed.length} records ${verb}`;
      out(`braid: ${what}${result.changed.length ? ":" : ""}`);
      for (const l of result.changed.slice(0, 20)) out(`  ${l.num.padStart(4)} ${l.who.padEnd(7)}${l.text.slice(0, Math.max(20, width - 14))}`);
      if (result.changed.length > 20) out(`  … and ${result.changed.length - 20} more`);
      if (result.note) out(`braid: ${result.note}`);
      if (result.published) out(`braid: ${result.published} of them are already published: the next push replaces the published copy (braid push does it now). Anyone who fetched it keeps theirs.`);
      return 0;
    }
    case "verify": {
      // Saved as it happened, and loads back as it was saved: this session, one named, or all of them.
      const repo = needRepo();
      const remote = str("remote") ?? readConfig(repo).remote;
      const ids = opts.all === true ? allSessions(repo, remote).filter((f) => f.opts.gitDir).map((f) => f.session) : [editSession(repo, remote, args[0] ?? str("session")).id];
      let bad = 0;
      for (const id of ids) {
        const v = verify(repo, id, remote);
        bad += v.problems.length ? 1 : 0;
        const st = loadState(repo, id);
        if (st) saveState(repo, { ...st, verified: { ok: !v.problems.length, at: new Date().toISOString(), ...(v.problems.length ? { problems: v.problems } : {}) } });
        out(`braid verify ${id.slice(0, 8)}: ${v.problems.length ? `${v.problems.length} problems` : "ok"}`);
        for (const p of v.problems) out(`  ✗ ${p}`);
        for (const c of v.checked) out(`  ✓ ${c}`);
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

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`braid: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
