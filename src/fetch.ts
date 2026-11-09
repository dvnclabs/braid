// Fetching published sessions: only the conversations behind this branch and
// the user's own, never through remote.origin.fetch.
import { spawn } from "node:child_process";
import { mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { forEachRef, git, gitMaybe } from "./git.ts";
import { PUBLISHED_REFS, remoteRefs, SESSION_REFS, type Repo } from "./repo.ts";
import { withLock } from "./state.ts";

/** Session ids named by Braid-Session trailers in the last commits of HEAD. */
export function trailerSessions(repo: Repo, limit = 500): Set<string> {
  const log = gitMaybe(["log", "-n", String(limit), "--format=%(trailers:key=Braid-Session,valueonly)", "HEAD"], { cwd: repo.top }) ?? "";
  return new Set(log.split("\n").map((s) => s.trim()).filter(Boolean));
}

export function fetchSessions(repo: Repo, remote: string, opts: { all?: boolean } = {}): number {
  return withLock(repo, "fetch", () => {
    const wanted = new Set<string>();
    for (const { ref } of forEachRef([SESSION_REFS], { gitDir: repo.store })) wanted.add(ref.split("/")[2]!);
    const sessions = trailerSessions(repo);
    const listing = gitMaybe(["ls-remote", "--quiet", remote, `${PUBLISHED_REFS}/*`], { cwd: repo.top }) ?? "";
    for (const line of listing.split("\n").filter(Boolean)) {
      const parts = line.split("\t")[1]?.split("/") ?? [];
      const [conv, session] = [parts[3], parts[4]];
      if (conv && session && (opts.all || sessions.has(session) || wanted.has(conv))) wanted.add(conv);
    }
    if (wanted.size === 0) return 0;
    const specs = [...wanted].map((c) => `+${PUBLISHED_REFS}/${c}/*:${remoteRefs(remote)}/${c}/*`);
    git(["fetch", "--quiet", "--no-write-fetch-head", "--no-auto-gc", "--prune", remote, ...specs], { cwd: repo.top });
    return wanted.size;
  });
}

/** Starts a background fetch when the last one is older than `minutes`. */
export function fetchInBackground(repo: Repo, remote: string, minutes = 3): void {
  const stamp = join(repo.dir, "cache", "fetch");
  try {
    if (Date.now() - statSync(stamp).mtimeMs < minutes * 60_000) return;
  } catch {
    // never fetched
  }
  mkdirSync(join(repo.dir, "cache"), { recursive: true });
  writeFileSync(stamp, "");
  const now = new Date();
  utimesSync(stamp, now, now);
  const cli = process.argv[1];
  if (!cli) return;
  spawn(process.execPath, [cli, "fetch", "--quiet", "--remote", remote], { cwd: repo.top, detached: true, stdio: "ignore" }).unref();
}
