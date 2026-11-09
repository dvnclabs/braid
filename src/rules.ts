// Team and personal publishing rules: terms and patterns to redact, and paths
// whose records are withheld. They come from the user's own
// ~/.config/braid/redact.toml and from .braid/redact.toml on the default
// branch, never from the branch being worked on or reviewed.
//
//   terms = ["Acme Corp", "Project Falcon"]     # literal, any case
//   patterns = ['CUST-\d{6}']                   # regular expressions
//   withhold = ["customers/**", "*.pem"]        # tool calls on these paths, and their results
//   withhold-session = false                    # true: a match withholds the whole session
//   withhold-gitignored = true                  # tool calls on files git ignores; false turns it off
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import { gitMaybe } from "./git.ts";
import type { Rec } from "./records.ts";
import type { Rule } from "./redact.ts";
import type { Repo } from "./repo.ts";
import { configDir } from "./repo.ts";

export interface Rules {
  redact: Rule[];
  withhold: { glob: string; re: RegExp }[];
  withholdSession: boolean;
  /** Withhold tool calls on files git ignores, such as .env: they are not in the repository, so a session is their only way out. */
  withholdIgnored: boolean;
  /** Where the rules came from, for --dry-run. */
  sources: string[];
  /** Rules that could not be used, such as an invalid pattern. */
  problems: string[];
}

/** Reads `key = [...]` string arrays (over several lines too) and `key = true|false` from a small TOML file. */
export function parseToml(text: string): Record<string, string[] | boolean> {
  const out: Record<string, string[] | boolean> = {};
  const clean = text.replace(/^\s*#.*$/gm, "");
  for (const m of clean.matchAll(/^\s*([A-Za-z0-9_-]+)\s*=\s*(\[[\s\S]*?\]|true|false)/gm)) {
    const [, key, value] = m as unknown as [string, string, string];
    if (value === "true" || value === "false") {
      out[key] = value === "true";
      continue;
    }
    const items: string[] = [];
    for (const s of value.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)) {
      if (s[2] !== undefined) items.push(s[2]);
      else {
        try {
          items.push(JSON.parse(`"${s[1]}"`) as string);
        } catch {
          // not a valid basic string
        }
      }
    }
    out[key] = items;
  }
  return out;
}

/** A glob as a regular expression: `**` crosses directories, `*` and `?` do not. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // A glob without a slash matches a file name in any directory, as in .gitignore.
  return new RegExp(glob.includes("/") ? `^/?${re}$` : `(?:^|/)${re}$`);
}

/** The default branch, as a ref this clone has: the remote's HEAD, else main or master. */
function defaultBranch(repo: Repo, remote: string): string | undefined {
  const head = gitMaybe(["symbolic-ref", "-q", `refs/remotes/${remote}/HEAD`], { cwd: repo.top })?.trim();
  for (const ref of [head, `refs/remotes/${remote}/main`, `refs/remotes/${remote}/master`, "refs/heads/main", "refs/heads/master"]) {
    if (ref && gitMaybe(["rev-parse", "-q", "--verify", `${ref}^{commit}`], { cwd: repo.top })) return ref;
  }
  return undefined;
}

export function loadRules(repo: Repo, remote: string): Rules {
  const rules: Rules = { redact: [], withhold: [], withholdSession: false, withholdIgnored: true, sources: [], problems: [] };
  const texts: [string, string][] = [];
  const own = join(configDir(), "redact.toml");
  if (existsSync(own)) texts.push([own.replace(process.env.HOME ?? "\0", "~"), readFileSync(own, "utf8")]);
  const branch = defaultBranch(repo, remote);
  const shared = branch ? gitMaybe(["show", `${branch}:.braid/redact.toml`], { cwd: repo.top }) : undefined;
  if (branch && shared !== undefined) texts.push([`.braid/redact.toml on ${branch.replace(/^refs\/(remotes|heads)\//, "")}`, shared]);
  for (const [source, text] of texts) {
    rules.sources.push(source);
    const t = parseToml(text);
    for (const term of Array.isArray(t.terms) ? t.terms : []) {
      if (term.trim()) rules.redact.push({ rule: "term", re: new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi") });
    }
    for (const pattern of Array.isArray(t.patterns) ? t.patterns : []) {
      try {
        rules.redact.push({ rule: "pattern", re: new RegExp(pattern, "g") });
      } catch {
        rules.problems.push(`${source}: not a valid pattern: ${pattern}`);
      }
    }
    for (const glob of Array.isArray(t.withhold) ? t.withhold : []) rules.withhold.push({ glob, re: globToRegExp(glob) });
    if (t["withhold-session"] === true) rules.withholdSession = true;
    if (t["withhold-gitignored"] === false) rules.withholdIgnored = false;
  }
  return rules;
}

const PATH_ARGS = ["file_path", "path", "notebook_path", "filePath"];

/** The paths a tool call names: path arguments, and path-like words of a shell command. */
function pathsOf(args: Record<string, unknown>): string[] {
  const out = PATH_ARGS.map((k) => args[k]).filter((v): v is string => typeof v === "string");
  for (const k of ["command", "cmd"]) {
    const v = args[k];
    if (typeof v === "string") out.push(...v.split(/[\s"'`;|&<>()]+/).filter((w) => w.includes("/") || w.includes(".")));
  }
  return out;
}

/**
 * Forms of a path to match globs against. An absolute path is tried relative
 * to the repository, and by every trailing part, since the transcript may name
 * the checkout through a symlink or from another machine: for withholding,
 * matching too much is the safe side.
 */
function candidates(p: string, top: string): string[] {
  if (!isAbsolute(p)) return [p.replace(/^\.\//, "")];
  const parts = p.split("/").filter(Boolean);
  const out = parts.map((_, i) => parts.slice(i).join("/"));
  const inside = relative(top, p);
  if (!inside.startsWith("..")) out.push(inside);
  return out;
}

/** A path as git names it inside the working tree, or undefined when it is outside. */
function inRepo(p: string, top: string): string | undefined {
  let rel = isAbsolute(p) ? relative(top, p) : normalize(p);
  if (isAbsolute(p) && rel.startsWith("..")) {
    // The transcript may name the checkout through a symlink: resolve what exists.
    const real = existsSync(p) ? realpathSync(p) : existsSync(dirname(p)) ? join(realpathSync(dirname(p)), p.slice(dirname(p).length + 1)) : undefined;
    rel = real ? relative(top, real) : "..";
  }
  return rel && !rel.startsWith("..") && !isAbsolute(rel) && !rel.includes("\0") ? rel : undefined;
}

/** The paths among `paths` that git ignores in this working tree. */
function gitIgnored(paths: string[], top: string): { ignored: Set<string>; problem?: string } {
  if (paths.length === 0) return { ignored: new Set() };
  const r = spawnSync("git", ["check-ignore", "--stdin", "-z"], { cwd: top, input: paths.join("\0"), encoding: "utf8", maxBuffer: 1 << 26 });
  // 0: some are ignored, 1: none are.
  if (r.status !== 0 && r.status !== 1) return { ignored: new Set(), problem: `git check-ignore failed: ${(r.stderr ?? "").trim().split("\n")[0]}` };
  return { ignored: new Set((r.stdout ?? "").split("\0").filter(Boolean)) };
}

/**
 * Records to withhold under the path rules: each assistant record with a tool
 * call on a matching path or on a file git ignores, and the tool results of
 * those calls. Counts are per glob, and ".gitignore" for ignored files.
 */
export function pathWithheld(records: Rec[], rules: Rules, top: string): { ids: Set<string>; counts: Map<string, number>; problem?: string } {
  const ids = new Set<string>();
  const counts = new Map<string, number>();
  const calls: { record: string; id?: string; paths: string[] }[] = [];
  for (const r of records) {
    if (!Array.isArray(r.content)) continue;
    for (const block of r.content as { type?: string; id?: string; arguments?: unknown }[]) {
      if (block?.type !== "tool_call" || !block.arguments || typeof block.arguments !== "object") continue;
      calls.push({ record: r.id, id: block.id, paths: pathsOf(block.arguments as Record<string, unknown>) });
    }
  }
  const ignored = rules.withholdIgnored ? gitIgnored([...new Set(calls.flatMap((c) => c.paths.map((p) => inRepo(p, top)).filter((p): p is string => !!p)))], top) : { ignored: new Set<string>() };

  const withheldCalls = new Set<string>();
  for (const call of calls) {
    const forms = call.paths.flatMap((p) => candidates(p, top));
    const glob = rules.withhold.find((w) => forms.some((p) => w.re.test(p)))?.glob;
    const cause = glob ?? (call.paths.some((p) => ignored.ignored.has(inRepo(p, top) ?? "")) ? ".gitignore" : undefined);
    if (!cause) continue;
    if (!ids.has(call.record)) counts.set(cause, (counts.get(cause) ?? 0) + 1);
    ids.add(call.record);
    if (call.id) withheldCalls.add(call.id);
  }
  // The results of those calls go too; they are counted with their call.
  for (const r of records) if (r.role === "tool" && typeof r.toolCallId === "string" && withheldCalls.has(r.toolCallId)) ids.add(r.id);
  return { ids, counts, problem: ignored.problem };
}
