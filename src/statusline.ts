// `braid statusline`: Claude Code's status line command. Runs the user's previous
// status line command, if any, and appends braid's part.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchInBackground } from "./fetch.ts";
import { forEachRef, gitMaybe } from "./git.ts";
import { findRepo, isEnabled, locate, readConfig, remoteRefs, SESSION_REFS, type Repo } from "./repo.ts";
import { colors, computeStatus, convOf, render } from "./status.ts";
import { printable } from "./records.ts";
import { loadState } from "./state.ts";
import { configDir, isBraidLine } from "./setup.ts";

interface StatusInput {
  session_id?: string;
  cwd?: string;
  workspace?: { current_dir?: string };
}

const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

function previous(stdin: string): string {
  const file = join(configDir(), "statusline.json");
  if (!existsSync(file)) return "";
  const { previous } = JSON.parse(readFileSync(file, "utf8")) as { previous?: string };
  // braid never runs another braid's status line before its own.
  if (!previous || isBraidLine(previous)) return "";
  const r = spawnSync("sh", ["-c", previous], { input: stdin, encoding: "utf8", timeout: 3000 });
  return (r.stdout ?? "").trimEnd();
}

/** The pull request number of the current branch, cached for five minutes and refreshed in the background. */
function pullRequest(repo: Repo): string {
  if (process.env.BRAID_STATUS_NO_PR) return "";
  const branch = gitMaybe(["branch", "--show-current"], { cwd: repo.top })?.trim();
  if (!branch) return "";
  mkdirSync(repo.cache, { recursive: true });
  const file = join(repo.cache, `pr-${hash(branch)}`);
  let fresh = false;
  try {
    fresh = Date.now() - statSync(file).mtimeMs < 5 * 60_000;
  } catch {
    // not cached yet
  }
  if (!fresh) {
    writeFileSync(file, existsSync(file) ? readFileSync(file) : "");
    const tmp = `${file}.${process.pid}`;
    spawn("sh", ["-c", 'gh pr view --json number -q .number > "$T" 2>/dev/null; mv "$T" "$F"'], {
      cwd: repo.top,
      env: { ...process.env, T: tmp, F: file },
      detached: true,
      stdio: "ignore",
    }).unref();
  }
  const n = readFileSync(file, "utf8").trim();
  return /^\d{1,7}$/.test(n) ? `#${n}` : "";
}

/** braid's part, cached until a session ref of the conversation, HEAD, or the session's state changes. */
function braidPart(repo: Repo, session: string, remote: string): string {
  const conv = convOf(repo, session);
  const statePath = join(repo.dir, "sessions", `${session}.json`);
  const key = hash(
    [
      session,
      isEnabled(repo),
      conv,
      ...forEachRef([`${SESSION_REFS}/${conv ?? "-"}/`], { gitDir: repo.store }).map((r) => r.sha + r.ref),
      ...forEachRef([`${remoteRefs(remote)}/${conv ?? "-"}/`], { cwd: repo.top }).map((r) => r.sha + r.ref),
      gitMaybe(["rev-parse", "-q", "--verify", "HEAD"], { cwd: repo.top })?.trim(),
      existsSync(statePath) ? statSync(statePath).mtimeMs : 0,
      process.env.NO_COLOR ? "plain" : "color",
    ].join("\n"),
  );
  const file = join(repo.cache, `status-${key}`);
  if (existsSync(file)) return readFileSync(file, "utf8");
  const { paint, sep } = colors();
  const text = render(computeStatus(repo, session, remote), paint, sep);
  mkdirSync(repo.cache, { recursive: true });
  writeFileSync(file, text);
  return text;
}

export function statusline(stdin: string): string {
  let input: StatusInput = {};
  try {
    input = JSON.parse(stdin) as StatusInput;
  } catch {
    // not JSON: show nothing of ours
  }
  const prev = previous(stdin);
  const session = input.session_id;
  if (!session) return prev;
  const { sep, dim } = colors();
  // braid · 5b0e2c1a.12 · Webhook retries · local: the session's newest turn, by the name braid fork takes, and what it is about.
  let name = session.slice(0, 8);
  let title: string | undefined;
  const parts: string[] = [];
  const dir = input.workspace?.current_dir ?? input.cwd ?? process.cwd();
  const code = findRepo(dir);
  // On autopilot braid asks GitHub nothing, not even the pull request of the branch.
  const pr = code && !readConfig(code).autopilot ? pullRequest(code) : undefined;
  if (pr) parts.push(pr);
  const repo = locate(dir);
  if (repo) {
    const state = loadState(repo, session);
    if (state?.turn) name = `${name}.${state.turn}`;
    if (state?.title) title = printable(state.title.text, 40);
    const remote = readConfig(repo).remote;
    const part = braidPart(repo, session, remote);
    if (part) parts.push(part);
    fetchInBackground(repo, remote);
  }
  const ours = [dim("braid"), name, ...(title ? [title] : []), ...parts].join(sep);
  if (!prev) return ours;
  return prev.includes("\n") ? `${prev}\n${ours}` : `${prev} · ${ours}`;
}
