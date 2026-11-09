// braid command line. Hooks call it too, so hook commands never fail loudly.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { readRecords } from "./chunks.ts";
import { fetchSessions } from "./fetch.ts";
import { postCommit, prePush, prepareCommitMsg } from "./githooks.ts";
import { sessionEnd, sessionStart, stop } from "./hooks.ts";
import { allSessions, briefing, markLoaded, resolve } from "./load.ts";
import { publish, type PublishResult } from "./publish.ts";
import { braidOf, describe, isTurn } from "./records.ts";
import { findRepo, isEnabled, readConfig, storeRef, type Repo } from "./repo.ts";
import { save } from "./save.ts";
import { configDir, init, setup } from "./setup.ts";
import { loadState, saveState } from "./state.ts";
import { computeStatus, render, sessionName } from "./status.ts";
import { statusline } from "./statusline.ts";
import { context, pick, record } from "./sync.ts";
import { VERSION } from "./version.ts";

const HELP = `braid ${VERSION}: version control for agent conversations

Setup
  braid setup                 once per machine: the braid command and the status line
  braid init                  once per repository: .braid/config.toml and git hooks

Everyday (inside an agent session; the session comes from $BRAID_SESSION)
  braid status                where this session stands, and the sessions around it
  braid push                  publish this session now
  braid load <id|name|pr:N>   read another session as a briefing
  braid sync [<id|name>]      show what waits to be merged, for the agent to summarize
  braid sync --record <id> --instruction "<text>"   record a merge; summary on stdin
  braid sync --skip <id>      mark a session seen without adopting anything
  braid withhold --last 30m | --all   keep records, or the whole session, from being published

Other
  braid sessions              every session braid can see in this repository
  braid log <id>              the records of a session
  braid fetch [--all]         fetch published sessions
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
  return results.map((r) =>
    r.pushed
      ? `braid: published ${r.session.slice(0, 8)}, ${r.records} records${r.redactions ? `, ${r.redactions} secrets redacted` : ""}`
      : `braid: ${r.session.slice(0, 8)} not published: ${r.reason}`,
  );
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
      for (const note of init(repo)) out(`braid: ${note}`);
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
    case "push": {
      const repo = needRepo();
      const session = needSession(str("session"));
      save(repo, session);
      for (const line of summarize([publish(repo, session, { remote: str("remote"), force: opts.force === true })])) out(line);
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
      }
      return 0;
    }
    case "log": {
      const repo = needRepo();
      const remote = str("remote") ?? readConfig(repo).remote;
      const found = resolve(repo, args[0] ?? needSession(str("session")), remote);
      if (found.length !== 1) throw new Error(found.length ? "more than one session matches" : "no such session");
      for (const r of readRecords(found[0]!.ref, found[0]!.opts).filter(isTurn)) {
        out(`${r.id.slice(0, 12)}  ${(r.role ?? "merge").padEnd(9)} ${describe(r, 160).split("\n")[0]}`);
      }
      return 0;
    }
    case "load": {
      const repo = needRepo();
      const remote = str("remote") ?? readConfig(repo).remote;
      if (!args[0]) throw new Error("usage: braid load <id|name|pr:N>");
      const found = resolve(repo, args[0], remote);
      if (found.length === 0) throw new Error(`no session matches ${args[0]}; try braid fetch --all, then braid sessions`);
      const current = process.env.BRAID_SESSION;
      const others = found.filter((f) => f.session !== current);
      for (const f of others) {
        const b = briefing(repo, f, remote);
        out(b.text);
        if (current && others.length === 1) markLoaded(repo, current, b);
      }
      return 0;
    }
    case "sync": {
      const repo = needRepo();
      const remote = str("remote") ?? readConfig(repo).remote;
      const session = needSession(str("session"));
      const target = str("record") ?? str("skip") ?? args[0];
      const { waiting, chosen } = pick(repo, session, remote, target);
      if (!chosen) {
        if (waiting.length === 0) out("braid: nothing waiting to be merged into this session");
        else out(["braid: several sessions are waiting; name one:", ...waiting.map((w) => `  ${w.session.slice(0, 8)} ${w.name} +${w.count}`)].join("\n"));
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
        out(context(repo, session, remote, chosen));
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
      const ids = readRecords(storeRef(state.conv, session), { gitDir: repo.store })
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
