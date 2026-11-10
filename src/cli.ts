// braid command line. Hooks call it too, so hook commands never fail loudly.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
import { editRecord, hide, lineText, pickLines, renderReview, reviewLines, setPrivate, withhold, withholdRecent } from "./review.ts";
import { importOpenclaw, openclawDatabases } from "./openclaw.ts";
import { publish, view, type PublishResult } from "./publish.ts";
import { braidOf, describe, isTurn, type Rec } from "./records.ts";
import { findRepo, isEnabled, readConfig, type Repo } from "./repo.ts";
import { save } from "./save.ts";
import { configDir, init, setup } from "./setup.ts";
import { loadState, saveState } from "./state.ts";
import { cleanName, computeStatus, render, sessionName, sessionTitle } from "./status.ts";
import { statusline } from "./statusline.ts";
import { VERSION } from "./version.ts";

const HELP = `braid ${VERSION}: version control for agent conversations

Setup
  braid setup                 once per machine: the braid command and the status line
  braid init                  once per repository: .braid/config.toml, .braidignore and git hooks
    [--no-git-hooks] [--autocommit|--no-autocommit] [--autopush|--no-autopush]   change the settings

Everyday (inside an agent session; the session comes from $BRAID_SESSION)
  braid status                where this session stands, and the sessions around it
  braid review                this session as git push would publish it, one numbered line per record
  braid review 4 7-9 12.3     withhold records (a tool call takes its result, a subagent all its records)
  braid review --edit 5        rewrite a record's text in your editor (or from stdin); empty it to withhold it
  braid review --text "<s>"   hide text everywhere in this session
  braid review --undo ...     put back records, text (--undo --text), a record's own text (--undo --edit 5) or the session (--undo --all)
  braid review --last 30m | --all   withhold recent records, or the whole session
  braid commit -m "<message>" commit the conversation: git push publishes up to the last commit
  braid push [--dry-run]      publish the committed part now (git push does this with autopush); --dry-run shows what would go
  braid fork [<id|name|pr:N>] the command to continue a session in a new window; with no target, this one
  braid fork <target> --here  continue from another session in this one, before its first turn is saved
  braid merge [<id|name|pr:N>]   show what another session has that this one lacks, for the agent to summarize
  braid merge --record <id> --instruction "<text>"   record a merge; summary on stdin
  braid merge --skip <id>     mark a session seen without adopting anything

Other
  braid show <id|name|pr:N>   read a session as a briefing, without linking to it
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

/** The session to review: named, the agent's own, or else the newest saved here (for reading only). */
function reviewSession(repo: Repo, remote: string, flag: string | undefined): { id: string; explicit: boolean } {
  const named = flag ?? process.env.BRAID_SESSION;
  if (named) {
    const own = resolve(repo, named, remote).filter((f) => f.opts.gitDir);
    if (own.length === 1) return { id: own[0]!.session, explicit: true };
    if (own.length > 1) throw new Error(`${named} matches ${own.length} of your sessions; name one`);
    return { id: named, explicit: true };
  }
  const dir = join(repo.dir, "sessions");
  const newest = (existsSync(dir) ? readdirSync(dir) : [])
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ id: f.slice(0, -".json".length), at: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.at - a.at)[0];
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
      text: { type: "string" },
      edit: { type: "boolean" },
      here: { type: "boolean" },
      autocommit: { type: "boolean" },
      "no-autocommit": { type: "boolean" },
      autopush: { type: "boolean" },
      "no-autopush": { type: "boolean" },
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
      const toggle = (key: string) => (opts[`no-${key}`] === true ? false : opts[key] === true ? true : undefined);
      for (const note of init(repo, { "git-hooks": toggle("git-hooks"), autocommit: toggle("autocommit"), autopush: toggle("autopush") })) out(`braid: ${note}`);
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
      const repo = needRepo();
      const remote = str("remote") ?? readConfig(repo).remote;
      const session = reviewSession(repo, remote, str("session"));
      save(repo, session.id);
      const state = loadState(repo, session.id);
      if (!state || state.chunks === 0) throw new Error("this session is not saved yet");
      const v = view(repo, state, remote);
      const lines = reviewLines(repo, v, remote);
      const undo = opts.undo === true;
      const width = process.stdout.isTTY ? process.stdout.columns || 100 : 120;
      const edit = opts.all === true || opts.edit === true || str("last") !== undefined || str("text") !== undefined || args.length > 0;
      if (!edit) {
        const text = renderReview(v, lines, width).join("\n");
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
      if (opts.edit === true) {
        const picked = pickLines(lines, args);
        if (picked.length !== 1) throw new Error("--edit takes one record number");
        const l = picked[0]!;
        if (undo) {
          editRecord(repo, v, l, undefined);
          out(`braid: ${l.num} is published with its own text again`);
          return 0;
        }
        const current = lineText(l);
        if (current === undefined) throw new Error(`${l.num} is a tool call, with no text to edit: withhold it (braid review ${l.num}), or hide text in it (--text)`);
        const typed = process.stdin.isTTY ? editInEditor(current) : readStdin();
        const next = typed.replace(/\s+$/, "");
        if (!next.trim()) {
          if (!process.stdin.isTTY) throw new Error("pipe the new text on stdin, or run braid review --edit in a terminal to edit it in your editor");
          const w = withhold(repo, v, lines, [l], false);
          out(`braid: ${l.num} emptied, so withheld${w.changed.length > 1 ? ` with ${w.changed.length - 1} records that go with it` : ""}`);
          return 0;
        }
        if (next === current.replace(/\s+$/, "")) {
          out(`braid: ${l.num} unchanged`);
          return 0;
        }
        editRecord(repo, v, l, next);
        out(`braid: ${l.num} edited${l.published ? "; it is already published: the next push replaces the published copy (braid push does it now)" : ""}`);
        return 0;
      }
      const text = str("text");
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
