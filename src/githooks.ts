// Git hooks: link commits to sessions, and publish sessions on push.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { config, git, gitMaybe } from "./git.ts";
import { publish, type PublishResult } from "./publish.ts";
import { readEntry, recordSession } from "./registry.ts";
import { register, save } from "./save.ts";
import { isEnabled, readConfig, type Repo } from "./repo.ts";
import { loadState, saveState, withLock } from "./state.ts";

const MARK = "# braid hook";
export const HOOKS = ["prepare-commit-msg", "post-commit", "pre-push"] as const;

// pre-push is the only hook git feeds on stdin; reading stdin in the others
// would block on a terminal.
function script(hook: string): string {
  const stdin = hook === "pre-push";
  return `#!/bin/sh
${MARK}: runs the hook it replaced (kept as ${hook}.local), then braid.
${stdin ? "input=$(cat)\n" : ""}if [ -x "$0.local" ]; then
  ${stdin ? 'printf \'%s\\n\' "$input" | ' : ""}"$0.local" "$@" || exit $?
fi
cli="\${XDG_CONFIG_HOME:-$HOME/.config}/braid/cli"
if command -v braid >/dev/null 2>&1; then set -- braid git-hook ${hook} "$@"
elif [ -f "$cli" ]; then set -- node "$(cat "$cli")" git-hook ${hook} "$@"
else exit 0
fi
${stdin ? 'printf \'%s\\n\' "$input" | "$@"' : '"$@" || true'}
`;
}

export function hooksDir(repo: Repo): { dir: string; managed: boolean } {
  const custom = config("core.hooksPath", { cwd: repo.top });
  if (custom) return { dir: isAbsolute(custom) ? custom : join(repo.top, custom), managed: true };
  return { dir: join(repo.common, "hooks"), managed: false };
}

export function hooksInstalled(repo: Repo): boolean {
  const { dir } = hooksDir(repo);
  return HOOKS.every((h) => existsSync(join(dir, h)) && readFileSync(join(dir, h), "utf8").includes(MARK));
}

/** Installs braid's git hooks, keeping any existing hook as <name>.local. */
export function installHooks(repo: Repo): string[] {
  const { dir, managed } = hooksDir(repo);
  if (managed) {
    return [
      `core.hooksPath is set to ${dir}, so braid did not install its hooks there.`,
      `Add these lines to your hook manager's ${HOOKS.join(", ")} hooks:`,
      ...HOOKS.map((h) => `  ${h}: braid git-hook ${h} "$@"${h === "pre-push" ? "   (pass stdin through)" : ""}`),
    ];
  }
  mkdirSync(dir, { recursive: true });
  const notes: string[] = [];
  for (const hook of HOOKS) {
    const path = join(dir, hook);
    if (existsSync(path) && !readFileSync(path, "utf8").includes(MARK)) {
      if (!existsSync(`${path}.local`)) {
        renameSync(path, `${path}.local`);
        notes.push(`kept your ${hook} hook as ${hook}.local; braid runs it first`);
      }
    }
    writeFileSync(path, script(hook));
    chmodSync(path, 0o755);
  }
  return notes;
}

/** Removes braid's git hooks and puts back the hooks they replaced. */
export function uninstallHooks(repo: Repo): string[] {
  const { dir, managed } = hooksDir(repo);
  if (managed) return [`core.hooksPath is set to ${dir}: remove the braid git-hook lines from your hook manager`];
  const notes: string[] = [];
  for (const hook of HOOKS) {
    const path = join(dir, hook);
    if (!existsSync(path) || !readFileSync(path, "utf8").includes(MARK)) continue;
    rmSync(path);
    if (existsSync(`${path}.local`)) renameSync(`${path}.local`, path);
    notes.push(`removed the ${hook} hook`);
  }
  return notes;
}

/** The git hooks act only where braid is set up and git-hooks is on. */
const active = (repo: Repo) => isEnabled(repo) && readConfig(repo).gitHooks;

/**
 * The agent session running git here, registered in this repository. A
 * session that started in another repository is adopted the first time it
 * commits here, so it is saved and published here too.
 */
function agentSession(repo: Repo): string | undefined {
  const session = process.env.BRAID_SESSION;
  if (!session || !active(repo)) return undefined;
  if (loadState(repo, session)) return session;
  const transcript = readEntry(session)?.transcript;
  if (!transcript) return undefined;
  register(repo, session, transcript);
  recordSession(session, { repo: repo.top });
  return session;
}

/** prepare-commit-msg: adds the Braid-Session trailer for the agent session that runs git. */
export function prepareCommitMsg(repo: Repo, file: string): void {
  const session = agentSession(repo);
  if (!session) return;
  git(["interpret-trailers", "--in-place", "--if-exists", "addIfDifferent", "--trailer", `Braid-Session: ${session}`, file], {
    cwd: repo.top,
  });
}

/** post-commit: remembers the commit, so the next save commits the conversation with it. */
export function postCommit(repo: Repo): void {
  const session = agentSession(repo);
  if (!session) return;
  withLock(repo, `save-${session}`, () => {
    const state = loadState(repo, session);
    if (!state) return;
    const head = gitMaybe(["rev-parse", "HEAD"], { cwd: repo.top })?.trim();
    if (head) state.commits = [...(state.commits ?? []), head];
    saveState(repo, state);
  });
}

const ZERO = /^0+$/;

/**
 * pre-push: publishes the sessions named by trailers in the commits being
 * pushed. Refuses pushes that would delete published sessions.
 */
export function prePush(repo: Repo, remote: string, stdin: string): { refuse?: string; results: PublishResult[] } {
  const sessions = new Set<string>();
  for (const line of stdin.split("\n").filter(Boolean)) {
    const [, localSha = "", remoteRef = "", remoteSha = ""] = line.split(" ");
    if (remoteRef.startsWith("refs/braid/")) {
      if (ZERO.test(localSha)) return { refuse: `braid: refusing to delete ${remoteRef}`, results: [] };
      continue;
    }
    if (ZERO.test(localSha)) continue;
    const known = !ZERO.test(remoteSha) && gitMaybe(["cat-file", "-e", remoteSha], { cwd: repo.top }) !== undefined;
    const range = known ? [`${remoteSha}..${localSha}`] : [localSha, "--not", `--remotes=${remote}`];
    const log = gitMaybe(["log", "--format=%(trailers:key=Braid-Session,valueonly)", ...range], { cwd: repo.top }) ?? "";
    for (const id of log.split("\n").map((s) => s.trim()).filter(Boolean)) sessions.add(id);
  }
  if (!active(repo) || readConfig(repo).publish === "off") return { results: [] };
  // Save first, so the published copy holds the session up to this push.
  const results = [...sessions].filter((s) => loadState(repo, s)).map((s) => (save(repo, s), publish(repo, s, { remote })));
  return { results };
}
