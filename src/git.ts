// Thin wrappers over git plumbing. braid never links libgit2; everything goes
// through the git binary the user already has.
import { spawnSync } from "node:child_process";

export interface GitOptions {
  /** Working directory, for commands that act on a checkout. */
  cwd?: string;
  /** Repository to act on directly, for bare repositories such as the store. */
  gitDir?: string;
  input?: string;
  env?: NodeJS.ProcessEnv;
}

export class GitError extends Error {
  readonly args: string[];
  readonly status: number | null;
  readonly stderr: string;

  constructor(args: string[], status: number | null, stderr: string) {
    super(`git ${args.join(" ")} failed (${status}): ${stderr.trim()}`);
    this.args = args;
    this.status = status;
    this.stderr = stderr;
  }
}

// Commits braid writes into session refs are data, so they carry a fixed
// identity and never depend on the user's git configuration.
const IDENTITY = {
  GIT_AUTHOR_NAME: "braid",
  GIT_AUTHOR_EMAIL: "braid@localhost",
  GIT_COMMITTER_NAME: "braid",
  GIT_COMMITTER_EMAIL: "braid@localhost",
};

export function run(args: string[], opts: GitOptions) {
  const full = opts.gitDir ? ["--git-dir", opts.gitDir, ...args] : args;
  return spawnSync("git", full, {
    cwd: opts.cwd,
    input: opts.input,
    env: { ...process.env, ...IDENTITY, ...opts.env },
    encoding: "utf8",
    maxBuffer: 1 << 30,
  });
}

/** Runs git and returns stdout. Throws GitError on a non-zero exit. */
export function git(args: string[], opts: GitOptions = {}): string {
  const r = run(args, opts);
  if (r.status !== 0) throw new GitError(args, r.status, r.stderr ?? "");
  return r.stdout;
}

/** Runs git and returns stdout, or undefined on a non-zero exit. */
export function gitMaybe(args: string[], opts: GitOptions = {}): string | undefined {
  const r = run(args, opts);
  return r.status === 0 ? r.stdout : undefined;
}

export function revParse(ref: string, opts: GitOptions): string | undefined {
  return gitMaybe(["rev-parse", "-q", "--verify", `${ref}^{commit}`], opts)?.trim() || undefined;
}

export interface RefEntry {
  ref: string;
  sha: string;
}

export function forEachRef(patterns: string[], opts: GitOptions): RefEntry[] {
  const out = gitMaybe(["for-each-ref", "--format=%(objectname) %(refname)", ...patterns], opts) ?? "";
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf(" ");
      return { sha: line.slice(0, i), ref: line.slice(i + 1) };
    });
}

export interface TreeEntry {
  mode: string;
  type: "blob" | "tree";
  sha: string;
  name: string;
}

export function lsTree(treeish: string, opts: GitOptions): TreeEntry[] {
  const out = gitMaybe(["ls-tree", "-z", treeish], opts) ?? "";
  return out
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      const [mode, type, sha] = line.slice(0, tab).split(" ") as [string, "blob" | "tree", string];
      return { mode, type, sha, name: line.slice(tab + 1) };
    });
}

export function writeBlob(content: string, opts: GitOptions): string {
  return git(["hash-object", "-w", "--stdin"], { ...opts, input: content }).trim();
}

export function mktree(entries: TreeEntry[], opts: GitOptions): string {
  const input = entries.map((e) => `${e.mode} ${e.type} ${e.sha}\t${e.name}\0`).join("");
  return git(["mktree", "-z"], { ...opts, input }).trim();
}

export function commitTree(tree: string, parents: string[], message: string, opts: GitOptions): string {
  const args = ["commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-m", message];
  return git(args, opts).trim();
}

/** Moves ref to sha, failing when it no longer points at old (compare and swap). */
export function updateRef(ref: string, sha: string, old: string | undefined, opts: GitOptions): void {
  git(["update-ref", ref, sha, old ?? ""], opts);
}

/** Reads many blobs in one process: specs are `<treeish>:<path>` or object ids. */
export function catBlobs(specs: string[], opts: GitOptions): string[] {
  if (specs.length === 0) return [];
  const full = opts.gitDir ? ["--git-dir", opts.gitDir, "cat-file", "--batch"] : ["cat-file", "--batch"];
  const r = spawnSync("git", full, {
    cwd: opts.cwd,
    input: specs.join("\n") + "\n",
    env: { ...process.env, ...IDENTITY },
    maxBuffer: 1 << 30,
  });
  if (r.status !== 0) throw new GitError(["cat-file", "--batch"], r.status, r.stderr?.toString() ?? "");
  const buf = r.stdout;
  const out: string[] = [];
  let pos = 0;
  for (let i = 0; i < specs.length; i++) {
    const nl = buf.indexOf(0x0a, pos);
    const header = buf.subarray(pos, nl).toString("utf8");
    pos = nl + 1;
    if (header.endsWith(" missing")) {
      out.push("");
      continue;
    }
    const size = Number(header.split(" ")[2]);
    out.push(buf.subarray(pos, pos + size).toString("utf8"));
    pos += size + 1;
  }
  return out;
}

export function config(key: string, opts: GitOptions): string | undefined {
  return gitMaybe(["config", "--get", key], opts)?.trim() || undefined;
}
