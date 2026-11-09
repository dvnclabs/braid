// `braid statusline`: Claude Code's status line command. Runs the user's previous
// status line command, if any, and appends braid's part.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchInBackground } from "./fetch.ts";
import { forEachRef, gitMaybe } from "./git.ts";
import { findRepo, isEnabled, readConfig, remoteRefs, SESSION_REFS, type Repo } from "./repo.ts";
import { computeStatus, convOf, render } from "./status.ts";
import { configDir } from "./setup.ts";

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
  if (!previous) return "";
  const r = spawnSync("sh", ["-c", previous], { input: stdin, encoding: "utf8", timeout: 3000 });
  return (r.stdout ?? "").trimEnd();
}

/** The pull request number of the current branch, cached for five minutes and refreshed in the background. */
function pullRequest(repo: Repo): string {
  if (process.env.BRAID_STATUS_NO_PR) return "";
  const branch = gitMaybe(["branch", "--show-current"], { cwd: repo.top })?.trim();
  if (!branch) return "";
  const dir = join(repo.dir, "cache");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `pr-${hash(branch)}`);
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
    ].join("\n"),
  );
  const file = join(repo.dir, "cache", `status-${key}`);
  if (existsSync(file)) return readFileSync(file, "utf8");
  const text = render(computeStatus(repo, session, remote));
  mkdirSync(join(repo.dir, "cache"), { recursive: true });
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
  const parts = [session.slice(0, 8)];
  const repo = findRepo(input.workspace?.current_dir ?? input.cwd ?? process.cwd());
  if (repo) {
    const pr = pullRequest(repo);
    if (pr) parts.push(pr);
    if (isEnabled(repo)) {
      const remote = readConfig(repo).remote;
      const part = braidPart(repo, session, remote);
      if (part) parts.push(part);
      fetchInBackground(repo, remote);
    }
  }
  const ours = parts.join(" · ");
  if (!prev) return ours;
  return prev.includes("\n") ? `${prev}\n${ours}` : `${prev} · ${ours}`;
}
