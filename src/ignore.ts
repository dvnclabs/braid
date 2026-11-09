// .braidignore: paths whose tool calls, and their results, are never
// published. Same syntax as .gitignore: `#` comments, `!` to re-include,
// a trailing `/` for directories, a leading or inner `/` to anchor a pattern
// to the repository root, and `*`, `?`, `**`.

export interface IgnoreRule {
  /** The line as written, for reports. */
  pattern: string;
  negate: boolean;
  dirOnly: boolean;
  re: RegExp;
}

/** A glob as the body of a regular expression: `**` crosses directories, `*` and `?` do not. */
function globBody(glob: string): string {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "\\" && i + 1 < glob.length) {
      re += glob[++i]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (c === "*" && glob[i + 1] === "*") {
      const slash = glob[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return re;
}

export function parseIgnore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/(?<!\\)\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    const pattern = line;
    const negate = line.startsWith("!");
    if (negate) line = line.slice(1);
    if (line.startsWith("\\#") || line.startsWith("\\!")) line = line.slice(1);
    const dirOnly = line.endsWith("/");
    if (dirOnly) line = line.slice(0, -1);
    // A slash at the start or in the middle anchors the pattern to the root.
    const anchored = line.includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    if (!line) continue;
    rules.push({ pattern, negate, dirOnly, re: new RegExp(anchored ? `^${globBody(line)}$` : `(?:^|/)${globBody(line)}$`) });
  }
  return rules;
}

/** The last rule that matches `path` as a file (or as a directory), or undefined. */
function lastMatch(rules: IgnoreRule[], path: string, isDir: boolean): IgnoreRule | undefined {
  let hit: IgnoreRule | undefined;
  for (const rule of rules) if ((isDir || !rule.dirOnly) && rule.re.test(path)) hit = rule;
  return hit;
}

/**
 * The rule that ignores a repository-relative path, or undefined. As in git,
 * a file inside an ignored directory stays ignored, whatever a later `!` says.
 */
export function ignoredBy(rules: IgnoreRule[], path: string): IgnoreRule | undefined {
  const parts = path.split("/").filter(Boolean);
  for (let i = 1; i < parts.length; i++) {
    const dir = lastMatch(rules, parts.slice(0, i).join("/"), true);
    if (dir && !dir.negate) return dir;
  }
  const hit = lastMatch(rules, parts.join("/"), true);
  return hit && !hit.negate ? hit : undefined;
}
