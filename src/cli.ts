// braid command line. Hooks call it too, so hook commands never fail loudly.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { readAgents, readRecords } from "./chunks.ts";
import { fetchSessions } from "./fetch.ts";
import { postCommit, postRewrite, prePush, prepareCommitMsg } from "./githooks.ts";
import { sessionEnd, sessionStart, stop } from "./hooks.ts";
import { allSessions, briefing, markFork, resolve, type Briefing } from "./load.ts";
import { context, pick, record } from "./merge.ts";
import { replay } from "./replay.ts";
import { importOpenclaw, openclawDatabases } from "./openclaw.ts";
import { publish, type PublishResult } from "./publish.ts";
import { braidOf, describe, isTurn, type Rec } from "./records.ts";
import { findRepo, isEnabled, readConfig, storeRef, type Repo } from "./repo.ts";
import { save } from "./save.ts";
import { configDir, init, setup } from "./setup.ts";
import { loadState, saveState } from "./state.ts";
import { cleanName, computeStatus, render, sessionName } from "./status.ts";
import { statusline } from "./statusline.ts";
import { VERSION } from "./version.ts";

const HELP = `braid ${VERSION}: version control for agent conversations

Setup
  braid setup                 once per machine: the braid command and the status line
  braid init [--no-git-hooks] [--publish off]   once per repository: .braid/config.toml, and git hooks unless turned off

Everyday (inside an agent session; the session comes from $BRAID_SESSION)
  braid status                where this session stands, and the sessions around it
  braid commit -m "<message>" commit the conversation (git commits do this when git-hooks is on)
  braid push [--dry-run]      publish this session (git push does this when git-hooks is on); --dry-run shows what would go
  braid fork [<id|name|pr:N>] start this new session from another; with no target, how to branch this one
  braid merge [<id|name|pr:N>]   show what another session has that this one lacks, for the agent to summarize
  braid merge --record <id> --instruction "<text>"   record a merge; summary on stdin
  braid merge --skip <id>     mark a session seen without adopting anything
  braid withhold --last 30m | --all   keep records, or the whole session, from being published

Other
  braid show <id|name|pr:N>   read a session as a briefing, without linking to it
  braid replay <id> [--cwd <path>]   write a session out as a new Claude Code session to resume, here or on another machine
  braid sessions              every session braid can see in this repository
  braid log [<id>]            the turns and commits of a session
  braid fetch [--all]         fetch published sessions
  braid import openclaw [--session <key|id>] [--db <path>]   import OpenClaw sessions into this repository
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

function needRepo(): Repo {
  const repo = findRepo(process.cwd());
  if (!repo) throw new Error("not inside a git repository");
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
      ? `braid: published ${r.session.slice(0, 8)}, ${r.records} records${r.redactions ? `, ${r.redactions} secrets redacted` : ""}`
      : `braid: ${r.session.slice(0, 8)} not published: ${r.reason}`,
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
      publish: { type: "string" },
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
      const repo = needRepo();
      const gitHooks = opts["no-git-hooks"] === true ? false : opts["git-hooks"] === true ? true : undefined;
      const publishOpt = str("publish");
      if (publishOpt !== undefined && publishOpt !== "on-push" && publishOpt !== "off") throw new Error('--publish takes "on-push" or "off"');
      for (const note of init(repo, { gitHooks, publish: publishOpt })) out(`braid: ${note}`);
      return 0;
    }
    case "setup":
      for (const note of setup({ undo: opts.undo === true })) out(`braid: ${note}`);
      return 0;
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
      out(`braid: committed ${r.state.session.slice(0, 8)}: ${message.trim()}`);
      return 0;
    }
    case "push": {
      const repo = needRepo();
      const session = needSession(str("session"));
      save(repo, session);
      const r = publish(repo, session, { remote: str("remote"), force: opts.force === true, dryRun: opts["dry-run"] === true });
      if (!opts["dry-run"]) {
        for (const line of summarize([r])) out(line);
        return 0;
      }
      const list = (m: Map<string, number>) => [...m].map(([k, n]) => `${k} ${n}`).join(", ") || "none";
      const would = r.reason === "dry run" ? `would publish ${r.records} records` : `would not publish: ${r.reason}`;
      out(`braid: dry run for ${session.slice(0, 8)}: ${would}`);
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
        out("braid is not set up in this repository: run braid init");
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
        out(`${f.session.slice(0, 8)}  conv ${f.conv.slice(0, 8)}  ${sessionName(records, f.session).padEnd(12)} ${actor?.actorId ?? "?"}  ${records.filter(isTurn).length} records${f.opts.gitDir ? "  (yours)" : ""}`);
        for (const line of agentLines(records, readAgents(f.ref, f.opts))) out(`    ${line}`);
      }
      return 0;
    }
    case "log": {
      const repo = needRepo();
      const remote = str("remote") ?? readConfig(repo).remote;
      const found = resolve(repo, args[0] ?? needSession(str("session")), remote);
      if (found.length !== 1) throw new Error(found.length ? "more than one session matches" : "no such session");
      for (const r of readRecords(found[0]!.ref, found[0]!.opts)) {
        const commit = r.type === "label" ? braidOf(r).commit : undefined;
        if (!isTurn(r) && !commit) continue;
        const kind = commit ? "commit" : r.type === "branch_summary" ? "merge" : (r.role ?? r.type);
        const text = commit ? `${String(r.label)}${commit.sha ? ` (${commit.sha.slice(0, 7)})` : ""}` : describe(r, 160).split("\n")[0];
        out(`${r.id.slice(0, 12)}  ${kind.padEnd(9)} ${text}`);
      }
      return 0;
    }
    case "show":
    case "fork": {
      const repo = needRepo();
      const remote = str("remote") ?? readConfig(repo).remote;
      const current = str("session") ?? process.env.BRAID_SESSION;
      if (!args[0]) {
        if (command === "show") throw new Error("usage: braid show <id|name|pr:N>");
        out(
          [
            "braid: to branch this conversation, run /branch in Claude Code, or from a terminal:",
            `  claude --resume ${current ?? "<session id>"} --fork-session`,
            "braid records the branch in this conversation when its first turn is saved.",
          ].join("\n"),
        );
        return 0;
      }
      const found = resolve(repo, args[0], remote).filter((f) => f.session !== current);
      if (found.length === 0) throw new Error(`no session matches ${args[0]}; try braid fetch --all, then braid sessions`);
      const briefings = found.map((f) => briefing(repo, f, remote));
      for (const b of briefings) out(b.text);
      if (command === "fork") {
        if (!current) throw new Error("no session to fork into: run inside an agent session, or pass --session <id>");
        const newest = (b: Briefing) => readRecords(b.found.ref, b.found.opts).findLast((r) => r.id === b.head)?.time ?? "";
        const from = briefings.reduce((a, b) => (newest(b) > newest(a) ? b : a));
        markFork(repo, current, from);
        out(`braid: this session continues from ${from.found.session.slice(0, 8)} (${from.head.slice(0, 12)})`);
      }
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
    case "replay": {
      const repo = needRepo();
      const remote = str("remote") ?? readConfig(repo).remote;
      if (!args[0]) throw new Error("usage: braid replay <id|name> [--cwd <path>]");
      const found = resolve(repo, args[0], remote);
      if (found.length !== 1) throw new Error(found.length ? `${args[0]} matches ${found.length} sessions; name one` : `no session matches ${args[0]}; try braid fetch --all`);
      const r = replay(repo, found[0]!, remote, { cwd: str("cwd") });
      out(`braid: wrote session ${r.session} (${r.records} lines) to ${r.file}`);
      out(`braid: resume it from ${r.cwd} with: claude --resume ${r.session}`);
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
    case "withhold": {
      const repo = needRepo();
      const session = needSession(str("session"));
      save(repo, session);
      const state = loadState(repo, session);
      if (!state) throw new Error("this session is not saved yet");
      if (opts.all === true) {
        state.private = true;
        saveState(repo, state);
        out("braid: this session will not be published");
        return 0;
      }
      const cutoff = Date.now() - duration(str("last") ?? "");
      const ref = storeRef(state.conv, session);
      const ids = [...readRecords(ref, { gitDir: repo.store }), ...[...readAgents(ref, { gitDir: repo.store }).values()].flat()]
        .filter((r) => r.time && Date.parse(r.time) >= cutoff)
        .map((r) => r.id);
      state.withheld = [...new Set([...(state.withheld ?? []), ...ids])];
      saveState(repo, state);
      out(`braid: ${ids.length} records withheld from publishing`);
      return 0;
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
