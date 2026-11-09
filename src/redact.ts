// Redaction before publishing. Built-in rules catch common credentials; matches
// become [REDACTED:<rule>] markers and are counted per rule.
import { homedir } from "node:os";

export interface Rule {
  rule: string;
  re: RegExp;
  /** Index of the capture group holding the secret; the whole match when absent. */
  group?: number;
}

const RULES: Rule[] = [
  { rule: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { rule: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { rule: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g },
  { rule: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { rule: "openai-key", re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { rule: "slack-token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { rule: "stripe-key", re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { rule: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { rule: "npm-token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { rule: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { rule: "url-password", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:([^\s@/]{3,})@/gi, group: 1 },
  // KEY=value in env files and shell commands: API_KEY=..., DB_PASSWORD=...
  { rule: "env-secret", re: /\b[A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD)[A-Z0-9_]*=(?!\[REDACTED)([^\s"'`]{8,})/g, group: 1 },
  // password: "...", apiKey = '...': quoted literals assigned to secret-looking names
  {
    rule: "quoted-secret",
    re: /\b(?:api[_-]?key|secret|token|password|passwd|auth)[A-Za-z0-9_]*["']?\s*[:=]\s*["'](?!\[REDACTED)([^"'\s]{8,})["']/gi,
    group: 1,
  },
];

export type Counts = Map<string, number>;

// Home directories of any user and machine: a session moved from /Users/alice to /home/alice has both.
const HOMES = /(?:\/Users|\/home|[A-Za-z]:\\Users)[\/\\][A-Za-z0-9._-]+(?=[\/\\"'\s]|$)/g;

/** Redacts one string with the built-in rules and `extra`, counting matches per rule. */
export function redactString(s: string, counts: Counts, extra: Rule[] = []): string {
  let out = s;
  for (const { rule, re, group } of [...RULES, ...extra]) {
    out = out.replace(re, (match: string, ...groups: unknown[]) => {
      counts.set(rule, (counts.get(rule) ?? 0) + 1);
      const marker = `[REDACTED:${rule}]`;
      if (group === undefined) return marker;
      const secret = groups[group - 1];
      return typeof secret === "string" ? match.replace(secret, marker) : marker;
    });
  }
  const home = homedir();
  if (home.length > 1) out = out.split(home).join("~");
  return out.replace(HOMES, "~");
}

/** Redacts every string in a JSON value. */
export function redactValue<T>(value: T, counts: Counts, extra: Rule[] = []): T {
  if (typeof value === "string") return redactString(value, counts, extra) as T;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, counts, extra)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(v, counts, extra);
    return out as T;
  }
  return value;
}
