// Publishing rules. Terms and patterns to redact come from the user's own
// ~/.config/braid/redact.toml and from .braid/redact.toml on the default
// branch, never from the branch being worked on or reviewed:
//
//   terms = ["Acme Corp", "Project Falcon"]     # literal, any case
//   patterns = ['CUST-\d{6}']                   # regular expressions
//   withhold-session = false                    # true: an ignored path withholds the whole session
//
// Paths whose tool calls are withheld come from .braidignore files (see
// ignore.ts): the working tree's, the default branch's, and the user's own
// ~/.config/braid/ignore. Each is applied on its own and any of them
// withholds, so a branch cannot re-include what the default branch ignores.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import { gitMaybe } from "./git.ts";
import type { Rec } from "./records.ts";
import type { Rule } from "./redact.ts";
import { configDir, findRepo, type Repo } from "./repo.ts";
import { ignoredBy, parseIgnore, type IgnoreRule } from "./ignore.ts";

export interface Rules {
  redact: Rule[];
  /** .braidignore files, each applied on its own. */
  ignores: { source: string; rules: IgnoreRule[] }[];
  withholdSession: boolean;
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

/** The default branch, as a ref this clone has: the remote's HEAD, else main or master. */
function defaultBranch(repo: Repo, remote: string): string | undefined {
  const head = gitMaybe(["symbolic-ref", "-q", `refs/remotes/${remote}/HEAD`], { cwd: repo.top })?.trim();
  for (const ref of [head, `refs/remotes/${remote}/main`, `refs/remotes/${remote}/master`, "refs/heads/main", "refs/heads/master"]) {
    if (ref && gitMaybe(["rev-parse", "-q", "--verify", `${ref}^{commit}`], { cwd: repo.top })) return ref;
  }
  return undefined;
}

/**
 * The rules for a session. `code` is the code repository a session kept in a
 * separate repository ran in: its rules apply too, as they would next to the code.
 */
export function loadRules(repo: Repo, remote: string, code?: string): Rules {
  const rules: Rules = { redact: [], ignores: [], withholdSession: false, sources: [], problems: [] };
  const texts: [string, string][] = [];
  const own = join(configDir(), "redact.toml");
  if (existsSync(own)) texts.push([own.replace(process.env.HOME ?? "\0", "~"), readFileSync(own, "utf8")]);
  // Shared rules come from the default branch of the code: the code repository's, else this one's.
  const codeRepo = code && existsSync(code) ? findRepo(code) : undefined;
  const ruled = codeRepo ?? repo;
  const branch = defaultBranch(ruled, codeRepo ? "origin" : remote);
  const shared = branch ? gitMaybe(["show", `${branch}:.braid/redact.toml`], { cwd: ruled.top }) : undefined;
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
    if (t["withhold-session"] === true) rules.withholdSession = true;
  }

  const file = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);
  const ignores: [string, string | undefined][] = [
    ["~/.config/braid/ignore", file(join(configDir(), "ignore"))],
    [`.braidignore on ${(branch ?? "").replace(/^refs\/(remotes|heads)\//, "")}`, branch ? gitMaybe(["show", `${branch}:.braidignore`], { cwd: ruled.top }) : undefined],
    [".braidignore", file(join(ruled.top, ".braidignore"))],
    ...(codeRepo ? [[`.braidignore in ${repo.top}`, file(join(repo.top, ".braidignore"))] as [string, string | undefined]] : []),
  ];
  const seen = new Set<string>();
  for (const [source, text] of ignores) {
    if (text === undefined || seen.has(text)) continue;
    seen.add(text);
    rules.sources.push(source);
    rules.ignores.push({ source, rules: parseIgnore(text) });
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

/** A path as git names it inside the working tree, or undefined when it is outside. */
function inRepo(p: string, top: string): string | undefined {
  let rel = isAbsolute(p) ? relative(top, p) : normalize(p);
  if (isAbsolute(p) && rel.startsWith("..")) {
    // The transcript may name the checkout through a symlink: resolve what exists.
    const real = existsSync(p) ? realpathSync(p) : existsSync(dirname(p)) ? join(realpathSync(dirname(p)), p.slice(dirname(p).length + 1)) : undefined;
    rel = real ? relative(top, real) : "..";
  }
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : undefined;
}

/**
 * Forms of a path to match ignore rules against: its path in the repository,
 * or, for a path outside it (another machine's checkout), every trailing part.
 * For withholding, matching too much is the safe side.
 */
function forms(p: string, top: string): string[] {
  const rel = inRepo(p, top);
  if (rel) return [rel];
  if (!isAbsolute(p)) return [];
  const parts = p.split("/").filter(Boolean);
  return parts.map((_, i) => parts.slice(i).join("/"));
}

/**
 * Records to withhold under .braidignore, each with the pattern that withholds
 * it: each assistant record with a tool call on an ignored path, and the tool
 * results of those calls. Counts are per pattern, of the calls.
 */
export function pathWithheld(records: Rec[], rules: Rules, top: string): { ids: Map<string, string>; counts: Map<string, number> } {
  const ids = new Map<string, string>();
  const counts = new Map<string, number>();
  if (rules.ignores.length === 0) return { ids, counts };
  const calls = new Map<string, string>();
  for (const r of records) {
    if (!Array.isArray(r.content)) continue;
    for (const block of r.content as { type?: string; id?: string; arguments?: unknown }[]) {
      if (block?.type !== "tool_call" || !block.arguments || typeof block.arguments !== "object") continue;
      const paths = pathsOf(block.arguments as Record<string, unknown>).flatMap((p) => forms(p, top));
      let cause: string | undefined;
      for (const source of rules.ignores) {
        for (const p of paths) cause ??= ignoredBy(source.rules, p)?.pattern;
      }
      if (!cause) continue;
      if (!ids.has(r.id)) counts.set(cause, (counts.get(cause) ?? 0) + 1);
      ids.set(r.id, ids.get(r.id) ?? cause);
      if (block.id) calls.set(block.id, cause);
    }
  }
  // The results of those calls go too; they are counted with their call.
  for (const r of records) {
    const cause = r.role === "tool" && typeof r.toolCallId === "string" ? calls.get(r.toolCallId) : undefined;
    if (cause && !ids.has(r.id)) ids.set(r.id, cause);
  }
  return { ids, counts };
}
