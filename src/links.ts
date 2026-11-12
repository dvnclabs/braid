// Which sessions are behind which code commits. Two sources, read together:
// Braid-Session trailers in commit messages, and the commit labels that each
// save writes into a session for the code commits made during it. The labels
// travel with published sessions, so repositories that forbid trailers
// (link = "store") still map commits to sessions.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readRecords } from "./chunks.ts";
import { forEachRef, gitMaybe } from "./git.ts";
import { braidOf } from "./records.ts";
import { remoteRefs, SESSION_REFS, type Repo } from "./repo.ts";
import { loadState } from "./state.ts";

const TRAILER = "Braid-Session";

/** Session ids named by trailers in a list of commits, given as git log arguments. */
export function trailerSessions(repo: Repo, logArgs: string[]): Set<string> {
  const log = gitMaybe(["log", `--format=%(trailers:key=${TRAILER},valueonly)`, ...logArgs], { cwd: repo.top }) ?? "";
  return new Set(log.split("\n").map((s) => s.trim()).filter(Boolean));
}

/** Commit SHAs of a list of commits, given as git log arguments. */
export function commitsOf(repo: Repo, logArgs: string[]): string[] {
  return (gitMaybe(["log", "--format=%H", ...logArgs], { cwd: repo.top }) ?? "").split("\n").filter(Boolean);
}

type IndexCache = Record<string, { sha: string; session: string; commits: string[] }>;

/**
 * Code commit → sessions, from the commit labels of every session braid can
 * see, plus commits noted by post-commit and not saved yet. Each ref's labels
 * are cached by the ref's sha, so only sessions that moved are read again.
 */
export function commitIndex(repo: Repo, remote: string): Map<string, Set<string>> {
  const cacheFile = join(repo.cache, "commits.json");
  let cache: IndexCache = {};
  try {
    cache = JSON.parse(readFileSync(cacheFile, "utf8")) as IndexCache;
  } catch {
    // no cache yet
  }
  const next: IndexCache = {};
  const refs = [
    ...forEachRef([SESSION_REFS], { gitDir: repo.store }).map((r) => ({ ...r, key: `store:${r.ref}`, opts: { gitDir: repo.store } })),
    ...forEachRef([remoteRefs(remote)], { cwd: repo.top }).map((r) => ({ ...r, key: r.ref, opts: { cwd: repo.top } })),
  ];
  for (const r of refs) {
    const hit = cache[r.key];
    if (hit?.sha === r.sha) {
      next[r.key] = hit;
      continue;
    }
    const commits = readRecords(r.ref, r.opts)
      .map((rec) => (rec.type === "label" ? (braidOf(rec).commit?.sha ?? braidOf(rec).code?.sha) : undefined))
      .filter((sha): sha is string => !!sha);
    next[r.key] = { sha: r.sha, session: r.ref.slice(r.ref.lastIndexOf("/") + 1), commits };
  }
  try {
    mkdirSync(repo.cache, { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(next));
  } catch {
    // a read-only checkout still answers
  }
  const index = new Map<string, Set<string>>();
  const add = (sha: string, session: string) => index.set(sha, (index.get(sha) ?? new Set()).add(session));
  for (const { session, commits } of Object.values(next)) for (const sha of commits) add(sha, session);
  const states = join(repo.dir, "sessions");
  for (const name of existsSync(states) ? readdirSync(states) : []) {
    const state = name.endsWith(".json") ? loadState(repo, name.slice(0, -".json".length)) : undefined;
    for (const sha of state?.commits ?? []) add(sha, state!.session);
  }
  return index;
}

/** The sessions behind a list of commits: by trailer and by commit label. */
export function sessionsBehind(repo: Repo, remote: string, logArgs: string[]): Set<string> {
  const out = trailerSessions(repo, logArgs);
  const index = commitIndex(repo, remote);
  for (const sha of commitsOf(repo, logArgs)) for (const s of index.get(sha) ?? []) out.add(s);
  return out;
}

/** Sessions behind commits given by SHA, such as a pull request's commits. */
export function sessionsFor(repo: Repo, remote: string, shas: string[]): Set<string> {
  const index = commitIndex(repo, remote);
  return new Set(shas.flatMap((sha) => [...(index.get(sha) ?? [])]));
}
