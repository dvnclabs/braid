#!/usr/bin/env node

// src/cli.ts
import { spawn, spawnSync as spawnSync3 } from "node:child_process";
import { appendFileSync as appendFileSync3, existsSync as existsSync14, mkdirSync as mkdirSync6, readFileSync as readFileSync9, statSync as statSync2 } from "node:fs";
import { basename as basename2, join as join12 } from "node:path";
import { parseArgs } from "node:util";

// src/hooks.ts
import { appendFileSync as appendFileSync2 } from "node:fs";
import { dirname as dirname4, join as join9 } from "node:path";

// src/redact.ts
import { homedir } from "node:os";
var RULES = [
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
    group: 1
  }
];
var HOMES = /(?:\/Users|\/home|[A-Za-z]:\\Users)[\/\\][A-Za-z0-9._-]+(?=[\/\\"'\s]|$)/g;
function redactString(s, counts, extra = []) {
  let out = s;
  for (const { rule, re, group } of [...RULES, ...extra]) {
    out = out.replace(re, (match, ...groups) => {
      counts.set(rule, (counts.get(rule) ?? 0) + 1);
      const marker = `[REDACTED:${rule}]`;
      if (group === void 0) return marker;
      const secret = groups[group - 1];
      return typeof secret === "string" ? match.replace(secret, marker) : marker;
    });
  }
  const home = homedir();
  if (home.length > 1) out = out.split(home).join("~");
  return out.replace(HOMES, "~");
}

// src/records.ts
var braidOf = (r) => r.ext?.braid ?? {};
function forModel(records, provider) {
  return records.flatMap((r) => {
    if (r.type === "settings" && r.model?.provider !== void 0 && r.model.provider !== provider) {
      const { model: _model, ...rest } = r;
      return [rest];
    }
    if (r.type !== "message" || !Array.isArray(r.content)) return [r];
    const content2 = r.content.filter(
      (b) => b?.type !== "reasoning" || !!b.replay?.some((x) => x.provider === provider)
    );
    if (content2.length === r.content.length) return [r];
    return content2.length ? [{ ...r, content: content2 }] : [];
  });
}
var sourceOf = (r) => r.native?.source;
var textOf = (content2) => typeof content2 === "string" ? content2 : Array.isArray(content2) ? content2.map((b) => typeof b?.text === "string" ? b.text : "").join("") : "";
var CODEX_CONTEXT = /^\s*(<environment_context>|<user_instructions>|# AGENTS\.md instructions for )/;
var CODEX_NOTE = /^\s*<(skill|turn_aborted|subagent_notification|user_shell_command|image_resize_notice)>/;
function codexBody(body, agent) {
  if (body.role === "system") return void 0;
  if (body.role !== "user") return body;
  const text2 = textOf(body.content);
  if (CODEX_CONTEXT.test(text2)) return void 0;
  return agent !== "codex" && CODEX_NOTE.test(text2) ? { ...body, display: false } : body;
}
function asCodexShowed(records, agent) {
  return records.flatMap((r) => {
    if (sourceOf(r) !== "codex") return [r];
    if (r.type === "compaction" && Array.isArray(r.replacement)) return [{ ...r, replacement: r.replacement.flatMap((b) => codexBody(b, agent) ?? []) }];
    if (r.type !== "message") return [r];
    const body = codexBody(r, agent);
    return body ? [body] : [];
  });
}
var isCodexContext = (r) => sourceOf(r) === "codex" && r.type === "message" && !codexBody(r, "codex");
var isTurn = (r) => r.type === "message" && !isCodexContext(r) || r.type === "branch_summary";
function parseJsonl(text2) {
  return text2.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
}
function toJsonl(records) {
  return records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "");
}
function withBraid(r, fields) {
  return { ...r, ext: { ...r.ext, braid: { ...braidOf(r), ...fields } } };
}
function clip(s, max) {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}\u2026` : flat;
}
function blockText(block, max) {
  if (typeof block === "string") return clip(block, max);
  if (!block || typeof block !== "object") return "";
  const b = block;
  if (b.type === "text" && typeof b.text === "string") return clip(b.text, max);
  if (b.type === "tool_call") {
    const args = b.arguments && typeof b.arguments === "object" ? b.arguments : {};
    const key = ["file_path", "path", "command", "cmd", "pattern", "url", "query"].find((k) => typeof args[k] === "string");
    return `\u2192 ${String(b.name)}${key ? ` ${clip(String(args[key]), 120)}` : ""}`;
  }
  return "";
}
var NOT_TYPED = /^\s*(<(task-notification|local-command-stdout|local-command-stderr|local-command-caveat|system-reminder|bash-stdout|bash-stderr|user-prompt-submit-hook)>|\[Request interrupted)/;
function isPrompt(r) {
  if (r.type !== "message" || r.role !== "user" || r.display === false || isCodexContext(r)) return false;
  const line = nativeLine(r);
  if (line && sourceOf(r) === "claude-code") {
    const origin = line.origin?.kind;
    if (line.isMeta === true || line.isCompactSummary === true || line.toolUseResult !== void 0 || origin && origin !== "human") return false;
  }
  if (Array.isArray(r.content) && r.content.some((b) => b?.type === "tool_result")) return false;
  const text2 = textOf(r.content);
  return !NOT_TYPED.test(text2) && !CODEX_NOTE.test(text2);
}
function promptLine(r, max = 100) {
  const text2 = describe(r, 4e3);
  const command = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(text2);
  const args = /<command-args>\s*([\s\S]*?)\s*<\/command-args>/.exec(text2)?.[1];
  return clip(command ? `${command[1]}${args ? ` ${args}` : ""}` : text2, max);
}
var RANK = { prompt: 0, agent: 1, user: 2 };
function printable(s, max) {
  return clip(s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, " "), max);
}
var nativeLine = (r) => r.native?.records?.[0];
function about(records, prior = {}) {
  let { title, recap: recap2 } = prior;
  const take = (text2, by) => {
    const t = printable(redactString(text2, /* @__PURE__ */ new Map()), 80);
    if (t && (!title || RANK[by] >= RANK[title.by])) title = { text: t, by };
  };
  for (const r of records) {
    if (r.type === "metadata" && typeof r.title === "string") take(r.title, nativeLine(r)?.type === "custom-title" ? "user" : "agent");
    else if (r.type === "custom" && r.name === "system:away_summary") {
      const content2 = nativeLine(r)?.content;
      const text2 = typeof content2 === "string" ? printable(redactString(content2, /* @__PURE__ */ new Map()), 400) : "";
      if (text2) recap2 = { text: text2, at: String(r.time ?? "") };
    } else if (!title && r.type === "message" && r.role === "user" && r.display !== false && isTurn(r)) {
      const text2 = textOf(r.content).trim();
      if (text2 && !text2.startsWith("<") && !text2.startsWith("[")) take(text2.split("\n")[0], "prompt");
    }
  }
  return { ...title ? { title } : {}, ...recap2 ? { recap: recap2 } : {} };
}
function ago(iso, now = Date.now()) {
  const s = Math.round((now - Date.parse(iso)) / 1e3);
  if (!Number.isFinite(s)) return "some time ago";
  if (s < 90) return "just now";
  const [n, unit] = s < 5400 ? [Math.round(s / 60), "minute"] : s < 129600 ? [Math.round(s / 3600), "hour"] : [Math.round(s / 86400), "day"];
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}
function describe(r, max = 400) {
  if (r.type === "branch_summary") return clip(String(r.summary ?? ""), max * 4);
  if (r.type === "compaction") return clip(String(r.summary ?? ""), max);
  if (r.type === "label") return braidOf(r).commit ? `commit: ${String(r.label)}` : braidOf(r).code ? `code commit: ${String(r.label)}` : `named ${String(r.label)}`;
  if (r.type === "agent_link") {
    const agent = r.agent;
    return clip(`\u2192 subagent ${String(r.transcriptId)}${agent ? ` (${agent.name ?? "subagent"}): ${agent.role ?? ""}` : ""}`, max);
  }
  if (r.type !== "message") return "";
  const c = r.content;
  const parts = Array.isArray(c) ? c.map((b) => blockText(b, max)) : [blockText(c, max)];
  return parts.filter(Boolean).join("\n");
}
function lastTurn(records) {
  for (let i = records.length - 1; i >= 0; i--) if (isTurn(records[i]) || records[i].type === "compaction") return records[i].id;
  return void 0;
}
function ancestry(head, parents) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  let id = head;
  while (id && parents.has(id) && !seen.has(id)) {
    seen.add(id);
    out.push(id);
    id = parents.get(id);
  }
  return out;
}
var isNote = (r) => r.type === "custom" && String(r.name ?? "").startsWith("attachment") || r.type === "message" && r.role === "user" && r.display === false;
var callIds = (r) => r.type === "message" && r.role === "assistant" && Array.isArray(r.content) ? r.content.flatMap((b) => b?.type === "tool_call" && typeof b.id === "string" ? [b.id] : []) : [];
function contextPath(head, all) {
  const parents = new Map([...all.values()].map((r) => [r.id, r.parentId ?? null]));
  const path2 = ancestry(head, parents).reverse().map((id) => all.get(id)).filter((r) => !!r && r.type !== "transcript");
  const onPath = new Set(path2.map((r) => r.id));
  const isReply = (r) => r?.type === "message" && r.role === "assistant";
  const results = /* @__PURE__ */ new Map();
  const responses = /* @__PURE__ */ new Map();
  for (const r of all.values()) {
    if (r.role === "tool" && typeof r.toolCallId === "string" && !results.has(r.toolCallId)) results.set(r.toolCallId, r);
    if (isReply(r) && typeof r.responseId === "string" && !onPath.has(r.id)) responses.set(r.responseId, [...responses.get(r.responseId) ?? [], r]);
  }
  const children = /* @__PURE__ */ new Map();
  for (const r of all.values()) if (r.parentId) children.set(r.parentId, [...children.get(r.parentId) ?? [], r]);
  const out = [];
  const taken = new Set(onPath);
  let waiting = [];
  const bring = (r) => {
    taken.add(r.id);
    waiting.push(r);
    for (const c of children.get(r.id) ?? []) if (isNote(c) && !taken.has(c.id)) bring(c);
  };
  const linked = (r) => !taken.has(r.id) && !!r.parentId && taken.has(r.parentId);
  const answer = (r) => {
    for (const id of callIds(r)) {
      const result = results.get(id);
      if (result && linked(result)) bring(result);
    }
  };
  const order = new Map([...all.keys()].map((id, i) => [id, i]));
  path2.forEach((r, i) => {
    if (!isReply(r)) {
      out.push(...[...waiting, r].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)));
      waiting = [];
      return;
    }
    out.push(r);
    answer(r);
    const next = path2[i + 1];
    if (typeof r.responseId !== "string" || isReply(next) && next.responseId === r.responseId) return;
    for (const rest of responses.get(r.responseId) ?? []) {
      if (!linked(rest)) continue;
      taken.add(rest.id);
      out.push(rest);
      answer(rest);
    }
  });
  return out;
}

// src/repo.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync2, realpathSync, writeFileSync as writeFileSync2 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { basename, dirname, join as join2 } from "node:path";

// src/git.ts
import { spawnSync } from "node:child_process";
var GitError = class extends Error {
  args;
  status;
  stderr;
  constructor(args, status, stderr) {
    super(`git ${args.join(" ")} failed (${status}): ${stderr.trim()}`);
    this.args = args;
    this.status = status;
    this.stderr = stderr;
  }
};
var IDENTITY = {
  GIT_AUTHOR_NAME: "braid",
  GIT_AUTHOR_EMAIL: "braid@localhost",
  GIT_COMMITTER_NAME: "braid",
  GIT_COMMITTER_EMAIL: "braid@localhost"
};
function run(args, opts) {
  const full = opts.gitDir ? ["--git-dir", opts.gitDir, ...args] : args;
  return spawnSync("git", full, {
    cwd: opts.cwd,
    input: opts.input,
    env: { ...process.env, ...IDENTITY, ...opts.env },
    encoding: "utf8",
    maxBuffer: 1 << 30
  });
}
function gitMaybe(args, opts = {}) {
  const r = run(args, opts);
  return r.status === 0 ? r.stdout : void 0;
}
function revParse(ref, opts) {
  return gitMaybe(["rev-parse", "-q", "--verify", `${ref}^{commit}`], opts)?.trim() || void 0;
}
function forEachRef(patterns, opts) {
  const out = gitMaybe(["for-each-ref", "--format=%(objectname) %(refname)", ...patterns], opts) ?? "";
  return out.split("\n").filter(Boolean).map((line) => {
    const i = line.indexOf(" ");
    return { sha: line.slice(0, i), ref: line.slice(i + 1) };
  });
}
function lsTree(treeish, opts) {
  const out = gitMaybe(["ls-tree", "-z", treeish], opts) ?? "";
  return out.split("\0").filter(Boolean).map((line) => {
    const tab = line.indexOf("	");
    const [mode, type, sha] = line.slice(0, tab).split(" ");
    return { mode, type, sha, name: line.slice(tab + 1) };
  });
}
function catBlobs(specs, opts) {
  if (specs.length === 0) return [];
  const full = opts.gitDir ? ["--git-dir", opts.gitDir, "cat-file", "--batch"] : ["cat-file", "--batch"];
  const r = spawnSync("git", full, {
    cwd: opts.cwd,
    input: specs.join("\n") + "\n",
    env: { ...process.env, ...IDENTITY },
    maxBuffer: 1 << 30
  });
  if (r.status !== 0) throw new GitError(["cat-file", "--batch"], r.status, r.stderr?.toString() ?? "");
  const buf = r.stdout;
  const out = [];
  let pos = 0;
  for (let i = 0; i < specs.length; i++) {
    const nl = buf.indexOf(10, pos);
    const header2 = buf.subarray(pos, nl).toString("utf8");
    pos = nl + 1;
    if (header2.endsWith(" missing")) {
      out.push("");
      continue;
    }
    const size = Number(header2.split(" ")[2]);
    out.push(buf.subarray(pos, pos + size).toString("utf8"));
    pos += size + 1;
  }
  return out;
}
function config(key, opts) {
  return gitMaybe(["config", "--get", key], opts)?.trim() || void 0;
}

// src/registry.ts
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join } from "node:path";
function file(session) {
  if (!/^[A-Za-z0-9-]{8,80}$/.test(session)) return void 0;
  return join(process.env.XDG_DATA_HOME || join(homedir2(), ".local", "share"), "braid", "sessions", `${session}.json`);
}
function currentSession() {
  return (process.env.BRAID_SESSION ?? process.env.CLAUDE_CODE_SESSION_ID ?? process.env.CODEX_THREAD_ID) || void 0;
}
function currentAgent() {
  if (process.env.BRAID_SESSION || process.env.CLAUDE_CODE_SESSION_ID) return "claude-code";
  return process.env.CODEX_THREAD_ID ? "codex" : void 0;
}
var list = (dir) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};
function transcriptOf(session) {
  const known = readEntry(session)?.transcript;
  if (known || !/^[A-Za-z0-9-]{8,80}$/.test(session)) return known;
  const projects = join(process.env.CLAUDE_CONFIG_DIR || join(homedir2(), ".claude"), "projects");
  const claude = list(projects).map((d) => join(projects, d, `${session}.jsonl`)).find((p) => existsSync(p));
  if (claude) return claude;
  const sessions = join(process.env.CODEX_HOME || join(homedir2(), ".codex"), "sessions");
  for (const y of list(sessions).sort().reverse())
    for (const m of list(join(sessions, y)).sort().reverse())
      for (const d of list(join(sessions, y, m)).sort().reverse()) {
        const name = list(join(sessions, y, m, d)).find((f) => f.startsWith("rollout-") && f.endsWith(`-${session}.jsonl`));
        if (name) return join(sessions, y, m, d, name);
      }
  return void 0;
}
function readEntry(session) {
  const path2 = file(session);
  if (!path2 || !existsSync(path2)) return void 0;
  try {
    const entry = JSON.parse(readFileSync(path2, "utf8"));
    return { transcript: entry.transcript, project: entry.project };
  } catch {
    return void 0;
  }
}
function knownSessions(prefix) {
  if (!/^[A-Za-z0-9-]{4,80}$/.test(prefix)) return [];
  const dir = join(process.env.XDG_DATA_HOME || join(homedir2(), ".local", "share"), "braid", "sessions");
  return list(dir).filter((f) => f.startsWith(prefix) && f.endsWith(".json")).map((f) => f.slice(0, -".json".length)).map((session) => ({ session, project: readEntry(session)?.project }));
}
function recordSession(session, update) {
  const path2 = file(session);
  if (!path2) return;
  const entry = readEntry(session) ?? {};
  if (update.transcript) entry.transcript = update.transcript;
  if (update.project) entry.project = update.project;
  mkdirSync(join(path2, ".."), { recursive: true });
  const tmp = `${path2}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry, null, 2) + "\n");
  renameSync(tmp, path2);
}

// src/repo.ts
var real = (path2) => existsSync2(path2) ? realpathSync(path2) : path2;
function checkoutOf(cwd) {
  return real(gitMaybe(["rev-parse", "--show-toplevel"], { cwd })?.trim() || cwd);
}
function projectOf(cwd) {
  const top = gitMaybe(["rev-parse", "--show-toplevel"], { cwd })?.trim();
  if (!top) return real(cwd);
  const common = gitMaybe(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: top })?.trim();
  if (!common) return real(top);
  return real(basename(common) === ".git" ? dirname(common) : common);
}
function repoAt(project) {
  const dir = join2(project, ".braid");
  return { top: project, dir, sessions: join2(dir, "sessions"), cache: join2(dir, "cache") };
}
function locate(cwd) {
  return repoAt(projectOf(cwd));
}
function repoFor(session, cwd) {
  const known = session ? readEntry(session)?.project : void 0;
  return known && existsSync2(join2(known, ".braid")) ? repoAt(known) : locate(cwd);
}
function ensureStore(repo) {
  mkdirSync2(repo.sessions, { recursive: true });
  const ignore = join2(repo.dir, ".gitignore");
  if (!existsSync2(ignore)) writeFileSync2(ignore, "# braid: conversations stay out of git.\n*\n");
}
function configDir() {
  return join2(process.env.XDG_CONFIG_HOME || join2(homedir3(), ".config"), "braid");
}

// src/save.ts
import { existsSync as existsSync6, readdirSync as readdirSync2, readFileSync as readFileSync4 } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join as join5 } from "node:path";

// src/store.ts
import { appendFileSync, existsSync as existsSync3, readFileSync as readFileSync2, rmSync, writeFileSync as writeFileSync3 } from "node:fs";
import { join as join3 } from "node:path";
import { constants, gunzipSync, gzipSync } from "node:zlib";
var recordsFile = (repo, session) => join3(repo.sessions, `${session}.jsonl.gz`);
var plainFile = (repo, session) => join3(repo.sessions, `${session}.jsonl`);
function text(repo, session) {
  const gz = recordsFile(repo, session);
  if (existsSync3(gz)) {
    const buf = readFileSync2(gz);
    try {
      return { text: gunzipSync(buf).toString("utf8"), truncated: false };
    } catch {
      const partial = gunzipSync(buf, { finishFlush: constants.Z_SYNC_FLUSH }).toString("utf8");
      return { text: partial.slice(0, partial.lastIndexOf("\n") + 1), truncated: true };
    }
  }
  const plain2 = plainFile(repo, session);
  return { text: existsSync3(plain2) ? readFileSync2(plain2, "utf8") : "", truncated: false };
}
function sessionFile(repo, session) {
  const gz = recordsFile(repo, session);
  return existsSync3(gz) || !existsSync3(plainFile(repo, session)) ? gz : plainFile(repo, session);
}
function readFile(repo, session) {
  return readChecked(repo, session).records;
}
function readChecked(repo, session) {
  const { text: t, truncated } = text(repo, session);
  const records = t.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  return { records, truncated };
}
function readRecords(repo, session) {
  return readFile(repo, session).filter((r) => !braidOf(r).agent);
}
function readAgents(repo, session) {
  const out = /* @__PURE__ */ new Map();
  for (const r of readFile(repo, session)) {
    const agent = braidOf(r).agent;
    if (agent) out.set(agent, [...out.get(agent) ?? [], r]);
  }
  return out;
}
function appendRecords(repo, session, records, agents = /* @__PURE__ */ new Map()) {
  const lines = [...records, ...[...agents].flatMap(([id, rs]) => rs.map((r) => withBraid(r, { agent: id })))];
  if (lines.length === 0) return;
  ensureStore(repo);
  const gz = recordsFile(repo, session);
  const plain2 = plainFile(repo, session);
  if (!existsSync3(gz) && existsSync3(plain2)) {
    writeFileSync3(gz, gzipSync(readFileSync2(plain2)));
    rmSync(plain2);
  }
  appendFileSync(gz, gzipSync(toJsonl(lines)));
}

// src/state.ts
import { existsSync as existsSync4, mkdirSync as mkdirSync3, readFileSync as readFileSync3, renameSync as renameSync2, rmSync as rmSync2, statSync, writeFileSync as writeFileSync4 } from "node:fs";
import { join as join4 } from "node:path";
function path(repo, session) {
  return join4(repo.sessions, `${session}.json`);
}
function loadState(repo, session) {
  const p = path(repo, session);
  if (!existsSync4(p)) return void 0;
  return JSON.parse(readFileSync3(p, "utf8"));
}
function saveState(repo, state) {
  const p = path(repo, state.session);
  ensureStore(repo);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync4(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync2(tmp, p);
}
function newState(session, transcript, harness2 = "claude-code") {
  return { session, harness: harness2, transcript, chunks: 0 };
}
var sleeper = new Int32Array(new SharedArrayBuffer(4));
function withLock(repo, name, fn) {
  const lock = join4(repo.dir, "locks", name);
  mkdirSync3(join4(repo.dir, "locks"), { recursive: true });
  const deadline = Date.now() + 1e4;
  for (; ; ) {
    try {
      mkdirSync3(lock);
      break;
    } catch {
      let stale = false;
      try {
        stale = Date.now() - statSync(lock).mtimeMs > 3e4;
      } catch {
        continue;
      }
      if (stale) rmSync2(lock, { recursive: true, force: true });
      else if (Date.now() > deadline) throw new Error(`braid: ${name} is locked`);
      else Atomics.wait(sleeper, 0, 0, 50);
    }
  }
  try {
    return fn();
  } finally {
    rmSync2(lock, { recursive: true, force: true });
  }
}

// src/transcript.ts
import { createHash as createHash2 } from "node:crypto";
import { closeSync, existsSync as existsSync5, fstatSync, openSync, readSync } from "node:fs";

// node_modules/@leostera/atxf/dist/types.js
var TREE_TYPES = /* @__PURE__ */ new Set([
  "message",
  "context",
  "settings",
  "compaction",
  "context_edit",
  "branch_summary",
  "turn",
  "tool_status",
  "usage",
  "checkpoint",
  "agent_link",
  "custom"
]);
function isTreeRecord(record) {
  return TREE_TYPES.has(record.type);
}

// node_modules/@leostera/atxf/dist/tree.js
function indexTree(transcript) {
  const nodes = /* @__PURE__ */ new Map();
  const children = /* @__PURE__ */ new Map();
  let activeLeaf = null;
  for (const record of transcript.records) {
    if (isTreeRecord(record)) {
      nodes.set(record.id, record);
      const siblings = children.get(record.parentId) ?? [];
      siblings.push(record.id);
      children.set(record.parentId, siblings);
      activeLeaf = record.id;
    } else if (record.type === "leaf") {
      activeLeaf = record.targetId;
    }
  }
  return { nodes, children, activeLeaf };
}
function pathTo(index, leaf) {
  const path2 = [];
  const seen = /* @__PURE__ */ new Set();
  for (let cursor = leaf; cursor !== null; ) {
    const node = index.nodes.get(cursor);
    if (!node || seen.has(cursor))
      break;
    seen.add(cursor);
    path2.push(node);
    cursor = node.parentId;
  }
  return path2.reverse();
}

// node_modules/@leostera/atxf/dist/context.js
function workingRange(path2) {
  const at = path2.findLastIndex((record) => record.type === "compaction");
  if (at === -1)
    return { range: [...path2], before: [] };
  const compaction = path2[at];
  const after = path2.slice(at + 1);
  let kept = [];
  if (compaction.strategy === "summary" && compaction.firstKeptId) {
    const from = path2.findIndex((record) => record.id === compaction.firstKeptId);
    if (from !== -1 && from < at)
      kept = path2.slice(from, at);
  }
  return { range: [compaction, ...kept, ...after], compaction, before: path2.slice(0, at) };
}
function buildContext(transcript, options = {}) {
  const index = options.index ?? indexTree(transcript);
  const leaf = options.leaf === void 0 ? index.activeLeaf : options.leaf;
  const path2 = pathTo(index, leaf);
  const { range, compaction, before } = workingRange(path2);
  const promptState = new PromptState();
  if (compaction?.snapshot) {
    promptState.replace(compaction.snapshot.instructions ?? [], compaction.snapshot.tools ?? []);
  } else {
    for (const record of before)
      if (record.type === "context")
        promptState.apply(record);
  }
  for (const record of range)
    if (record.type === "context")
      promptState.apply(record);
  const edits = latestEdits(path2);
  const messages = [];
  for (const record of range) {
    switch (record.type) {
      case "message": {
        const edit = edits.get(record.id);
        if (edit === null)
          break;
        const body = messageBody(record);
        messages.push({ body: edit === void 0 ? body : withContent(body, edit), sourceId: record.id, kind: "message" });
        break;
      }
      case "compaction":
        if (record.strategy === "replace") {
          for (const body of record.replacement ?? [])
            messages.push({ body, sourceId: record.id, kind: "compaction_replacement" });
        } else {
          messages.push({
            body: { role: "user", content: record.summary ?? "", origin: { kind: "synthetic", name: "compaction" } },
            sourceId: record.id,
            kind: "compaction_summary"
          });
        }
        break;
      case "branch_summary":
        messages.push({
          body: { role: "user", content: record.summary, origin: { kind: "synthetic", name: "branch_summary" } },
          sourceId: record.id,
          kind: "branch_summary"
        });
        break;
    }
  }
  return {
    leaf,
    ...promptState.snapshot(),
    messages: options.target ? filterReplay(messages, options.target) : messages,
    settings: foldSettings(path2)
  };
}
function foldSettings(path2) {
  const settings = {};
  for (const record of path2) {
    if (record.type !== "settings")
      continue;
    for (const key of ["model", "reasoningEffort", "agent", "mode", "cwd", "policy"]) {
      if (record[key] !== void 0)
        settings[key] = record[key];
    }
  }
  return settings;
}
var PromptState = class {
  sections = /* @__PURE__ */ new Map();
  tools = /* @__PURE__ */ new Map();
  replace(instructions, tools) {
    this.sections = /* @__PURE__ */ new Map();
    this.tools = /* @__PURE__ */ new Map();
    for (const section of instructions)
      if (section.text !== null)
        this.sections.set(section.name, section.text);
    for (const tool of tools)
      this.tools.set(tool.name, tool);
  }
  apply(record) {
    if (record.mode === "replace")
      return this.replace(record.instructions ?? [], record.toolsAdded ?? []);
    for (const section of record.instructions ?? []) {
      if (section.text === null)
        this.sections.delete(section.name);
      else
        this.sections.set(section.name, section.text);
    }
    for (const name of record.toolsRemoved ?? [])
      this.tools.delete(name);
    for (const tool of record.toolsAdded ?? [])
      this.tools.set(tool.name, tool);
  }
  snapshot() {
    return {
      instructions: [...this.sections].map(([name, text2]) => ({ name, text: text2 })),
      tools: [...this.tools.values()]
    };
  }
};
function latestEdits(path2) {
  const edits = /* @__PURE__ */ new Map();
  for (const record of path2)
    if (record.type === "context_edit")
      edits.set(record.targetId, record.replacement);
  return edits;
}
var ENVELOPE_KEYS = /* @__PURE__ */ new Set(["type", "id", "parentId", "time", "native", "ext"]);
function messageBody(record) {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !ENVELOPE_KEYS.has(key)));
}
function withContent(body, replacement) {
  if (body.role === "assistant" || body.role === "tool") {
    const blocks = typeof replacement === "string" ? [{ type: "text", text: replacement }] : replacement;
    return { ...body, content: blocks };
  }
  return { ...body, content: replacement };
}
function matches(replay2, target) {
  return replay2.provider === target.provider && (replay2.api === void 0 || target.api === void 0 || replay2.api === target.api);
}
function filterReplay(messages, target) {
  const keep = (replay2) => {
    const kept = replay2?.filter((entry) => matches(entry, target));
    return kept && kept.length > 0 ? kept : void 0;
  };
  return messages.map((message) => {
    const body = message.body;
    if (body.role !== "assistant")
      return message;
    const content2 = body.content.flatMap((block) => {
      if (!("replay" in block) || block.replay === void 0)
        return [block];
      const { replay: _2, ...rest2 } = block;
      const replay3 = keep(block.replay);
      const filtered = replay3 ? { ...rest2, replay: replay3 } : rest2;
      if (filtered.type === "reasoning" && filtered.text === void 0 && filtered.summary === void 0 && !replay3)
        return [];
      return [filtered];
    });
    const { replay: _, ...rest } = body;
    const replay2 = keep(body.replay);
    return { ...message, body: { ...rest, ...replay2 ? { replay: replay2 } : {}, content: content2 } };
  });
}

// node_modules/@leostera/atxf/dist/convert.js
var IdAllocator = class {
  used = /* @__PURE__ */ new Set();
  constructor(existing = []) {
    for (const id of existing)
      this.used.add(id);
  }
  /** `preferred` when free, otherwise `preferred-2`, `preferred-3`, … */
  take(preferred) {
    let id = preferred;
    for (let n = 2; this.used.has(id); n++)
      id = `${preferred}-${n}`;
    this.used.add(id);
    return id;
  }
};

// node_modules/@leostera/atxf/dist/canonical.js
import { createHash } from "node:crypto";
function canonicalJson(value) {
  if (typeof value === "number" && !Number.isFinite(value))
    throw new Error(`canonical JSON cannot encode ${value}`);
  if (Array.isArray(value))
    return `[${value.map((item) => item === void 0 ? "null" : canonicalJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value;
    const fields = Object.keys(record).filter((key) => record[key] !== void 0).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(value);
}
function sha256(text2) {
  return createHash("sha256").update(text2).digest("hex");
}

// node_modules/@leostera/atxf/dist/integrity.js
var REFERENCE_FIELDS = ["parentId", "targetId", "fromId", "firstKeptId", "restoreCheckpointId"];
var INTEGRITY = { alg: "sha256", canon: "jcs" };
var DOMAIN = {
  transcript: "atxf/0.1/transcript\n",
  content: "atxf/0.1/content\n",
  record: "atxf/0.1/record\n",
  chain: "atxf/0.1/chain\n"
};
function digest(domain, text2) {
  return `sha256:${sha256(domain + text2)}`;
}
function withoutHash(record) {
  const { hash: _, ...rest } = record;
  return rest;
}
function hashHeader(header2) {
  return digest(DOMAIN.transcript, canonicalJson(withoutHash(header2)));
}
function contentDigest(record) {
  return digest(DOMAIN.content, canonicalJson(withoutHash(record)));
}
function referencesOf(record) {
  const refs = {};
  for (const field of REFERENCE_FIELDS) {
    const value = record[field];
    if (typeof value === "string" || value === null)
      refs[field] = value;
  }
  return refs;
}
function hashFromInput(input) {
  return digest(DOMAIN.record, canonicalJson(input));
}
function hashInput(record, transcript, resolve4) {
  const refs = {};
  for (const [field, id] of Object.entries(referencesOf(record))) {
    if (id === null) {
      refs[field] = null;
      continue;
    }
    const target = resolve4(id);
    if (target === void 0)
      throw new Error(`record \`${record.id}\`: ${field} \`${id}\` has no earlier hashed record`);
    refs[field] = target;
  }
  return { transcript, content: contentDigest(record), refs };
}
function hashRecord(record, transcript, resolve4) {
  return hashFromInput(hashInput(record, transcript, resolve4));
}
function chainStep(previous2, recordHash) {
  return digest(DOMAIN.chain, `${previous2}
${recordHash}`);
}
var TranscriptHasher = class {
  header;
  transcriptHash;
  hashes = /* @__PURE__ */ new Map();
  referenced = /* @__PURE__ */ new Set();
  dagIds = [];
  chain;
  count = 0;
  constructor(header2) {
    this.header = { ...header2, integrity: INTEGRITY };
    this.transcriptHash = hashHeader(this.header);
    this.header.hash = this.transcriptHash;
    this.chain = this.transcriptHash;
  }
  hashOf(id) {
    return this.hashes.get(id);
  }
  /** Hash the next record in file order. A seal is checked against the records before it. */
  push(record) {
    const hash2 = hashRecord(record, this.transcriptHash, (id) => this.hashes.get(id));
    if (record.type !== "seal") {
      for (const id of Object.values(referencesOf(record)))
        if (id !== null && id !== void 0)
          this.referenced.add(id);
      this.dagIds.push(record.id);
    }
    this.hashes.set(record.id, hash2);
    this.chain = chainStep(this.chain, hash2);
    this.count += 1;
    return { ...record, hash: hash2 };
  }
  /** The commitment a `seal` record appended now would carry. */
  commitment() {
    const heads = this.dagIds.filter((id) => !this.referenced.has(id)).map((id) => this.hashes.get(id)).sort();
    return { count: this.count, chain: this.chain, heads };
  }
  seal(id, time) {
    return this.push({ type: "seal", id, time, ...this.commitment() });
  }
};
function addIntegrity(transcript, options = {}) {
  const hasher = new TranscriptHasher(withoutHash(transcript.header));
  const records = [];
  for (const record of transcript.records) {
    const unhashed = withoutHash(record);
    records.push(unhashed.type === "seal" ? hasher.seal(unhashed.id, unhashed.time) : hasher.push(unhashed));
  }
  if (options.seal)
    records.push(hasher.seal(options.seal.id, options.seal.time));
  return { header: hasher.header, records };
}

// node_modules/@leostera/atxf/dist/native.js
function jsonlLine(value) {
  return `${JSON.stringify(value)}
`;
}
var jsonl = {
  parse(text2) {
    const units2 = [];
    let leading = "";
    for (const line of text2.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
      if (line.trim() === "") {
        if (units2.length === 0)
          leading += line;
        else
          units2[units2.length - 1].raw += line;
        continue;
      }
      let value = null;
      try {
        value = JSON.parse(line);
      } catch {
      }
      units2.push({ value, raw: leading + line });
      leading = "";
    }
    if (leading !== "") {
      units2.push({ value: null, raw: leading });
    }
    return units2;
  },
  print(units2) {
    return units2.map((unit) => unit.raw).join("");
  },
  canonical: jsonlLine
};
function nativeOf(units2, source, format, canonical2 = jsonlLine) {
  const records = units2.map((unit) => unit.value);
  const exact = units2.some((unit) => unit.raw !== canonical2(unit.value));
  return {
    source,
    ...format ? { format } : {},
    records,
    ...exact ? { raw: units2.map((unit) => unit.raw) } : {}
  };
}
function nativeOfShared(of, source, format) {
  return { source, ...format ? { format } : {}, records: [], of };
}
function unitsOfNative(native, canonical2 = jsonlLine) {
  return native.records.map((value, index) => ({ value, raw: native.raw?.[index] ?? canonical2(value) }));
}
function isPureNative(transcript, agent) {
  const { header: header2, records } = transcript;
  if (header2.source.agent !== agent || header2.fidelity?.native !== "all")
    return false;
  if (header2.native !== void 0 && header2.native.source !== agent)
    return false;
  return records.every((record) => record.native?.source === agent);
}
function nativeUnits(transcript, canonical2 = jsonlLine) {
  const units2 = [];
  if (transcript.header.native)
    units2.push(...unitsOfNative(transcript.header.native, canonical2));
  for (const record of transcript.records)
    units2.push(...unitsOfNative(record.native, canonical2));
  return units2;
}

// node_modules/@leostera/atxf/dist/codec.js
function defineConverter(spec, defaults = {}) {
  const toAtxf = (text2, options = {}) => {
    const integrity = options.integrity ?? defaults.integrity ?? true;
    const units2 = spec.framing.parse(text2);
    const carried = spec.carrier.detach(units2);
    if (!carried) {
      const decoded2 = spec.decode(units2, { known: /* @__PURE__ */ new Map(), ids: new IdAllocator() });
      const header2 = { ...decoded2.header, fidelity: { ...decoded2.header.fidelity, nativeDigest: nativeDigest(text2) } };
      const transcript2 = { header: header2, records: decoded2.records };
      return integrity ? addIntegrity(transcript2) : transcript2;
    }
    const base = carried.transcript;
    const known = /* @__PURE__ */ new Map();
    carried.units.forEach((unit, index) => {
      const mark = spec.carrier.markOf(unit.value);
      if (mark !== void 0)
        known.set(index, mark);
    });
    if (known.size === carried.units.length)
      return base;
    const last = Math.max(...known.keys());
    if (Number.isFinite(last))
      known.set(last, indexTree(base).activeLeaf);
    const ids = new IdAllocator(base.records.map((record) => record.id));
    const decoded = spec.decode(carried.units, { known, base, ids });
    const transcript = { header: base.header, records: [...base.records, ...decoded.records] };
    return base.header.integrity ? addIntegrity(transcript) : transcript;
  };
  const fromAtxf = (transcript, options = {}) => {
    const carry = options.carry ?? true;
    const sameSession = options.sessionId === void 0 || options.sessionId === transcript.header.source.sessionId;
    if (carry && sameSession && isPureNative(transcript, spec.agent)) {
      const text2 = spec.framing.print(nativeUnits(transcript, spec.framing.canonical));
      const digest2 = transcript.header.fidelity?.nativeDigest;
      if (digest2 !== void 0 ? digest2 === nativeDigest(text2) : sameRecords(toAtxf(text2, { integrity: false }), transcript))
        return text2;
    }
    const encoded = spec.encode(transcript, { sessionId: options.sessionId });
    const values = carry ? spec.carrier.attach(encoded.map(({ value, source }) => spec.carrier.mark(value, source)), transcript) : encoded.map(({ value }) => value);
    return spec.framing.print(values.map((value) => ({ value, raw: spec.framing.canonical(value) })));
  };
  const reader = spec.reader;
  const stream = reader && ((options = {}) => {
    const integrity = options.integrity ?? defaults.integrity ?? true;
    const read = reader({ known: /* @__PURE__ */ new Map(), ids: new IdAllocator() });
    let header2;
    let hasher;
    let index = 0;
    return {
      get header() {
        return hasher?.header ?? header2;
      },
      push(line) {
        if (line.trim() === "" || line.includes("\n"))
          throw new RangeError("a stream reads one record per line; blank lines belong to a file");
        const unit = spec.framing.parse(`${line}
`)[0];
        if (spec.carrier.detach([unit]))
          throw new RangeError("a line carrying a transcript is read with toAtxf, with the rest of its file");
        if (header2 === void 0) {
          const started = read.start(unit);
          header2 = started.header;
          if (integrity)
            hasher = new TranscriptHasher(header2);
          if (started.took) {
            index += 1;
            return [];
          }
        }
        const record = read.next(unit, index);
        index += 1;
        if (record === void 0)
          return [];
        return [hasher ? hasher.push(record) : record];
      }
    };
  });
  return { agent: spec.agent, format: spec.format, toAtxf, fromAtxf, ...stream ? { stream } : {} };
}
function nativeDigest(text2) {
  return `sha256:${sha256(text2)}`;
}
function sameRecords(a, b) {
  if (a.records.length !== b.records.length)
    return false;
  const header2 = ({ hash: _h, integrity: _i, fidelity, ...rest }) => canonicalJson({ ...rest, fidelity: fidelity && { ...fidelity, nativeDigest: void 0 } });
  if (header2(a.header) !== header2(b.header))
    return false;
  const record = ({ hash: _, ...rest }) => canonicalJson(rest);
  return a.records.every((r, i) => record(r) === record(b.records[i]));
}
function carriedValue(transcript) {
  return { header: transcript.header, records: transcript.records };
}

// node_modules/@leostera/atxf/dist/decode-helpers.js
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
var RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;
function isoTime(value, fallback) {
  if (typeof value === "string" && RFC3339.test(value) && !Number.isNaN(Date.parse(value)))
    return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime()) && date.getUTCFullYear() >= 1970 && date.getUTCFullYear() < 1e4) {
      return date.toISOString();
    }
  }
  return fallback;
}
var EPOCH = "1970-01-01T00:00:00.000Z";
var TreeBuilder = class {
  context;
  retain;
  /** Every record pushed, in order, unless built with `retain: false` to read a file of any length as a stream. */
  records = [];
  resolved = /* @__PURE__ */ new Map();
  parents = /* @__PURE__ */ new Map();
  types = /* @__PURE__ */ new Map();
  /** Tool call id → the assistant messages holding it, in order. Ids are unique along a path, not across branches. */
  toolCalls = /* @__PURE__ */ new Map();
  /** The last tree record, in file order: the parent for formats without explicit parent links. */
  last = null;
  /** The carried transcript's active leaf, in a continuation. */
  continuesFrom = null;
  constructor(context, retain = true) {
    this.context = context;
    this.retain = retain;
    for (const record of context.base?.records ?? [])
      this.observe(record);
    if (context.base)
      this.last = this.continuesFrom = indexTree(context.base).activeLeaf;
  }
  observe(record) {
    if (isTreeRecord(record)) {
      this.parents.set(record.id, record.parentId);
      this.types.set(record.id, record.type);
      this.last = record.id;
    }
    if (record.type === "message" && record.role === "assistant") {
      for (const block of record.content)
        if (block.type === "tool_call")
          this.toolCalls.set(block.id, [...this.toolCalls.get(block.id) ?? [], record.id]);
    }
  }
  /** Map a native id to the ATXF tree record it resolves to. */
  alias(nativeId, atxfId) {
    if (typeof nativeId === "string")
      this.resolved.set(nativeId, atxfId);
  }
  /** The ATXF tree record a native reference points to, or `null` when unknown. */
  resolve(nativeId) {
    if (typeof nativeId !== "string")
      return null;
    return this.resolved.get(nativeId) ?? null;
  }
  /**
   * The ATXF parent for a native parent reference. In a continuation, everything the agent appended continues the
   * carried transcript, so a native root (`null`, as an agent writes for the first record of an empty file) is
   * where the transcript is: its active leaf.
   */
  parentOf(nativeId) {
    if (nativeId === null && this.context.base)
      return this.continuesFrom;
    return this.resolve(nativeId);
  }
  /** Whether `nativeId` has been seen, even if it resolves to no record. */
  knows(nativeId) {
    return typeof nativeId === "string" && this.resolved.has(nativeId);
  }
  isNode(id) {
    return typeof id === "string" && this.parents.has(id);
  }
  typeOf(id) {
    return this.types.get(id);
  }
  isAncestor(ancestor, of) {
    const seen = /* @__PURE__ */ new Set();
    for (let cursor = of; cursor !== null && cursor !== void 0 && !seen.has(cursor); cursor = this.parents.get(cursor) ?? null) {
      if (cursor === ancestor)
        return true;
      seen.add(cursor);
    }
    return false;
  }
  /** The assistant message that issued tool call `id`: the one on the path to `at`, else the latest. */
  toolCallOwner(id, at) {
    const owners = this.toolCalls.get(id) ?? [];
    return (at === void 0 ? void 0 : owners.findLast((owner) => this.isAncestor(owner, at))) ?? owners.at(-1);
  }
  hasToolCall(id) {
    return this.toolCalls.has(id);
  }
  push(record, native) {
    const full = native ? { ...record, native } : record;
    if (this.retain)
      this.records.push(full);
    this.observe(full);
    return full;
  }
};
function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== void 0));
}

// node_modules/@leostera/atxf/dist/version.js
var ATXF_VERSION = "0.1";

// node_modules/@leostera/atxf/dist/formats/claude-code.js
var AGENT = "claude-code";
var FORMAT = "claude-code/session-jsonl";
function decode(units2, context) {
  const tree = new TreeBuilder(context);
  const native = (unit) => nativeOf([unit], AGENT, FORMAT);
  const header2 = sessionHeader(units2);
  units2.forEach((unit, index) => {
    const entry = isObject(unit.value) ? unit.value : {};
    if (context.known.has(index)) {
      if (typeof entry.uuid === "string")
        tree.alias(entry.uuid, context.known.get(index) ?? tree.parentOf(entry.parentUuid));
      return;
    }
    const time = isoTime(entry.timestamp, header2.time);
    const id = context.ids.take(typeof entry.uuid === "string" && entry.uuid !== "" ? entry.uuid : `claude-line-${index + 1}`);
    const parentId = "parentUuid" in entry ? tree.parentOf(entry.parentUuid) : tree.last;
    const node = { id, parentId, time };
    const custom = (name) => {
      tree.alias(entry.uuid, id);
      tree.push({ type: "custom", ...node, namespace: AGENT, name }, native(unit));
    };
    switch (entry.type) {
      case "user": {
        const records = userRecords(entry, node, tree);
        if (records.length === 0)
          return custom("user");
        tree.alias(entry.uuid, records.at(-1).id);
        records.forEach((record, i) => tree.push(record, i === 0 ? native(unit) : nativeOfShared(records[0].id, AGENT, FORMAT)));
        return;
      }
      case "assistant": {
        const body = assistantBody(entry, tree);
        if (!body)
          return custom("assistant");
        tree.alias(entry.uuid, id);
        tree.push({ type: "message", ...node, ...body }, native(unit));
        return;
      }
      case "summary":
      case "custom-title":
      case "ai-title": {
        const title = [entry.summary, entry.customTitle, entry.aiTitle, entry.title].find((value) => typeof value === "string");
        if (title === void 0)
          return custom(entry.type);
        tree.alias(entry.uuid, parentId);
        tree.push({ type: "metadata", id, time, title }, native(unit));
        return;
      }
      case "last-prompt": {
        const targetId = tree.resolve(entry.leafUuid);
        if (targetId === null)
          return custom("last-prompt");
        tree.push({ type: "leaf", id, time, targetId, reason: "navigate" }, native(unit));
        return;
      }
      case "file-history-snapshot":
        tree.alias(entry.uuid, id);
        tree.push(compact({ type: "checkpoint", ...node, snapshot: typeof entry.messageId === "string" ? entry.messageId : void 0 }), native(unit));
        return;
      case "system":
        return custom(typeof entry.subtype === "string" ? `system:${entry.subtype}` : "system");
      case "attachment":
        return custom(isObject(entry.attachment) && typeof entry.attachment.type === "string" ? `attachment:${entry.attachment.type}` : "attachment");
      default:
        return custom(typeof entry.type === "string" ? entry.type : "unparsed");
    }
  });
  return { header: header2, records: tree.records };
}
function sessionHeader(units2) {
  const entries = units2.map((unit) => unit.value).filter(isObject);
  const first = entries.find((entry) => typeof entry.sessionId === "string") ?? {};
  const withCwd = entries.find((entry) => typeof entry.cwd === "string");
  const withTime = entries.find((entry) => isoTime(entry.timestamp, "") !== "");
  const withBranch = entries.find((entry) => typeof entry.gitBranch === "string");
  return compact({
    type: "transcript",
    atxf: ATXF_VERSION,
    id: typeof first.sessionId === "string" && first.sessionId !== "" ? first.sessionId : "claude-code-session",
    time: isoTime(withTime?.timestamp, EPOCH),
    source: compact({
      agent: AGENT,
      format: FORMAT,
      version: typeof first.version === "string" ? first.version : void 0,
      sessionId: typeof first.sessionId === "string" ? first.sessionId : void 0
    }),
    workspace: withCwd || withBranch ? compact({ cwd: withCwd?.cwd, vcs: withBranch ? { type: "git", branch: withBranch.gitBranch } : void 0 }) : void 0,
    fidelity: { topology: "tree", instructions: "none", tools: "none", native: "all", ids: "stable" }
  });
}
function userRecords(entry, node, tree) {
  const message = entry.message;
  if (!isObject(message))
    return [];
  if (entry.isCompactSummary === true) {
    const summary = textOf2(message.content);
    if (node.parentId === null || tree.typeOf(node.parentId) === "custom") {
      return [{ type: "compaction", ...node, strategy: "summary", summary, firstKeptId: null }];
    }
    return [{ type: "branch_summary", ...node, fromId: node.parentId, summary }];
  }
  const display = entry.isMeta === true ? { display: false } : {};
  if (typeof message.content === "string")
    return [{ type: "message", ...node, role: "user", content: message.content, ...display }];
  if (!Array.isArray(message.content))
    return [];
  const records = [];
  const blocks = [];
  let parentId = node.parentId;
  for (const block of message.content) {
    if (!isObject(block))
      continue;
    if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
      const owner = tree.toolCallOwner(block.tool_use_id, parentId);
      if (owner !== void 0 && !tree.isAncestor(owner, parentId))
        continue;
      const id = records.length === 0 ? node.id : tree.context.ids.take(`${node.id}:${block.tool_use_id}`);
      records.push(compact({
        type: "message",
        id,
        parentId,
        time: node.time,
        role: "tool",
        toolCallId: block.tool_use_id,
        content: toolResultContent(block.content),
        isError: block.is_error === true ? true : void 0
      }));
      parentId = id;
    } else {
      const converted2 = userBlock(block);
      if (converted2)
        blocks.push(converted2);
    }
  }
  if (blocks.length > 0) {
    const id = records.length === 0 ? node.id : tree.context.ids.take(`${node.id}:text`);
    records.push({ type: "message", id, parentId, time: node.time, role: "user", content: blocks, ...display });
  }
  return records;
}
function userBlock(block) {
  if (block.type === "text" && typeof block.text === "string")
    return { type: "text", text: block.text };
  if (block.type === "image" && isObject(block.source)) {
    const source = block.source;
    if (source.type === "base64" && typeof source.media_type === "string") {
      return compact({ type: "image", mediaType: source.media_type, data: typeof source.data === "string" ? source.data : void 0 });
    }
    if (source.type === "url" && typeof source.url === "string")
      return { type: "image", mediaType: "image/*", uri: source.url };
  }
  return void 0;
}
function toolResultContent(content2) {
  if (typeof content2 === "string")
    return content2;
  if (!Array.isArray(content2))
    return "";
  return content2.flatMap((block) => isObject(block) ? [userBlock(block)].filter((b) => b !== void 0) : []);
}
function textOf2(content2) {
  if (typeof content2 === "string")
    return content2;
  if (!Array.isArray(content2))
    return "";
  return content2.flatMap((block) => isObject(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n");
}
var STOPS = {
  end_turn: "end",
  stop_sequence: "end",
  tool_use: "tool_use",
  max_tokens: "max_tokens",
  refusal: "refusal"
};
function assistantBody(entry, tree) {
  const message = entry.message;
  if (!isObject(message) || !Array.isArray(message.content))
    return void 0;
  const model = typeof message.model === "string" ? { provider: "anthropic", id: message.model } : void 0;
  const signature = (data, kind) => typeof data === "string" && data !== "" ? [compact({ provider: "anthropic", model: model?.id, kind, data })] : void 0;
  const content2 = [];
  for (const block of message.content) {
    if (!isObject(block))
      continue;
    if (block.type === "text" && typeof block.text === "string")
      content2.push({ type: "text", text: block.text });
    else if (block.type === "thinking" && typeof block.thinking === "string") {
      content2.push(compact({ type: "reasoning", text: block.thinking, replay: signature(block.signature, "signature") }));
    } else if (block.type === "redacted_thinking") {
      content2.push(compact({ type: "reasoning", redacted: true, replay: signature(block.data, "redacted_thinking") }));
    } else if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string" && !tree.hasToolCall(block.id)) {
      content2.push({ type: "tool_call", id: block.id, name: block.name, arguments: isObject(block.input) ? block.input : {} });
    }
  }
  const stop2 = typeof message.stop_reason === "string" ? STOPS[message.stop_reason] ?? "other" : void 0;
  return compact({
    role: "assistant",
    content: content2,
    model,
    usage: usageOf(message.usage),
    stop: stop2,
    rawStop: stop2 === "other" ? message.stop_reason : void 0,
    responseId: typeof message.id === "string" ? message.id : void 0,
    error: entry.isApiErrorMessage === true ? { message: textOf2(message.content) || "API error" } : void 0
  });
}
function usageOf(value) {
  if (!isObject(value))
    return void 0;
  const n = (v) => typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : void 0;
  const input = n(value.input_tokens);
  const output = n(value.output_tokens);
  if (input === void 0 || output === void 0)
    return void 0;
  return compact({ input, output, cacheRead: n(value.cache_read_input_tokens), cacheWrite: n(value.cache_creation_input_tokens) });
}
function uuidFor(id) {
  const h = sha256(`atxf:${id}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${(parseInt(h[16], 16) & 3 | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
var CLAUDE_STOPS = {
  end: "end_turn",
  tool_use: "tool_use",
  max_tokens: "max_tokens",
  error: "end_turn",
  aborted: "end_turn",
  refusal: "refusal",
  other: "end_turn"
};
function encode(transcript) {
  const context = buildContext(transcript);
  const times = new Map(transcript.records.map((record) => [record.id, record.time]));
  const sessionId = transcript.header.source.sessionId ?? transcript.header.id;
  const cwd = transcript.header.workspace?.cwd ?? context.settings.cwd ?? "/";
  const out = [];
  const used = /* @__PURE__ */ new Set();
  let parentUuid = null;
  let time = transcript.header.time;
  const line = (fields, source) => {
    time = times.get(source) ?? time;
    let uuid = uuidFor(source);
    for (let n = 2; used.has(uuid); n++)
      uuid = uuidFor(`${source}#${n}`);
    used.add(uuid);
    out.push({ value: { parentUuid, isSidechain: false, ...fields, uuid, timestamp: time, cwd, sessionId, version: "atxf" }, source });
    parentUuid = uuid;
  };
  for (const message of context.messages) {
    const body = message.body;
    if (message.kind === "compaction_summary" || message.kind === "branch_summary") {
      line({ type: "user", isCompactSummary: true, message: { role: "user", content: textOf2(body.content) } }, message.sourceId);
      continue;
    }
    switch (body.role) {
      case "system":
      case "user": {
        const hidden = body.role === "system" || body.display === false || body.origin !== void 0 && body.origin.kind !== "human";
        line({ type: "user", ...hidden ? { isMeta: true } : {}, message: { role: "user", content: claudeContent(body.content) } }, message.sourceId);
        break;
      }
      case "tool":
        line({
          type: "user",
          message: {
            role: "user",
            content: [compact({ type: "tool_result", tool_use_id: body.toolCallId, content: claudeContent(body.content), is_error: body.isError ? true : void 0 })]
          }
        }, message.sourceId);
        break;
      case "assistant": {
        const content2 = body.content.flatMap((block) => {
          switch (block.type) {
            case "text":
              return [{ type: "text", text: block.text }];
            case "reasoning": {
              const signature = block.replay?.find((r) => r.provider === "anthropic" && r.kind === "signature")?.data;
              return [compact({ type: "thinking", thinking: block.text ?? (block.summary ?? []).join("\n"), signature })];
            }
            case "tool_call":
              return [{ type: "tool_use", id: block.id, name: block.name, input: block.arguments ?? { input: block.input } }];
            case "image":
              return [];
          }
        });
        line({
          type: "assistant",
          message: compact({
            model: body.model?.id ?? "unknown",
            id: body.responseId ?? `msg_${message.sourceId}`,
            type: "message",
            role: "assistant",
            content: content2,
            stop_reason: CLAUDE_STOPS[body.stop ?? "end"],
            usage: {
              input_tokens: body.usage?.input ?? 0,
              output_tokens: body.usage?.output ?? 0,
              cache_read_input_tokens: body.usage?.cacheRead ?? 0,
              cache_creation_input_tokens: body.usage?.cacheWrite ?? 0
            }
          })
        }, message.sourceId);
        break;
      }
    }
  }
  return out;
}
function claudeContent(content2) {
  if (typeof content2 === "string")
    return content2;
  return content2.map((block) => {
    if (block.type === "text")
      return { type: "text", text: block.text };
    if (block.type === "image" && block.data !== void 0)
      return { type: "image", source: { type: "base64", media_type: block.mediaType, data: block.data } };
    if (block.type === "image")
      return { type: "image", source: { type: "url", url: block.uri ?? "" } };
    return { type: "text", text: block.text ?? `[${block.uri}]` };
  });
}
var carrier = {
  mark(value, source) {
    return { ...value, atxf: { id: source } };
  },
  markOf(value) {
    return isObject(value) && isObject(value.atxf) && "id" in value.atxf ? value.atxf.id : void 0;
  },
  attach(values, transcript) {
    return [{ type: "atxf", transcript: carriedValue(transcript) }, ...values];
  },
  detach(units2) {
    const index = units2.findIndex((unit) => isObject(unit.value) && unit.value.type === "atxf" && isObject(unit.value.transcript));
    if (index === -1)
      return void 0;
    return { transcript: units2[index].value.transcript, units: units2.filter((_, i) => i !== index) };
  }
};
var claudeCode = defineConverter({ agent: AGENT, format: FORMAT, framing: jsonl, decode, encode, carrier });

// node_modules/@leostera/atxf/dist/formats/codex.js
var AGENT2 = "codex";
var FORMAT2 = "codex/rollout-jsonl";
function decode2(units2, context) {
  const tree = new TreeBuilder(context);
  const native = (unit) => nativeOf([unit], AGENT2, FORMAT2);
  let start = 0;
  let header2;
  const first = units2[0]?.value;
  if (isObject(first) && first.type === "session_meta" && isObject(first.payload) && !context.known.has(0)) {
    header2 = sessionHeader2(first, native(units2[0]));
    start = 1;
  } else {
    header2 = sessionHeader2({}, void 0);
  }
  let provider = isObject(first) && isObject(first.payload) && typeof first.payload.model_provider === "string" ? first.payload.model_provider : "openai";
  let turns = 0;
  for (let index = start; index < units2.length; index++) {
    const unit = units2[index];
    if (context.known.has(index)) {
      const known = context.known.get(index);
      if (known)
        tree.last = known;
      continue;
    }
    const line = isObject(unit.value) ? unit.value : {};
    const payload = isObject(line.payload) ? line.payload : {};
    const id = context.ids.take(`codex-${index + 1}`);
    const node = { id, parentId: tree.last, time: isoTime(line.timestamp, header2.time) };
    const push = (record) => tree.push(record, native(unit));
    const custom = (name) => push({ type: "custom", ...node, namespace: AGENT2, name });
    switch (line.type) {
      case "response_item": {
        const body = responseItem(payload, tree);
        if (!body) {
          custom(`response_item:${typeof payload.type === "string" ? payload.type : "unknown"}`);
          break;
        }
        push({ type: "message", ...node, ...body });
        break;
      }
      case "turn_context":
        if (typeof payload.model === "string")
          provider = typeof payload.model_provider === "string" ? payload.model_provider : provider;
        push(compact({
          type: "settings",
          ...node,
          model: typeof payload.model === "string" ? { provider, id: payload.model } : void 0,
          reasoningEffort: typeof payload.effort === "string" ? payload.effort : void 0,
          cwd: typeof payload.cwd === "string" ? payload.cwd : void 0,
          policy: payload.approval_policy !== void 0 || payload.sandbox_policy !== void 0 ? compact({ approval: payload.approval_policy, sandbox: payload.sandbox_policy }) : void 0
        }));
        break;
      case "compacted": {
        const replacement = Array.isArray(payload.replacement_history) ? payload.replacement_history.flatMap((item) => {
          const body = isObject(item) ? responseItem(isObject(item.item) ? item.item : item, void 0) : void 0;
          return body && body.role !== "tool" ? [body] : [];
        }) : void 0;
        if (replacement && replacement.length > 0)
          push({ type: "compaction", ...node, strategy: "replace", replacement });
        else if (typeof payload.message === "string")
          push({ type: "compaction", ...node, strategy: "summary", summary: payload.message, firstKeptId: null });
        else
          custom("compacted");
        break;
      }
      case "event_msg": {
        const event = typeof payload.type === "string" ? payload.type : "unknown";
        if (event === "task_started" || event === "turn_started") {
          push({ type: "turn", ...node, phase: "start", turnId: typeof payload.turn_id === "string" ? payload.turn_id : `turn-${++turns}` });
        } else if (event === "task_complete" || event === "turn_complete" || event === "turn_aborted") {
          push({
            type: "turn",
            ...node,
            phase: "end",
            turnId: typeof payload.turn_id === "string" ? payload.turn_id : `turn-${turns}`,
            outcome: event === "turn_aborted" ? "interrupted" : "succeeded"
          });
        } else if (event === "token_count" && isObject(payload.info) && tokenUsage(payload.info.total_token_usage)) {
          push({ type: "usage", ...node, kind: "token_count", usage: tokenUsage(payload.info.total_token_usage), cumulative: true });
        } else {
          custom(`event_msg:${event}`);
        }
        break;
      }
      case "token_usage_record": {
        const usage = tokenUsage(payload.total_token_usage ?? payload.usage ?? payload);
        if (usage)
          push({ type: "usage", ...node, kind: "token_usage_record", usage, cumulative: true });
        else
          custom("token_usage_record");
        break;
      }
      default:
        custom(typeof line.type === "string" ? line.type : "unparsed");
    }
  }
  return { header: header2, records: tree.records };
}
function sessionHeader2(line, native) {
  const meta = isObject(line.payload) ? line.payload : {};
  const git = isObject(meta.git) ? meta.git : {};
  const parent = typeof meta.forked_from_id === "string" ? meta.forked_from_id : typeof meta.parent_thread_id === "string" ? meta.parent_thread_id : void 0;
  return compact({
    type: "transcript",
    atxf: ATXF_VERSION,
    id: typeof meta.id === "string" && meta.id !== "" ? meta.id : "codex-session",
    time: isoTime(meta.timestamp, isoTime(line.timestamp, EPOCH)),
    source: compact({
      agent: AGENT2,
      format: FORMAT2,
      version: typeof meta.cli_version === "string" ? meta.cli_version : void 0,
      sessionId: typeof meta.id === "string" ? meta.id : void 0
    }),
    workspace: typeof meta.cwd === "string" || typeof git.branch === "string" ? compact({
      cwd: typeof meta.cwd === "string" ? meta.cwd : void 0,
      vcs: typeof git.branch === "string" || typeof git.commit_hash === "string" ? compact({
        type: "git",
        branch: typeof git.branch === "string" ? git.branch : void 0,
        commit: typeof git.commit_hash === "string" ? git.commit_hash : void 0,
        remote: typeof git.repository_url === "string" ? git.repository_url : void 0
      }) : void 0
    }) : void 0,
    parent: parent ? { transcriptId: parent, relation: typeof meta.forked_from_id === "string" ? "fork" : "subagent" } : void 0,
    fidelity: {
      topology: "linear",
      instructions: "partial",
      turns: true,
      usage: "aggregate",
      native: "all",
      ids: "synthetic"
    },
    native
  });
}
function responseItem(item, tree) {
  switch (item.type) {
    case "message": {
      if (!Array.isArray(item.content))
        return void 0;
      if (item.role === "assistant") {
        const content3 = item.content.flatMap((part) => isObject(part) && typeof part.text === "string" ? [{ type: "text", text: part.text }] : []);
        return { role: "assistant", content: content3 };
      }
      const content2 = userContent(item.content);
      if (item.role === "developer" || item.role === "system")
        return { role: "system", content: content2 };
      return { role: "user", content: content2 };
    }
    case "reasoning": {
      const summary = Array.isArray(item.summary) ? item.summary.flatMap((s) => isObject(s) && typeof s.text === "string" ? [s.text] : []) : [];
      const text2 = Array.isArray(item.content) ? item.content.flatMap((c) => isObject(c) && typeof c.text === "string" ? [c.text] : []).join("\n") : void 0;
      const replay2 = typeof item.encrypted_content === "string" ? [{ provider: "openai", api: "responses", kind: "encrypted_content", data: item.encrypted_content }] : void 0;
      return {
        role: "assistant",
        content: [compact({ type: "reasoning", text: text2, summary: summary.length || text2 === void 0 && !replay2 ? summary : void 0, replay: replay2 })]
      };
    }
    case "function_call":
    case "custom_tool_call":
    case "local_shell_call":
    case "web_search_call": {
      if (!tree)
        return void 0;
      const id = typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : void 0;
      if (id === void 0 || tree.hasToolCall(id))
        return void 0;
      return { role: "assistant", content: [toolCall(item, id)] };
    }
    case "function_call_output":
    case "custom_tool_call_output": {
      if (typeof item.call_id !== "string" || !tree)
        return void 0;
      const output = item.output;
      const isError = isObject(output) && output.success === false ? true : void 0;
      const content2 = typeof output === "string" ? output : isObject(output) && typeof output.content === "string" ? output.content : Array.isArray(output) ? userContent(output) : "";
      return compact({ role: "tool", toolCallId: item.call_id, content: content2, isError });
    }
    default:
      return void 0;
  }
}
function toolCall(item, id) {
  switch (item.type) {
    case "function_call": {
      let args;
      try {
        args = JSON.parse(item.arguments);
      } catch {
        args = void 0;
      }
      return isObject(args) ? compact({ type: "tool_call", id, name: String(item.name ?? ""), kind: "function", namespace: typeof item.namespace === "string" ? item.namespace : void 0, arguments: args }) : { type: "tool_call", id, name: String(item.name ?? ""), kind: "function", input: typeof item.arguments === "string" ? item.arguments : "" };
    }
    case "custom_tool_call":
      return { type: "tool_call", id, name: String(item.name ?? ""), kind: "custom", input: typeof item.input === "string" ? item.input : "" };
    case "local_shell_call":
      return { type: "tool_call", id, name: "local_shell", kind: "builtin", arguments: isObject(item.action) ? item.action : {} };
    default:
      return { type: "tool_call", id, name: "web_search", kind: "builtin", arguments: isObject(item.action) ? item.action : {} };
  }
}
function userContent(parts) {
  const blocks = [];
  for (const part of parts) {
    if (!isObject(part))
      continue;
    if (typeof part.text === "string")
      blocks.push({ type: "text", text: part.text });
    else if (part.type === "input_image" && typeof part.image_url === "string") {
      const match = /^data:([^;]+);base64,(.*)$/s.exec(part.image_url);
      blocks.push(match ? { type: "image", mediaType: match[1], data: match[2] } : { type: "image", mediaType: "image/*", uri: part.image_url });
    }
  }
  return blocks;
}
function tokenUsage(value) {
  if (!isObject(value))
    return void 0;
  const n = (v) => typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : void 0;
  const input = n(value.input_tokens);
  const output = n(value.output_tokens);
  if (input === void 0 || output === void 0)
    return void 0;
  return compact({
    input,
    output,
    cacheRead: n(value.cached_input_tokens),
    cacheWrite: n(value.cache_write_input_tokens),
    reasoning: n(value.reasoning_output_tokens),
    total: n(value.total_tokens)
  });
}
function encode2(transcript) {
  const context = buildContext(transcript);
  const times = new Map(transcript.records.map((record) => [record.id, record.time]));
  const out = [];
  let time = transcript.header.time;
  const line = (type, payload, source) => {
    if (source)
      time = times.get(source) ?? time;
    out.push({ value: { timestamp: time, type, payload }, source });
  };
  const instructions = context.instructions.filter((s) => s.text !== null).map((s) => s.text).join("\n\n");
  line("session_meta", compact({
    id: transcript.header.source.sessionId ?? transcript.header.id,
    timestamp: transcript.header.time,
    cwd: transcript.header.workspace?.cwd ?? context.settings.cwd ?? "/",
    originator: "atxf",
    cli_version: "0.0.0",
    source: "cli",
    model_provider: context.settings.model?.provider,
    base_instructions: instructions ? { text: instructions } : void 0
  }), null);
  if (context.settings.model || context.settings.reasoningEffort || context.settings.cwd) {
    line("turn_context", compact({ cwd: context.settings.cwd ?? transcript.header.workspace?.cwd ?? "/", model: context.settings.model?.id, effort: context.settings.reasoningEffort }), null);
  }
  context.messages.forEach((message, index) => {
    const body = message.body;
    const source = message.sourceId;
    if (message.kind === "compaction_summary" || message.kind === "branch_summary") {
      if (index === 0)
        line("compacted", { message: textOf3(body.content) }, source);
      else
        line("response_item", { type: "message", role: "user", content: codexContent(body.content) }, source);
      return;
    }
    switch (body.role) {
      case "system":
      case "user": {
        const hidden = body.role === "system" || body.display === false || body.origin !== void 0 && body.origin.kind !== "human";
        line("response_item", { type: "message", role: hidden ? "developer" : "user", content: codexContent(body.content) }, source);
        break;
      }
      case "tool":
        line("response_item", { type: "function_call_output", call_id: body.toolCallId, output: body.isError ? { content: textOf3(body.content), success: false } : textOf3(body.content) }, source);
        break;
      case "assistant":
        if (body.content.length === 0)
          line("response_item", { type: "message", role: "assistant", content: [] }, source);
        for (const block of body.content) {
          if (block.type === "reasoning") {
            const encrypted = block.replay?.find((r) => r.provider === "openai" && r.kind === "encrypted_content")?.data;
            line("response_item", compact({
              type: "reasoning",
              summary: (block.summary ?? []).map((text2) => ({ type: "summary_text", text: text2 })),
              content: block.text !== void 0 ? [{ type: "reasoning_text", text: block.text }] : void 0,
              encrypted_content: typeof encrypted === "string" ? encrypted : null
            }), source);
          } else if (block.type === "text") {
            line("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: block.text }] }, source);
          } else if (block.type === "tool_call") {
            if (block.kind === "custom" || block.arguments === void 0 && block.input !== void 0) {
              line("response_item", { type: block.kind === "custom" ? "custom_tool_call" : "function_call", call_id: block.id, name: block.name, ...block.kind === "custom" ? { input: block.input ?? "" } : { arguments: block.input ?? "" } }, source);
            } else {
              line("response_item", compact({ type: "function_call", name: block.name, namespace: block.namespace, arguments: JSON.stringify(block.arguments ?? {}), call_id: block.id }), source);
            }
          }
        }
        break;
    }
  });
  return out;
}
function codexContent(content2) {
  if (typeof content2 === "string")
    return [{ type: "input_text", text: content2 }];
  return content2.map((block) => {
    if (block.type === "text")
      return { type: "input_text", text: block.text };
    if (block.type === "image")
      return { type: "input_image", image_url: block.data !== void 0 ? `data:${block.mediaType};base64,${block.data}` : block.uri ?? "" };
    return { type: "input_text", text: block.text ?? `[${block.uri}]` };
  });
}
function textOf3(content2) {
  if (typeof content2 === "string")
    return content2;
  return content2.map((block) => block.type === "text" ? block.text : block.type === "image" ? "[image]" : block.text ?? `[${block.uri}]`).join("\n");
}
var carrier2 = {
  mark(value, source) {
    return { ...value, atxf: { id: source } };
  },
  markOf(value) {
    return isObject(value) && isObject(value.atxf) && "id" in value.atxf ? value.atxf.id : void 0;
  },
  attach(values, transcript) {
    const [meta, ...rest] = values;
    return [meta, { timestamp: meta.timestamp, type: "atxf", payload: { transcript: carriedValue(transcript) } }, ...rest];
  },
  detach(units2) {
    const index = units2.findIndex((unit) => isObject(unit.value) && unit.value.type === "atxf" && isObject(unit.value.payload) && isObject(unit.value.payload.transcript));
    if (index === -1)
      return void 0;
    return { transcript: units2[index].value.payload.transcript, units: units2.filter((_, i) => i !== index) };
  }
};
var codex = defineConverter({ agent: AGENT2, format: FORMAT2, framing: jsonl, decode: decode2, encode: encode2, carrier: carrier2 });

// src/transcript.ts
function formatOf(path2) {
  if (!path2 || !existsSync5(path2)) return void 0;
  const fd = openSync(path2, "r");
  try {
    const head = readAt(fd, 0, 4096).toString("utf8");
    if (!head.trim()) return void 0;
    return /^\{[^\n]*"type"\s*:\s*"session_meta"/.test(head) ? "codex" : "claude-code";
  } finally {
    closeSync(fd);
  }
}
var START = { offset: 0, lines: 0, mark: "" };
var MAX_WINDOW = Number(process.env.BRAID_WINDOW_BYTES) || 16 * 1024 * 1024;
var OVERLAP = Math.min(2 * 1024 * 1024, Math.floor(MAX_WINDOW / 4));
var NL = 10;
function readAt(fd, start, length) {
  const buf = Buffer.alloc(length);
  let n = 0;
  while (n < length) {
    const r = readSync(fd, buf, n, length - n, start + n);
    if (r === 0) break;
    n += r;
  }
  return buf.subarray(0, n);
}
function newlines(buf, from, to) {
  let n = 0;
  for (let i = buf.indexOf(NL, from); i !== -1 && i < to; i = buf.indexOf(NL, i + 1)) n++;
  return n;
}
var hash = (buf) => createHash2("sha256").update(buf).digest("base64");
function intact(path2, cursor) {
  if (cursor.offset === 0) return true;
  const fd = openSync(path2, "r");
  try {
    if (fstatSync(fd).size < cursor.offset) return false;
    const start = lineAt(fd, cursor.offset - 1);
    return hash(readAt(fd, start, cursor.offset - start)) === cursor.mark;
  } finally {
    closeSync(fd);
  }
}
function renumber(records, base, session, format = "claude-code") {
  const tag = session.slice(0, 8);
  const prefix = format === "codex" ? "codex-" : "claude-line-";
  const fix = (v) => {
    const m = typeof v === "string" && v.startsWith(prefix) ? /^(\d+)(.*)$/.exec(v.slice(prefix.length)) : null;
    return m ? `${prefix}${Number(m[1]) + base}${m[2]}@${tag}` : v;
  };
  return records.map((r) => {
    const out = { ...r, id: fix(r.id) };
    for (const key of ["parentId", "targetId", "fromId"]) if (key in r) out[key] = fix(r[key]);
    const parentUuid = r.native?.records?.[0]?.parentUuid;
    if (out.parentId === null && typeof parentUuid === "string" && base > 0) out.parentId = parentUuid;
    const leafUuid = r.native?.records?.[0]?.leafUuid;
    if (out.type === "custom" && out.name === "last-prompt" && typeof leafUuid === "string" && base > 0)
      return { type: "leaf", id: out.id, time: out.time, targetId: leafUuid, reason: "navigate", native: out.native, ...out.ext ? { ext: out.ext } : {} };
    return out;
  });
}
function units(buf, from, to) {
  let n = 0;
  let filled = false;
  for (let i = from; i < to; i++) {
    const c = buf[i];
    if (c === NL) {
      if (filled) n++;
      filled = false;
    } else if (c !== 32 && c !== 9 && c !== 13) filled = true;
  }
  return filled ? n + 1 : n;
}
var codexLine = (id) => Number(/^codex-(\d+)@/.exec(id)?.[1] ?? Number.NaN);
function firstAfter(records, lines) {
  let seen = 0;
  for (let i = 0; i < records.length; i++) {
    const native = records[i].native;
    const own = native && !native.of ? native.records?.length ?? 0 : 0;
    if (own > 0 && seen >= lines) return i;
    seen += own;
  }
  return records.length;
}
function nativeIds(records) {
  const rename = /* @__PURE__ */ new Map();
  for (const r of records) {
    const uuid = r.native?.records?.[0]?.uuid;
    if (typeof uuid === "string" && r.id !== uuid && r.id.startsWith(`${uuid}-`) && /^\d+$/.test(r.id.slice(uuid.length + 1))) rename.set(r.id, uuid);
  }
  if (rename.size === 0) return records;
  const fix = (v) => {
    if (typeof v !== "string") return v;
    const colon = v.indexOf(":");
    const head = colon < 0 ? v : v.slice(0, colon);
    return rename.has(head) ? `${rename.get(head)}${colon < 0 ? "" : v.slice(colon)}` : v;
  };
  return records.map((r) => {
    const out = { ...r, id: fix(r.id) };
    for (const key of ["parentId", "targetId", "fromId"]) if (key in r) out[key] = fix(r[key]);
    const native = r.native;
    if (native?.of && rename.has(native.of.split(":")[0])) out.native = { ...native, of: fix(native.of) };
    return out;
  });
}
function lineAt(fd, pos) {
  const block = 64 * 1024;
  for (let end = pos; end > 0; ) {
    const start = Math.max(0, end - block);
    const i = readAt(fd, start, end - start).lastIndexOf(NL);
    if (i !== -1) return start + i + 1;
    end = start;
  }
  return 0;
}
function lastLine(buf, end) {
  return end < 2 ? 0 : buf.lastIndexOf(NL, end - 2) + 1;
}
function readWindow(path2, cursor, session, limits = {}, format = "claude-code") {
  const { maxBytes = MAX_WINDOW, overlap = OVERLAP, until = Infinity } = limits;
  const fd = openSync(path2, "r");
  try {
    const size = Math.min(fstatSync(fd).size, until);
    if (size <= cursor.offset) return void 0;
    const start = lineAt(fd, Math.max(0, cursor.offset - Math.max(1, overlap)));
    let end = Math.min(size, cursor.offset + maxBytes);
    let buf = readAt(fd, start, end - start);
    while (start + buf.lastIndexOf(NL) + 1 <= cursor.offset && end < size) {
      end = Math.min(size, end + maxBytes);
      buf = readAt(fd, start, end - start);
    }
    const used = buf.lastIndexOf(NL) + 1;
    if (start + used <= cursor.offset) return void 0;
    let header2;
    const base = cursor.lines - newlines(buf, 0, cursor.offset - start);
    const before = units(buf, 0, cursor.offset - start);
    const text2 = buf.toString("utf8", 0, used);
    let records;
    let fresh;
    if (format === "codex") {
      const t = codex.toAtxf(text2, { integrity: false });
      records = renumber(t.records, base, session, format);
      const meta = t.header.native;
      if (start === 0 && meta?.records?.length) {
        const id = `codex-1@${session.slice(0, 8)}`;
        const at2 = meta.records[0].timestamp;
        const time = typeof at2 === "string" ? at2 : String(t.header.time);
        records = [{ type: "custom", id, parentId: null, time, namespace: "codex", name: "session_meta", native: meta }, ...records.map((r, i) => i === 0 && r.parentId == null ? { ...r, parentId: id } : r)];
      }
      const at = records.findIndex((r) => codexLine(r.id) > base + before);
      fresh = at < 0 ? records.length : at;
      header2 = t.header;
    } else {
      const t = claudeCode.toAtxf(text2, { integrity: false });
      records = nativeIds(renumber(t.records, base, session));
      fresh = firstAfter(records, before);
      header2 = t.header;
    }
    return {
      records,
      fresh,
      header: header2,
      cursor: {
        offset: start + used,
        lines: base + newlines(buf, 0, used),
        mark: hash(buf.subarray(lastLine(buf, used), used))
      },
      more: end < size
    };
  } finally {
    closeSync(fd);
  }
}

// src/turns.ts
var startsTurn = (r) => isPrompt(r);
var turnName = (session, n) => `${session.slice(0, 8)}.${n}`;
var TURN = /^(.*)\.(\d+)$/;
function turnsOf(records) {
  const out = [{ n: 0, records: [] }];
  for (const r of records) {
    if (startsTurn(r)) out.push({ n: out.length, start: r, records: [] });
    out.at(-1).records.push(r);
  }
  return out;
}
function findTurn(repo, found, n) {
  const t = turnsOf(readRecords(repo, found.session)).find((t2) => t2.n === n && t2.start);
  return t && lastTurn(t.records) ? { found, n, until: t.records.at(-1).id } : void 0;
}
var EDITS = /* @__PURE__ */ new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch", "edit", "write"]);
function patchedFiles(patch) {
  if (!patch.includes("*** Begin Patch")) return [];
  return [...patch.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+?)\s*$/gm)].map((m) => m[1]);
}
function patchText(b) {
  const a = b.arguments ?? {};
  for (const v of [b.input, a.input, a.cmd, a.command, a.patch]) {
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return v.filter((x) => typeof x === "string").join("\n");
  }
  return "";
}
function turnStats(records) {
  const files = /* @__PURE__ */ new Set();
  let calls = 0;
  for (const r of records) {
    if (!Array.isArray(r.content)) continue;
    for (const b of r.content) {
      if (b?.type !== "tool_call") continue;
      calls++;
      const path2 = b.arguments?.file_path ?? b.arguments?.path ?? b.arguments?.notebook_path;
      if (EDITS.has(String(b.name)) && typeof path2 === "string") files.add(path2);
      for (const f of patchedFiles(patchText(b))) files.add(f);
    }
  }
  return { files: files.size, calls };
}
function turnDetail(records) {
  const { files, calls } = turnStats(records);
  const plural = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;
  return [files ? `${plural(files, "file")} edited` : "", calls ? plural(calls, "tool call") : ""].filter(Boolean).join(", ");
}

// src/version.ts
var VERSION = "0.4.0";

// src/save.ts
function actorId(repo) {
  return config("user.email", { cwd: repo.top }) ?? `${userInfo().username}@${hostname()}`;
}
function nativeVersion(r) {
  const native = r.native;
  const v = native?.source === "claude-code" ? native.records?.[0]?.version : void 0;
  return typeof v === "string" ? v : void 0;
}
function modelOf(r) {
  const m = r.model;
  return (r.role === "assistant" || r.type === "settings") && m?.id ? `${m.provider ?? "unknown"}:${m.id}` : void 0;
}
function harnessOf(state, path2, agent) {
  if (agent) return agent;
  if (state && (state.chunks > 0 || state.harness !== "claude-code")) return state.harness;
  return formatOf(path2) ?? state?.harness ?? "claude-code";
}
function header(h, session) {
  return {
    type: "transcript",
    atxf: "0.1",
    id: session,
    time: String(h.time ?? (/* @__PURE__ */ new Date()).toISOString()),
    ...h.title ? { title: h.title } : {},
    source: { agent: "braid", version: VERSION },
    ...h.workspace ? { workspace: h.workspace } : {},
    fidelity: { topology: "tree", native: "all" },
    ext: { braid: { version: 1 } }
  };
}
function unsavedOf(saved) {
  const left = /* @__PURE__ */ new Map();
  for (const r of saved) left.set(r.id, (left.get(r.id) ?? 0) + 1);
  return (r) => {
    const n = left.get(r.id) ?? 0;
    if (n > 0) left.set(r.id, n - 1);
    return n === 0;
  };
}
function save(repo, session, transcript, opts = {}) {
  ensureStore(repo);
  recordSession(session, { project: repo.top });
  return withLock(repo, `save-${session}`, () => {
    const prior = loadState(repo, session);
    const state = prior ?? newState(session, transcript);
    const firstSave = state.chunks === 0;
    if (transcript) state.transcript = transcript;
    const path2 = state.transcript;
    state.harness = harnessOf(prior, path2, opts.agent);
    const format = state.harness === "codex" ? "codex" : "claude-code";
    if (!path2 || !existsSync6(path2)) {
      saveState(repo, state);
      return { added: 0, state };
    }
    if (state.chunks > 0 && !state.title) Object.assign(state, about(readRecords(repo, session), state));
    const rewritten = state.cursor ? !intact(path2, state.cursor) : state.chunks > 0;
    let cursor = rewritten || !state.cursor ? START : state.cursor;
    const unseen = rewritten ? unsavedOf(readRecords(repo, session)) : void 0;
    let added = 0;
    const fresh = (w) => unseen ? w.records.slice(w.fresh).filter(unseen) : w.records.slice(w.fresh);
    const agents = format === "claude-code" ? collectAgents(repo, state, path2) : /* @__PURE__ */ new Map();
    const read = () => readWindow(path2, cursor, session, {}, format);
    let window = read();
    for (; ; ) {
      const records = window ? fresh(window) : [];
      const final = !window?.more;
      if (records.length > 0 || final && agents.size > 0) added += writeChunk(repo, state, records, window?.header, final ? agents : /* @__PURE__ */ new Map());
      if (window) cursor = window.cursor;
      state.cursor = cursor;
      if (final) break;
      window = read();
      if (!window) break;
    }
    saveState(repo, state);
    if (state.chunks > 0 && (firstSave || state.turn === void 0)) {
      state.turn = readRecords(repo, session).filter(startsTurn).length;
      saveState(repo, state);
    }
    return { added, state };
  });
}
function writeChunk(repo, state, fresh, nativeHeader, agents) {
  const session = state.session;
  const first = state.chunks === 0;
  for (const r of fresh) {
    state.userAgent = nativeVersion(r) ? `claude-code/${nativeVersion(r)}` : state.userAgent;
    state.model = modelOf(r) ?? state.model;
  }
  Object.assign(state, about(fresh, state));
  const version = nativeHeader?.source?.version;
  if (state.harness === "codex" && version && version !== "0.0.0") state.userAgent = `codex/${version}`;
  const actor = { actorId: actorId(repo), userAgent: state.userAgent ?? state.harness };
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const out = [];
  if (first) out.push(header(nativeHeader ?? {}, session));
  for (const r of fresh) out.push(withBraid({ ...r }, { actor, session }));
  const lastNative = fresh.at(-1)?.id ?? state.last ?? state.head ?? null;
  const agentRecords = /* @__PURE__ */ new Map();
  for (const [id, a] of agents) {
    agentRecords.set(id, a.records.map((r) => withBraid(r, { actor, session, agent: id })));
    if (!a.link) continue;
    const spawnedBy = toolCallRecord(repo, state, out, a.link.toolUseId) ?? lastNative;
    out.push({
      type: "agent_link",
      id: `braid-agent-${id}`,
      parentId: spawnedBy,
      time: now,
      relation: "spawn",
      transcriptId: id,
      ...a.link.agentType || a.link.description ? { agent: { name: a.link.agentType ?? "subagent", ...a.link.description ? { role: a.link.description } : {} } } : {},
      ...a.link.toolUseId ? { toolCallId: a.link.toolUseId } : {},
      ext: { braid: { actor, session } }
    });
  }
  if (out.length === 0 && agentRecords.size === 0) return 0;
  appendRecords(repo, session, out, agentRecords);
  state.last = fresh.at(-1)?.id ?? state.last;
  state.head = lastTurn(out) ?? state.head;
  if (state.turn !== void 0) state.turn += out.filter(startsTurn).length;
  state.chunks += 1;
  return out.length;
}
function collectAgents(repo, state, path2) {
  const out = /* @__PURE__ */ new Map();
  const dir = join5(path2.replace(/\.jsonl$/, ""), "subagents");
  if (!existsSync6(dir)) return out;
  state.agents ??= {};
  for (const file2 of readdirSync2(dir).sort()) {
    const id = /^agent-([A-Za-z0-9_-]+)\.jsonl$/.exec(file2)?.[1];
    if (!id) continue;
    const fp = join5(dir, file2);
    const prior = state.agents[id];
    const rescan = !!prior && !intact(fp, prior.cursor);
    const st = rescan || !prior ? { cursor: START, linked: prior?.linked } : prior;
    const unseen = rescan ? unsavedOf(readAgents(repo, state.session).get(id) ?? []) : void 0;
    const records = [];
    for (let w = readWindow(fp, st.cursor, id); w; w = w.more ? readWindow(fp, st.cursor, id) : void 0) {
      const fresh = unseen ? w.records.slice(w.fresh).filter(unseen) : w.records.slice(w.fresh);
      records.push(...fresh);
      st.cursor = w.cursor;
      st.last = fresh.at(-1)?.id ?? st.last;
    }
    state.agents[id] = st;
    if (records.length === 0) continue;
    let link;
    if (!st.linked) {
      st.linked = true;
      try {
        const meta = JSON.parse(readFileSync4(join5(dir, `agent-${id}.meta.json`), "utf8"));
        const str = (k) => typeof meta[k] === "string" ? meta[k] : void 0;
        link = { toolUseId: str("toolUseId"), description: str("description"), agentType: str("agentType") };
      } catch {
        link = {};
      }
    }
    out.set(id, { records, link });
  }
  return out;
}
function toolCallRecord(repo, state, out, id) {
  if (!id) return void 0;
  const holds = (r) => Array.isArray(r.content) && r.content.some((b) => b?.type === "tool_call" && b.id === id);
  return (out.find(holds) ?? readRecords(repo, state.session).findLast(holds))?.id;
}
function register(repo, session, transcript, agent, cwd) {
  ensureStore(repo);
  recordSession(session, { project: repo.top });
  const prior = loadState(repo, session);
  const state = prior ?? newState(session, transcript);
  if (transcript) state.transcript = transcript;
  state.harness = harnessOf(prior, state.transcript, agent);
  if (cwd) state.ran ??= checkoutOf(cwd);
  saveState(repo, state);
  return state;
}

// src/setup.ts
import { chmodSync, existsSync as existsSync8, mkdirSync as mkdirSync4, readFileSync as readFileSync5, renameSync as renameSync3, rmSync as rmSync3, writeFileSync as writeFileSync5 } from "node:fs";
import { homedir as homedir4 } from "node:os";
import { dirname as dirname2, join as join6, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// src/replay.ts
import { randomUUID } from "node:crypto";
import { closeSync as closeSync2, existsSync as existsSync7, openSync as openSync2, readSync as readSync2, realpathSync as realpathSync2 } from "node:fs";
function launchDir(transcript) {
  if (!transcript || !existsSync7(transcript)) return void 0;
  const buf = Buffer.alloc(256 * 1024);
  const fd = openSync2(transcript, "r");
  let n;
  try {
    n = readSync2(fd, buf, 0, buf.length, 0);
  } finally {
    closeSync2(fd);
  }
  for (const line of buf.subarray(0, n).toString("utf8").split("\n")) {
    try {
      const cwd = JSON.parse(line).cwd;
      if (typeof cwd === "string") return cwd;
    } catch {
    }
  }
  return void 0;
}
var shellWord = (s) => /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
function rewrite(value, pairs) {
  if (typeof value === "string") {
    let s = value;
    for (const [from, to] of pairs) if (from && from !== to) s = s.split(from).join(to);
    return s;
  }
  if (Array.isArray(value)) return value.map((v) => rewrite(v, pairs));
  if (value && typeof value === "object") {
    const obj = value;
    if (KEEP.has(String(obj.type))) return value;
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, k === "native" || k === "replay" ? v : rewrite(v, pairs)]));
  }
  return value;
}
var KEEP = /* @__PURE__ */ new Set(["reasoning", "thinking", "redacted_thinking", "image", "base64"]);
function ownLine(r) {
  const n = r.native;
  const line = n?.source === "claude-code" && n.records?.length === 1 ? n.records[0] : void 0;
  return line && typeof line === "object" ? line : void 0;
}
var readWith = (r) => r.native?.of;
var SOURCE_ONLY = /* @__PURE__ */ new Set(["api-request", "api-request-blob", "api-request-shape", "file-history-snapshot", "file-history-delta", "queue-operation", "last-prompt"]);
function keptUuids(boundary) {
  if (boundary?.subtype !== "compact_boundary") return [];
  const kept = boundary.compactMetadata?.preservedMessages;
  const list2 = kept?.allUuids ?? kept?.uuids;
  return Array.isArray(list2) ? list2.filter((u) => typeof u === "string") : [];
}
function forkRecords(all, own, head) {
  const path2 = contextPath(head, all);
  const mine = new Set(own.map((r) => r.id));
  const kept = new Set(path2[0] ? keptUuids(ownLine(path2[0])) : []);
  const compacted = path2[0] && ownLine(path2[0])?.subtype === "compact_boundary" ? path2[0].id : void 0;
  const from = Math.max(0, own.findIndex((r) => r.id === compacted));
  const before = [...[...kept].flatMap((u) => mine.has(u) || !all.has(u) ? [] : [all.get(u)]), ...path2.filter((r) => !mine.has(r.id))];
  const since = own.filter((r, i) => (i >= from || kept.has(r.id)) && !SOURCE_ONLY.has(String(ownLine(r)?.type)));
  return { records: [...before, ...since], path: path2 };
}
var linear = (records) => records.map((r, i) => ({ ...r, parentId: i ? records[i - 1].id : null }));
function asResponses(records) {
  let response;
  return records.map((r) => {
    if (r.type !== "message") return r;
    if (r.role !== "assistant" || ownLine(r) || typeof r.responseId === "string") {
      response = void 0;
      return r;
    }
    response ??= `msg_${r.id}`;
    return { ...r, responseId: response };
  });
}
function forkText(fork, session, cwd, pairs = []) {
  const { records, path: path2 } = fork;
  const header2 = { type: "transcript", atxf: "0.1", id: session, time: path2[0]?.time ?? (/* @__PURE__ */ new Date()).toISOString(), source: { agent: "braid", sessionId: session }, workspace: { cwd } };
  const encoded = claudeCode.fromAtxf({ header: header2, records: linear(asResponses(forModel(rewrite(asCodexShowed(path2, "claude-code"), pairs), "anthropic"))) }, { carry: false, sessionId: session }).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const byUuid = new Map(encoded.map((l) => [l.uuid, l]));
  const lines = [];
  const lineOf = /* @__PURE__ */ new Map();
  for (const r of records) {
    const own = ownLine(r);
    const of = readWith(r);
    if (own) lines.push({ r, line: rewrite(own, pairs) });
    else if (of && lineOf.has(of)) {
      lineOf.set(r.id, lineOf.get(of));
      continue;
    } else {
      const line = byUuid.get(uuidFor(r.id));
      if (!line) {
        const parent = r.parentId ? lineOf.get(r.parentId) : void 0;
        if (parent) lineOf.set(r.id, parent);
        continue;
      }
      lines.push({ r, line });
      let last = r.id;
      for (let n = 2; byUuid.has(uuidFor(`${r.id}#${n}`)); n++) {
        const id = `${r.id}#${n}`;
        lines.push({ r: { ...r, id, parentId: last }, line: byUuid.get(uuidFor(id)) });
        lineOf.set(id, uuidFor(id));
        last = id;
      }
      lineOf.set(r.id, uuidFor(last));
      continue;
    }
    lineOf.set(r.id, uuidFor(r.id));
  }
  const renamed = new Map(lines.flatMap(({ r, line }) => typeof line.uuid === "string" ? [[line.uuid, uuidFor(r.id)]] : []));
  const rename = (v) => typeof v === "string" ? renamed.get(v) ?? v : Array.isArray(v) ? v.map(rename) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rename(x)])) : v;
  let previous2 = null;
  const out = lines.map(({ r, line }) => {
    const next = { ...Object.fromEntries(Object.entries(line).map(([k, v]) => [k, k === "message" ? v : rename(v)])), sessionId: session };
    if ("uuid" in next) {
      const kept = typeof line.parentUuid === "string" && !renamed.has(line.parentUuid) ? line.parentUuid : previous2;
      const parent = r.parentId == null ? null : lineOf.get(r.parentId) ?? lineOf.get(r.parentId.split(":")[0]) ?? kept;
      Object.assign(next, { parentUuid: parent, uuid: uuidFor(r.id), isSidechain: false });
      previous2 = next.uuid;
    }
    return JSON.stringify(next);
  });
  return out.length ? `${out.join("\n")}
` : "";
}
function sourceCwd(records) {
  for (const r of records) {
    const ws = r.workspace?.cwd;
    if (r.type === "transcript" && typeof ws === "string") return ws;
    const native = r.native?.records?.[0]?.cwd;
    if (typeof native === "string") return native;
  }
  return void 0;
}
function replay(repo, found, to, opts = {}) {
  const read = readRecords(repo, found.session);
  const all = new Map(read.map((r) => [r.id, r]));
  const own = opts.until ? read.slice(0, read.findIndex((r) => r.id === opts.until) + 1) : read;
  if (opts.until && own.length === 0) throw new Error(`session ${found.session.slice(0, 8)} has no record ${opts.until}`);
  const head = lastTurn(own) ?? own.at(-1)?.id;
  if (!head) throw new Error(`session ${found.session.slice(0, 8)} has no records to replay`);
  const fork = forkRecords(all, own, head);
  const cwd = realpathSync2(opts.cwd ?? process.cwd());
  const from = sourceCwd([...all.values()]);
  const within = !!from && (from === cwd || cwd.startsWith(`${from}/`) || from.startsWith(`${cwd}/`));
  const pairs = from && !within ? [[from, cwd]] : [];
  const derived = uuidFor(`braid fork ${found.session} ${head} ${to.agent} ${cwd}`);
  const before = opts.fresh ? void 0 : to.existing(derived, cwd);
  if (before) return { session: derived, file: before, cwd, records: 0, existing: true };
  const target = locate(cwd);
  const session = opts.fresh || (loadState(target, derived)?.chunks ?? 0) > 0 ? randomUUID() : derived;
  const { file: file2, lines } = to.write(fork, all, cwd, pairs, session);
  const state = loadState(target, session) ?? newState(session, file2, to.agent);
  const upTo = own.findIndex((r) => r.id === head);
  const turn = own.slice(0, upTo + 1).filter(startsTurn).length;
  state.forkedFrom = { session: found.session, turn };
  state.turn = turn;
  Object.assign(state, about(head === lastTurn(read) ? read : own.slice(0, upTo + 1), state));
  saveState(target, state);
  recordSession(session, { project: target.top });
  return { session, file: file2, cwd, records: lines };
}
function replayedIds(records) {
  const map = /* @__PURE__ */ new Map();
  for (const r of records) {
    map.set(uuidFor(r.id), r.id);
    const of = readWith(r);
    if (of && r.id.startsWith(`${of}:`)) map.set(`${uuidFor(of)}${r.id.slice(of.length)}`, r.id);
  }
  return map;
}

// src/setup.ts
function cliPath() {
  return resolve(process.argv[1] ?? fileURLToPath(import.meta.url));
}
function writePointer() {
  mkdirSync4(configDir(), { recursive: true });
  writeFileSync5(join6(configDir(), "cli"), cliPath());
}
function settingsPath() {
  return join6(process.env.CLAUDE_CONFIG_DIR || join6(homedir4(), ".claude"), "settings.json");
}
var SHIM = `#!/bin/sh
# braid: runs the braid CLI wherever the Claude Code plugin installed it.
cli="\${XDG_CONFIG_HOME:-$HOME/.config}/braid/cli"
[ -f "$cli" ] || { echo "braid: start a Claude Code session with the braid plugin once, then run /braid:init" >&2; exit 1; }
exec node "$(cat "$cli")" "$@"
`;
var codexHome = () => process.env.CODEX_HOME || join6(homedir4(), ".codex");
var isBraidHook = (h) => / hook (session-start|stop|session-end) --agent codex$/.test(h.command ?? "");
function codexHooks(bin, undo) {
  const home = codexHome();
  if (!existsSync8(home)) return [];
  const file2 = join6(home, "hooks.json");
  let config2 = {};
  if (existsSync8(file2)) {
    try {
      config2 = JSON.parse(readFileSync5(file2, "utf8"));
    } catch {
      return [`left ${file2} alone: it is not valid JSON, so braid cannot add its hooks to it`];
    }
  }
  const hooks = { ...config2.hooks ?? {} };
  for (const event of Object.keys(hooks)) {
    hooks[event] = (hooks[event] ?? []).map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isBraidHook(h)) })).filter((g) => (g.hooks ?? []).length > 0);
    if (hooks[event].length === 0) delete hooks[event];
  }
  if (!undo) {
    const command = (name) => `${shellWord(bin)} hook ${name} --agent codex`;
    const add = (event, name, timeout) => hooks[event] = [...hooks[event] ?? [], { hooks: [{ type: "command", command: command(name), timeout }] }];
    add("SessionStart", "session-start", 15);
    add("Stop", "stop", 30);
    add("SessionEnd", "session-end", 3);
  }
  const text2 = JSON.stringify({ ...config2, hooks }, null, 2) + "\n";
  if (existsSync8(file2) && readFileSync5(file2, "utf8") === text2) return [];
  writeFileSync5(file2, text2);
  return undo ? [`took braid's hooks out of ${file2}`] : [`added braid's hooks to ${file2}, so braid saves Codex sessions too: open /hooks in Codex once to trust them`];
}
function removeOldGitHooks(cwd) {
  const dir = gitMaybe(["rev-parse", "--path-format=absolute", "--git-path", "hooks"], { cwd })?.trim();
  if (!dir || !existsSync8(dir)) return [];
  if (gitMaybe(["config", "core.hooksPath"], { cwd })?.trim()) return [];
  const notes = [];
  for (const hook of ["prepare-commit-msg", "post-commit", "post-rewrite", "pre-push"]) {
    const path2 = join6(dir, hook);
    if (!existsSync8(path2) || !readFileSync5(path2, "utf8").includes("# braid hook")) continue;
    rmSync3(path2);
    if (existsSync8(`${path2}.local`)) renameSync3(`${path2}.local`, path2);
    notes.push(`took braid 0.1's ${hook} hook out of ${dir}`);
  }
  return notes;
}
var isBraidLine = (command) => !!command && /(^|[/\s"'])braid(\.mjs)?["']? statusline\s*$/.test(command.trim());
function setup(opts = {}) {
  const notes = [];
  const settingsFile = settingsPath();
  const saved = join6(configDir(), "statusline.json");
  const settings = existsSync8(settingsFile) ? JSON.parse(readFileSync5(settingsFile, "utf8")) : {};
  const current = settings.statusLine;
  if (opts.undo) {
    const prev = existsSync8(saved) ? JSON.parse(readFileSync5(saved, "utf8")) : {};
    if (prev.previous) settings.statusLine = { type: "command", command: prev.previous, ...prev.refreshInterval ? { refreshInterval: prev.refreshInterval } : {} };
    else delete settings.statusLine;
    writeFileSync5(settingsFile, JSON.stringify(settings, null, 2) + "\n");
    return [`restored the previous status line in ${settingsFile}`, ...codexHooks(join6(homedir4(), ".local", "bin", "braid"), true)];
  }
  writePointer();
  const bin = join6(homedir4(), ".local", "bin");
  mkdirSync4(bin, { recursive: true });
  writeFileSync5(join6(bin, "braid"), SHIM);
  chmodSync(join6(bin, "braid"), 493);
  notes.push(`installed ${join6(bin, "braid")}`);
  if (!(process.env.PATH ?? "").split(":").includes(bin)) notes.push(`add ${bin} to your PATH to run braid from a terminal`);
  const command = `${join6(bin, "braid")} statusline`;
  if (current?.command !== command) {
    mkdirSync4(configDir(), { recursive: true });
    if (!isBraidLine(current?.command)) writeFileSync5(saved, JSON.stringify({ previous: current?.command ?? "", refreshInterval: current?.refreshInterval }, null, 2) + "\n");
    settings.statusLine = { type: "command", command, refreshInterval: 30 };
    mkdirSync4(dirname2(settingsFile), { recursive: true });
    writeFileSync5(settingsFile, JSON.stringify(settings, null, 2) + "\n");
    notes.push(`status line set in ${settingsFile}${current?.command ? "; braid runs your previous one first" : ""}`);
  }
  notes.push(...codexHooks(join6(bin, "braid"), false));
  return notes;
}
function init(cwd) {
  const notes = [...setup(), ...removeOldGitHooks(cwd)];
  const repo = locate(cwd);
  const made = !existsSync8(repo.dir);
  ensureStore(repo);
  notes.push(`${made ? "made" : "found"} ${repo.dir}: this project's conversations, one file each, which git does not see`);
  return notes;
}

// src/verify.ts
import { existsSync as existsSync10, readdirSync as readdirSync4, readFileSync as readFileSync6 } from "node:fs";
import { join as join8 } from "node:path";

// src/harness.ts
import { existsSync as existsSync9, mkdirSync as mkdirSync5, readdirSync as readdirSync3, writeFileSync as writeFileSync6 } from "node:fs";
import { homedir as homedir5 } from "node:os";
import { dirname as dirname3, join as join7, resolve as resolve2 } from "node:path";
function asClaudeCodeShowed(records) {
  return records.map((r) => {
    const line = ownLine(r);
    const origin = line?.origin?.kind;
    if (r.type === "message" && r.role === "user" && origin && origin !== "human") return { ...r, display: false };
    const a = line?.attachment;
    if (r.type !== "custom" || a?.type !== "queued_command" || a.commandMode !== "prompt" || typeof a.prompt !== "string") return r;
    if (a.prompt.trimStart().startsWith("<task-notification>")) return r;
    const own = !a.origin || a.origin.kind === "human";
    return { type: "message", id: r.id, parentId: r.parentId, time: r.time, role: "user", content: a.prompt, ...own ? {} : { display: false } };
  });
}
var responseOf = (r) => r.type === "message" && r.role === "assistant" && typeof r.responseId === "string" ? r.responseId : void 0;
function batched(records) {
  const last = /* @__PURE__ */ new Map();
  records.forEach((r, i) => {
    const id = responseOf(r);
    if (id) last.set(id, i);
  });
  const out = [];
  let held = [];
  let until = -1;
  records.forEach((r, i) => {
    const id = responseOf(r);
    if (id) {
      out.push(r);
      until = Math.max(until, last.get(id));
    } else if (i < until) held.push(r);
    else out.push(r);
    if (i >= until && held.length) {
      out.push(...held);
      held = [];
    }
  });
  return [...out, ...held];
}
function resultsFirst(records) {
  const isResult = (r) => r.role === "tool";
  const isNote2 = (r) => r.type === "custom" || r.type === "message" && r.role === "user" && r.display === false;
  const out = [];
  let run2 = [];
  const flush = () => {
    out.push(...run2.filter(isResult), ...run2.filter((r) => !isResult(r)));
    run2 = [];
  };
  for (const r of records) {
    if (isResult(r) || run2.length && isNote2(r)) run2.push(r);
    else {
      flush();
      out.push(r);
    }
  }
  flush();
  return out;
}
var asText = (r) => r.role === "tool" && r.isError ? { ...r, isError: void 0 } : r;
var claudeHome = () => process.env.CLAUDE_CONFIG_DIR || join7(homedir5(), ".claude");
var claudeFile = (session, cwd) => join7(claudeHome(), "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${session}.jsonl`);
var codexHome2 = () => process.env.CODEX_HOME || join7(homedir5(), ".codex");
var envFor = (name, fallback) => (dir) => dir && resolve2(dir) !== resolve2(homedir5(), fallback) ? `${name}=${shellWord(dir)} ` : "";
var claudeEnv = () => envFor("CLAUDE_CONFIG_DIR", ".claude")(process.env.CLAUDE_CONFIG_DIR);
var codexEnv = () => envFor("CODEX_HOME", ".codex")(process.env.CODEX_HOME);
var pad = (n) => String(n).padStart(2, "0");
var CLAUDE_CODE = {
  agent: "claude-code",
  title: "Claude Code",
  provider: "anthropic",
  write(fork, _all, cwd, pairs, session) {
    const text2 = forkText(fork, session, cwd, pairs);
    const file2 = claudeFile(session, cwd);
    mkdirSync5(dirname3(file2), { recursive: true });
    writeFileSync6(file2, text2);
    return { session, file: file2, lines: text2.split("\n").filter(Boolean).length };
  },
  existing: (session, cwd) => existsSync9(claudeFile(session, cwd)) ? claudeFile(session, cwd) : void 0,
  resume: (dir, session) => `cd ${shellWord(dir)} && ${claudeEnv()}claude --resume ${session}`
};
function outputsAnswerCalls(text2) {
  const custom = /* @__PURE__ */ new Set();
  return text2.split("\n").map((l) => {
    if (!l) return l;
    const line = JSON.parse(l);
    const p = line.payload;
    if (line.type !== "response_item" || !p?.call_id) return l;
    if (p.type === "custom_tool_call") custom.add(p.call_id);
    if (p.type !== "function_call_output" || !custom.has(p.call_id)) return l;
    return JSON.stringify({ ...line, payload: { ...p, type: "custom_tool_call_output" } });
  }).join("\n");
}
function codexLineOf(r) {
  const n = r.native;
  const line = n?.source === "codex" && n.records?.length === 1 ? n.records[0] : void 0;
  return line && typeof line === "object" ? line : void 0;
}
function converted(records, cwd, pairs, session, now) {
  const prepared = linear(resultsFirst(batched(forModel(rewrite(asCodexShowed(asClaudeCodeShowed(records), "codex"), pairs), CODEX.provider).map(asText))));
  const header2 = { type: "transcript", atxf: "0.1", id: session, time: now.toISOString(), source: { agent: "braid", sessionId: session }, workspace: { cwd } };
  return codex.fromAtxf({ header: header2, records: prepared }, { carry: false }).split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
function codexText(fork, all, cwd, pairs, session, now) {
  const kept = fork.path[0] ? keptUuids(ownLine(fork.path[0])).flatMap((u) => all.has(u) ? [all.get(u)] : []) : [];
  const path2 = kept.length ? [...fork.path.slice(0, 2), ...kept, ...fork.path.slice(2)] : fork.path;
  const onPath = new Set(path2.map((r) => r.id));
  const sequence = [...path2, ...fork.records.filter((r) => codexLineOf(r) && !onPath.has(r.id))];
  if (!sequence.some((r) => codexLineOf(r))) return outputsAnswerCalls(converted(path2, cwd, pairs, session, now).map((l) => JSON.stringify(l)).join("\n") + "\n");
  const out = [];
  let meta;
  let made;
  let run2 = [];
  const flush = () => {
    if (!run2.length) return;
    const [first, ...lines] = converted(run2, cwd, pairs, session, now);
    made ??= first;
    out.push(...lines);
    run2 = [];
  };
  for (const r of sequence) {
    const line = codexLineOf(r);
    if (!line) run2.push(r);
    else if (line.type === "session_meta") meta = line;
    else {
      flush();
      out.push(rewrite(line, pairs));
    }
  }
  flush();
  const stamp = now.toISOString();
  const payload = meta ? { ...rewrite(meta.payload, pairs), id: session, ...meta.payload.session_id ? { session_id: session } : {}, timestamp: stamp, cwd } : void 0;
  const head = meta ? { ...meta, timestamp: stamp, payload } : made ?? { timestamp: stamp, type: "session_meta", payload: { id: session, timestamp: stamp, cwd, originator: "atxf", cli_version: "0.0.0", source: "cli" } };
  return outputsAnswerCalls([head, ...out].map((l) => JSON.stringify(l)).join("\n") + "\n");
}
var CODEX = {
  agent: "codex",
  title: "Codex",
  provider: "openai",
  write(fork, all, cwd, pairs, session) {
    const now = /* @__PURE__ */ new Date();
    const text2 = codexText(fork, all, cwd, pairs, session, now);
    const dir = join7(codexHome2(), "sessions", String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()));
    mkdirSync5(dir, { recursive: true });
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    const file2 = join7(dir, `rollout-${stamp}-${session}.jsonl`);
    writeFileSync6(file2, text2);
    return { session, file: file2, lines: text2.split("\n").filter(Boolean).length };
  },
  existing(session) {
    const root = join7(codexHome2(), "sessions");
    if (!existsSync9(root)) return void 0;
    const name = readdirSync3(root, { recursive: true }).map(String).find((f) => f.endsWith(`-${session}.jsonl`));
    return name ? join7(root, name) : void 0;
  },
  resume: (dir, session) => `cd ${shellWord(dir)} && ${codexEnv()}codex resume ${session}`
};
var HARNESSES = { "claude-code": CLAUDE_CODE, claude: CLAUDE_CODE, codex: CODEX };
function harness(name) {
  if (name === void 0) return CLAUDE_CODE;
  const h = HARNESSES[name.toLowerCase()];
  if (!h) throw new Error(`braid writes sessions for claude-code and codex, not ${name}`);
  return h;
}

// src/verify.ts
function readAll(path2, id, until, format = "claude-code") {
  const saved = [];
  const since = [];
  let cursor = START;
  for (const [out, limit] of [[saved, until], [since, void 0]]) {
    for (let w = readWindow(path2, cursor, id, { until: limit }, format); w; w = w.more ? readWindow(path2, cursor, id, { until: limit }, format) : void 0) {
      out.push(...w.records.slice(w.fresh));
      cursor = w.cursor;
    }
  }
  return { saved, since };
}
function content(r) {
  const native = r.native?.records?.[0];
  const guessed = !!native && native.timestamp === void 0;
  const { parentId: _p, ext, ...all } = r;
  const rest = { ...all };
  if (guessed) delete rest.time;
  const { braid: _b, ...otherExt } = ext ?? {};
  return stable(Object.keys(otherExt).length ? { ...rest, ext: otherExt } : rest);
}
var which = (r) => describe(r, 80) || `${r.type}${r.name ? ` ${String(r.name)}` : ""} ${r.id}`;
function stable(value) {
  return JSON.stringify(value, (_k, v) => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
}
function compare(what, transcript, stored, elsewhere, problems) {
  const copies = (rs) => {
    const by = /* @__PURE__ */ new Map();
    rs.forEach((r, i) => by.set(r.id, [...by.get(r.id) ?? [], i]));
    return by;
  };
  const saved = copies(stored);
  const lines = copies(transcript);
  const nth = (rs) => {
    const seen = /* @__PURE__ */ new Map();
    return rs.map((r) => {
      const n = seen.get(r.id) ?? 0;
      seen.set(r.id, n + 1);
      return n;
    });
  };
  const twice = [...saved].reduce((sum, [id, at]) => sum + Math.max(0, at.length - Math.max(1, lines.get(id)?.length ?? 0)), 0);
  if (twice) problems.push(`${what}: ${twice} records are saved twice`);
  const tn = nth(transcript);
  const savedCopy = (r, i) => {
    const at = saved.get(r.id)?.[tn[i]];
    return at === void 0 ? void 0 : stored[at];
  };
  const missing = transcript.filter((r, i) => !savedCopy(r, i) && !elsewhere(r.id));
  const changed = transcript.filter((r, i) => savedCopy(r, i) && content(savedCopy(r, i)) !== content(r));
  if (missing.length) problems.push(`${what}: ${missing.length} records of the transcript are not saved, from: ${which(missing[0])}`);
  if (changed.length) problems.push(`${what}: ${changed.length} saved records differ from the transcript, from: ${which(changed[0])}`);
  const sn = nth(stored);
  const order = stored.map((r, k) => lines.get(r.id)?.[sn[k]]).filter((i) => i !== void 0);
  const swaps = order.filter((i, k) => k > 0 && i < order[k - 1]).length;
  if (swaps) problems.push(`${what}: ${swaps} saved records are out of the transcript's order`);
  return transcript.length - missing.length;
}
function readLines(path2, until) {
  const buf = readFileSync6(path2);
  return buf.toString("utf8", 0, Math.min(buf.length, until ?? buf.length)).split("\n").flatMap((l) => {
    try {
      const v = JSON.parse(l);
      return v && typeof v === "object" ? [v] : [];
    } catch {
      return [];
    }
  });
}
var blocksOf = (l) => {
  const c = l.message?.content;
  return Array.isArray(c) ? c : [];
};
function resumeLines(lines, head, stored, session) {
  const byUuid = /* @__PURE__ */ new Map();
  for (const l of lines) if (typeof l.uuid === "string" && !byUuid.has(l.uuid)) byUuid.set(l.uuid, l);
  const leaf = byUuid.get(head) ?? lines.find((l) => typeof l.uuid === "string" && head.startsWith(`${l.uuid}:`));
  const chain = [];
  const seen = /* @__PURE__ */ new Set();
  for (let l = leaf; l && !seen.has(l.uuid); l = typeof l.parentUuid === "string" ? byUuid.get(l.parentUuid) : void 0) {
    seen.add(l.uuid);
    chain.push(l);
  }
  chain.reverse();
  const results = (l) => l.type === "user" ? blocksOf(l).flatMap((b) => b.type === "tool_result" ? [String(b.tool_use_id)] : []) : [];
  const calls = (l) => l.type === "assistant" ? blocksOf(l).flatMap((b) => b.type === "tool_use" ? [String(b.id)] : []) : [];
  const response = (l) => l?.type === "assistant" ? l.message?.id : void 0;
  const holder = /* @__PURE__ */ new Map();
  const responses = /* @__PURE__ */ new Map();
  for (const l of lines) {
    if (l.isSidechain) continue;
    for (const id of results(l)) if (!holder.has(id)) holder.set(id, l);
    if (typeof response(l) === "string" && !seen.has(l.uuid)) responses.set(response(l), [...responses.get(response(l)) ?? [], l]);
  }
  const path2 = [];
  const taken = new Set(chain);
  let waiting = [];
  const children = /* @__PURE__ */ new Map();
  for (const l of lines) if (typeof l.parentUuid === "string") children.set(l.parentUuid, [...children.get(l.parentUuid) ?? [], l]);
  const bring = (l) => {
    taken.add(l);
    waiting.push(l);
    for (const c of children.get(l.uuid) ?? []) if (c.type === "attachment" && !taken.has(c)) bring(c);
  };
  const linked = (l) => !taken.has(l) && typeof l.parentUuid === "string" && taken.has(byUuid.get(l.parentUuid));
  const answer = (l) => {
    for (const id of calls(l)) {
      const r = holder.get(id);
      if (r && linked(r)) bring(r);
    }
  };
  const order = new Map(lines.map((l, i) => [l, i]));
  chain.forEach((l, i) => {
    if (l.type !== "assistant") {
      path2.push(...[...waiting, l].sort((a, b) => order.get(a) - order.get(b)));
      waiting = [];
      return;
    }
    path2.push(l);
    answer(l);
    if (typeof response(l) !== "string" || response(chain[i + 1]) === response(l)) return;
    for (const rest of responses.get(response(l)) ?? []) {
      if (!linked(rest)) continue;
      taken.add(rest);
      path2.push(rest);
      answer(rest);
    }
  });
  const kept = new Set(keptUuids(chain[0]));
  const ids = new Set(stored.map((r) => r.id));
  const tag = `@${session.slice(0, 8)}`;
  const mine = (l, i) => typeof l.uuid === "string" ? ids.has(l.uuid) : ids.has(`claude-line-${i + 1}${tag}`);
  const context = new Set(path2);
  const from = chain[0]?.subtype === "compact_boundary" ? lines.indexOf(chain[0]) : 0;
  const last = lines.findLastIndex((l, i) => mine(l, i));
  return lines.filter((l, i) => {
    if (i > last) return false;
    if (typeof l.uuid === "string" && kept.has(l.uuid)) return true;
    if (!mine(l, i)) return context.has(l);
    return i >= from && !SOURCE_ONLY.has(String(l.type));
  });
}
function canonical(lines) {
  const at = new Map(lines.flatMap((l, i) => typeof l.uuid === "string" ? [[l.uuid, i]] : []));
  const parent = (v) => typeof v === "string" && at.has(v) ? `#${at.get(v)}` : "#elsewhere";
  const deep = (v) => typeof v === "string" ? at.has(v) ? `#${at.get(v)}` : v : Array.isArray(v) ? v.map(deep) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v;
  return lines.map((l) => {
    const out = {};
    for (const [k, v] of Object.entries(l)) {
      if (k === "sessionId" || k === "cwd" || k === "isSidechain") continue;
      out[k] = k === "parentUuid" ? parent(v) : k === "message" ? v : deep(v);
    }
    return stable(out);
  });
}
var isNative = (r) => r.native?.source === "claude-code";
var itemText = (content2) => Array.isArray(content2) ? content2.map((c) => typeof c?.text === "string" ? String(c.text) : "").join("") : typeof content2 === "string" ? content2 : "";
var argsOf = (a) => {
  try {
    return typeof a === "string" ? JSON.parse(a) : a;
  } catch {
    return a;
  }
};
function codexHistory(lines) {
  let items = [];
  for (const l of lines) {
    const p = l.payload;
    if (l.type === "response_item" && p) items.push(p);
    if (l.type === "compacted" && p) {
      items = Array.isArray(p.replacement_history) ? p.replacement_history.map((x) => x.item ?? x) : [{ type: "message", role: "user", content: [{ type: "input_text", text: String(p.message ?? "") }] }];
    }
  }
  return items.flatMap((p) => {
    switch (p.type) {
      case "message": {
        const text2 = itemText(p.content);
        if (p.role === "developer" || p.role === "system" || p.role === "user" && CODEX_CONTEXT.test(text2)) return [];
        return [stable({ message: p.role, text: text2.trim() })];
      }
      case "reasoning":
        return [stable({ reasoning: p.encrypted_content ?? null })];
      case "function_call":
        return [stable({ call: p.name, id: p.call_id, args: argsOf(p.arguments) })];
      case "custom_tool_call":
        return [stable({ custom: p.name, id: p.call_id, input: p.input })];
      case "function_call_output":
      case "custom_tool_call_output": {
        const o = p.output;
        return [stable({ output: p.type, id: p.call_id, text: typeof o === "string" ? o : itemText(o?.content ?? o) })];
      }
      default:
        return [stable({ item: p.type })];
    }
  });
}
function said(r) {
  const blocks = Array.isArray(r.content) ? r.content : [{ type: "text", text: r.content }];
  return stable({
    role: r.role,
    blocks: blocks.map(
      (b) => b?.type === "text" ? { text: String(b.text ?? "").trim() } : b?.type === "tool_call" ? { call: b.name, args: b.arguments } : { type: b?.type ?? typeof b }
    )
  });
}
function verify(repo, session) {
  const problems = [];
  const checked = [];
  const notes = [];
  const state = loadState(repo, session);
  if (!state || state.chunks === 0) return { session, problems: ["not saved yet"], checked, notes };
  let stored;
  let agents;
  try {
    stored = readRecords(repo, session);
    agents = readAgents(repo, session);
  } catch (err) {
    return { session, problems: [`file: ${sessionFile(repo, session)} does not read back: ${err instanceof Error ? err.message : String(err)}`], checked, notes };
  }
  const all = new Map(stored.map((r) => [r.id, r]));
  const elsewhere = () => false;
  const format = state.harness === "codex" ? "codex" : "claude-code";
  if (state.transcript && existsSync10(state.transcript)) {
    const { saved, since } = readAll(state.transcript, session, state.cursor?.offset, format);
    const n = compare("saved", saved, stored, elsewhere, problems);
    checked.push(`saved: ${n} records of the transcript`);
    let pending = since.length;
    const dir = join8(state.transcript.replace(/\.jsonl$/, ""), "subagents");
    for (const file2 of existsSync10(dir) ? readdirSync4(dir).sort() : []) {
      const id = /^agent-([A-Za-z0-9_-]+)\.jsonl$/.exec(file2)?.[1];
      if (!id) continue;
      const read = readAll(join8(dir, file2), id, state.agents?.[id]?.cursor.offset ?? 0);
      pending += read.since.length;
      const mine = agents.get(id);
      if (!read.saved.length) continue;
      if (!mine) problems.push(`saved: subagent ${id.slice(0, 8)} is not saved`);
      else compare(`subagent ${id.slice(0, 8)}`, read.saved, mine, () => false, problems);
    }
    if (agents.size) checked.push(`saved: ${agents.size} subagents`);
    if (pending) notes.push(`${pending} records written since the last save, which the next save takes in`);
  } else checked.push("saved: the transcript is gone, so only the store is checked");
  const head = lastTurn(stored) ?? stored.at(-1)?.id;
  if (head && format === "codex") {
    const fork = forkRecords(all, stored, head);
    const lines = codexText(fork, all, "/", [], session, /* @__PURE__ */ new Date()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const forked = codexHistory(lines);
    if (state.transcript && existsSync10(state.transcript)) {
      const rollout = readLines(state.transcript, state.cursor?.offset);
      const own = rollout.slice(1).map(stable);
      const tail = lines.slice(-own.length).map(stable);
      const at = own.findIndex((l, i2) => l !== tail[i2]);
      if (lines.length <= own.length || at >= 0) problems.push(`loads: a fork holds the rollout's lines otherwise, from line ${(at < 0 ? 0 : at) + 2}: ${(own[at] ?? "").slice(0, 120)}`);
      const resumed = codexHistory(rollout);
      const i = resumed.findIndex((l, n) => l !== forked[n]);
      if (i >= 0 || resumed.length !== forked.length) {
        const j = i >= 0 ? i : Math.min(resumed.length, forked.length);
        problems.push(`loads: Codex rebuilds ${resumed.length} items to resume the rollout and ${forked.length} from a fork; they differ from item ${j + 1}: ${(resumed[j] ?? forked[j] ?? "").slice(0, 120)}`);
      } else checked.push(`loads: ${own.length} lines as Codex wrote them, and ${resumed.length} items, the same in a fork as in the rollout`);
    } else checked.push(`loads: ${forked.length} items in a fork`);
  } else if (head) {
    const fork = forkRecords(all, stored, head);
    const text2 = forkText(fork, session, "/");
    const onPath = new Set(fork.path.map((r) => r.id));
    const written = fork.records.filter((r) => r.type === "message" && (isNative(r) || onPath.has(r.id)));
    const original = replayedIds(fork.records);
    const back = new Map(nativeIds(claudeCode.toAtxf(text2, { integrity: false }).records).map((r) => [original.get(r.id) ?? r.id, r]));
    const lost = written.filter((r) => !back.has(r.id) || said(back.get(r.id)) !== said(r));
    if (lost.length) problems.push(`loads: ${lost.length} of the ${written.length} messages a fork writes read back otherwise, from: ${describe(lost[0], 80)}`);
    const since = fork.path[0]?.type === "custom" && String(fork.path[0].name ?? "").includes("compact") ? " since the last compaction" : "";
    if (state.transcript && existsSync10(state.transcript)) {
      const resumed = canonical(resumeLines(readLines(state.transcript, state.cursor?.offset), head, stored, session));
      const forked = canonical(text2.split("\n").filter(Boolean).map((l) => JSON.parse(l)));
      const at = resumed.findIndex((l, i) => l !== forked[i]);
      if (at >= 0 || resumed.length !== forked.length) {
        const i = at >= 0 ? at : Math.min(resumed.length, forked.length);
        problems.push(`loads: Claude Code reads ${resumed.length} lines to resume the transcript and ${forked.length} from a fork; they differ from line ${i + 1}: ${(resumed[i] ?? forked[i] ?? "").slice(0, 120)}`);
      } else checked.push(`loads: ${resumed.length} lines${since}, the same in a fork as in the transcript`);
    } else checked.push(`loads: ${written.length} messages${since}, the same after a fork`);
  }
  const ids = /* @__PURE__ */ new Set([...all.keys(), ...[...agents.values()].flat().map((r) => r.id)]);
  const orphans = [...stored, ...[...agents.values()].flat()].filter((r) => typeof r.parentId === "string" && !ids.has(r.parentId));
  if (orphans.length) problems.push(`file: ${orphans.length} records have a parent that is not saved, from: ${describe(orphans[0], 80)}`);
  if (readChecked(repo, session).truncated) problems.push("file: the last save was cut short; what it wrote whole reads back, the rest does not");
  checked.push(`file: ${stored.length} records, each with its parent`);
  return { session, problems, checked, notes };
}

// src/hooks.ts
var where = (input, session) => repoFor(session, input.cwd ?? process.cwd());
function sessionStart(input) {
  const session = input.session_id;
  if (!session) return "";
  const transcript = input.transcript_path ?? void 0;
  writePointer();
  recordSession(session, { transcript });
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (envFile) {
    const bin = join9(dirname4(dirname4(cliPath())), "bin");
    appendFileSync2(envFile, `export BRAID_SESSION=${session}
export PATH="${bin}:$PATH"
`);
  }
  const repo = where(input, session);
  register(repo, session, transcript, input.agent, input.cwd);
  const message = input.source === "resume" ? recap(repo, session, input.agent ?? "claude-code") : "";
  return message ? JSON.stringify({ systemMessage: message }) : "";
}
function recap(repo, session, agent) {
  const state = loadState(repo, session);
  if (!state?.title && !state?.recap) return "";
  const name = state.turn ? turnName(session, state.turn) : session.slice(0, 8);
  const fork = state.forkedFrom ? `, a fork of ${turnName(state.forkedFrom.session, state.forkedFrom.turn)}` : "";
  const head = `braid \xB7 ${name}${state.title ? ` \xB7 ${state.title.text}` : ""}${fork}`;
  return state.recap && agent === "codex" ? `${head}
Last recap, ${ago(state.recap.at)}: ${state.recap.text}` : head;
}
function stop(input) {
  const session = input.session_id;
  if (!session) return "";
  const repo = where(input, session);
  save(repo, session, input.transcript_path ?? void 0, { agent: input.agent });
  return "";
}
function sessionEnd(input) {
  const session = input.session_id;
  if (!session) return "";
  const repo = where(input, session);
  const { state } = save(repo, session, input.transcript_path ?? void 0, { agent: input.agent });
  if (state.chunks === 0) return "";
  const v = verify(repo, session);
  const s = loadState(repo, session);
  if (s) saveState(repo, { ...s, verified: { ok: v.problems.length === 0, at: (/* @__PURE__ */ new Date()).toISOString(), ...v.problems.length ? { problems: v.problems } : {} } });
  if (v.problems.length) throw new Error(`braid verify ${session} in ${repo.dir}: ${v.problems.join("; ")}`);
  return "";
}

// src/load.ts
import { existsSync as existsSync11, readdirSync as readdirSync5 } from "node:fs";
function allSessions(repo) {
  if (!existsSync11(repo.sessions)) return [];
  return readdirSync5(repo.sessions).filter((f) => f.endsWith(".json")).flatMap((f) => {
    const state = loadState(repo, f.slice(0, -".json".length));
    return state ? [{ session: state.session }] : [];
  });
}
function resolve3(repo, target) {
  const sessions = allSessions(repo);
  const byId = sessions.filter((s) => s.session.startsWith(target));
  if (byId.length > 0 || /^[0-9a-f-]{8,}$/.test(target)) return byId;
  return sessions.filter((s) => {
    const title = loadState(repo, s.session)?.title;
    return title?.by === "user" && title.text === target;
  });
}

// src/migrate.ts
import { existsSync as existsSync12, readdirSync as readdirSync6, readFileSync as readFileSync7 } from "node:fs";
import { homedir as homedir6 } from "node:os";
import { join as join10 } from "node:path";
var oldHome = () => process.env.BRAID_HOME || join10(homedir6(), ".braid");
function chunks(tree, opts) {
  const files = lsTree(tree, opts).filter((e) => e.type === "blob").sort((a, b) => a.name.localeCompare(b.name));
  return catBlobs(files.map((f) => f.sha), opts).flatMap(parseJsonl);
}
function readOld(ref, opts) {
  const commit = revParse(ref, opts);
  const root = commit ? lsTree(commit, opts) : [];
  const dir = (name) => root.find((e) => e.name === name && e.type === "tree")?.sha;
  const records = dir("records") ? chunks(dir("records"), opts) : [];
  const agents = /* @__PURE__ */ new Map();
  if (dir("agents")) for (const a of lsTree(dir("agents"), opts).filter((e) => e.type === "tree")) agents.set(a.name, chunks(a.sha, opts));
  return { records, agents };
}
var OBSOLETE = ["code", "published", "withheld", "terms", "edits", "private", "review", "commits", "importedSeq", "conv", "forkFrom", "copied", "first", "pendingMerge", "reparent", "notified"];
function migrate(home = oldHome()) {
  const store = join10(home, ".git", "braid", "store");
  const states = join10(home, ".git", "braid", "sessions");
  if (!existsSync12(join10(store, "HEAD"))) return [`nothing to move: ${home} holds no conversations of braid 0.1`];
  const opts = { gitDir: store };
  const old = (session) => {
    const file2 = join10(states, `${session}.json`);
    return existsSync12(file2) ? JSON.parse(readFileSync7(file2, "utf8")) : void 0;
  };
  const byConv = /* @__PURE__ */ new Map();
  for (const { ref } of forEachRef(["refs/sessions/"], opts)) {
    const [conv, session] = ref.split("/").slice(-2);
    byConv.set(conv, [...byConv.get(conv) ?? [], { session, ref }]);
  }
  const moved = /* @__PURE__ */ new Map();
  let kept = 0;
  for (const [conv, sessions] of byConv) {
    const code = [conv, ...sessions.map((s) => s.session)].map((id) => old(id)?.code).find((c) => typeof c === "string" && existsSync12(c));
    const project = projectOf(code ?? homedir6());
    const repo = repoAt(project);
    for (const { session, ref } of sessions) {
      if (existsSync12(sessionFile(repo, session)) || (loadState(repo, session)?.chunks ?? 0) > 0) {
        kept++;
        continue;
      }
      const { records, agents } = readOld(ref, opts);
      appendRecords(repo, session, records, agents);
      const state = { ...old(session) ?? { session, harness: "claude-code", chunks: 1 } };
      for (const key of OBSOLETE) delete state[key];
      state.chunks = Math.max(1, Number(state.chunks ?? 1));
      saveState(repo, state);
      recordSession(session, { project });
      moved.set(project, (moved.get(project) ?? 0) + 1);
    }
  }
  const notes = [...moved].map(([project, n]) => `moved ${n} session${n === 1 ? "" : "s"} into ${join10(project, ".braid")}`);
  const ran = new Set([...byConv.values()].flat().map((s) => old(s.session)?.code).filter((c) => typeof c === "string" && existsSync12(c)));
  for (const code of ran) notes.push(...removeOldGitHooks(code));
  if (kept) notes.push(kept === 1 ? "left 1 session already moved as it is" : `left ${kept} sessions already moved as they are`);
  if (!notes.length) notes.push("nothing to move");
  notes.push(`${home} stays as it was: delete it once you no longer need braid 0.1`);
  return notes;
}
function waitingToMove(home = oldHome()) {
  const states = join10(home, ".git", "braid", "sessions");
  if (!existsSync12(join10(home, ".git", "braid", "store", "HEAD")) || !existsSync12(states)) return false;
  return readdirSync6(states).some((f) => {
    if (!f.endsWith(".json")) return false;
    try {
      const s = JSON.parse(readFileSync7(join10(states, f), "utf8"));
      return (s.chunks ?? 0) > 0;
    } catch {
      return false;
    }
  });
}

// src/status.ts
function computeStatus(repo, session) {
  const state = loadState(repo, session);
  return { session, saved: (state?.chunks ?? 0) > 0, broken: state?.verified?.ok === false };
}
var plain = (_tone, text2) => text2;
var SGR = {
  quiet: ["2", "22"],
  broken: ["31", "39"],
  sep: ["2", "22"]
};
function colors(env = process.env) {
  if (env.NO_COLOR) return { paint: plain, sep: " \xB7 ", dim: (s) => s };
  const wrap = (k, t) => `\x1B[${SGR[k][0]}m${t}\x1B[${SGR[k][1]}m`;
  return { paint: wrap, sep: wrap("sep", " \xB7 "), dim: (t) => wrap("quiet", t) };
}
function render(s, paint = plain) {
  return s.broken ? paint("broken", "\u26A0 braid verify") : "";
}

// src/statusline.ts
import { spawnSync as spawnSync2 } from "node:child_process";
import { existsSync as existsSync13, readFileSync as readFileSync8 } from "node:fs";
import { join as join11 } from "node:path";
function previous(stdin) {
  const file2 = join11(configDir(), "statusline.json");
  if (!existsSync13(file2)) return "";
  const { previous: previous2 } = JSON.parse(readFileSync8(file2, "utf8"));
  if (!previous2 || isBraidLine(previous2)) return "";
  const r = spawnSync2("sh", ["-c", previous2], { input: stdin, encoding: "utf8", timeout: 3e3 });
  return (r.stdout ?? "").trimEnd();
}
function statusline(stdin) {
  let input = {};
  try {
    input = JSON.parse(stdin);
  } catch {
  }
  const prev = previous(stdin);
  const session = input.session_id;
  if (!session) return prev;
  const { paint, sep, dim } = colors();
  const dir = input.workspace?.current_dir ?? input.cwd ?? process.cwd();
  const repo = repoFor(session, dir);
  const state = loadState(repo, session);
  const name = `${session.slice(0, 8)}${state?.turn ? `.${state.turn}` : ""}`;
  const title = state?.title ? printable(state.title.text, 40) : void 0;
  const after = render(computeStatus(repo, session), paint);
  const ours = [dim("braid"), name, ...title ? [title] : [], ...after ? [after] : []].join(sep);
  if (!prev) return ours;
  return prev.includes("\n") ? `${prev}
${ours}` : `${prev} \xB7 ${ours}`;
}

// src/cli.ts
var HELP = `braid ${VERSION}: efficient session manager

Saves every Claude Code and Codex session, as it happens, in the project it runs in:
.braid/sessions/<id>.jsonl, one record per line, in a folder git does not see. Each command
works on the session it runs in ($BRAID_SESSION, else Claude Code's $CLAUDE_CODE_SESSION_ID or
Codex's $CODEX_THREAD_ID), or the one named with --session <id>.

  braid init                  this machine: the braid command, the status line, braid's hooks in
                              Codex when it is installed; and this project's .braid folder
    --undo                    put back the status line braid replaced, and take braid's hooks out of Codex
  braid status                this session: its newest turn, what it is about, and where it is kept
  braid sessions              the sessions this project keeps
  braid log [<session>] [--records]   a session's turns, each named <session>.<n>, with what it did;
                              --records: each record, under its turn
  braid fork [<session>|<session>.<n>|.<n>]   the command to continue a session, or one from the end
                              of its turn n, in a new window; with none, this one
    --to codex|claude-code    as a new session of that agent's (by default the agent it runs in)
    --new                     another session, even when the same fork was written before
  braid verify [<session>|--all]   check that a session was saved as it happened and loads back the same
  braid save                  save this session now (the Stop hook does this after each turn)
  braid migrate               move conversations from braid 0.1's ~/.braid into their projects

  <session> is a session id or its first characters, or the name you gave it with /rename.
  braid sessions lists them.
`;
function readStdin() {
  try {
    return readFileSync9(0, "utf8");
  } catch {
    return "";
  }
}
function logError(err) {
  try {
    mkdirSync6(configDir(), { recursive: true });
    appendFileSync3(join12(configDir(), "errors.log"), `${(/* @__PURE__ */ new Date()).toISOString()} ${err instanceof Error ? err.stack : String(err)}
`);
  } catch {
  }
}
function needSession(flag) {
  const session = flag ?? currentSession();
  if (!session) throw new Error("no session: run inside an agent session with braid installed, or pass --session <id>");
  return session;
}
function page(text2) {
  const rows = process.stdout.rows ?? 0;
  if (!process.stdout.isTTY || text2.split("\n").length < rows) {
    process.stdout.write(text2);
    return;
  }
  const r = spawnSync3(process.env.PAGER || "less", { input: text2, stdio: ["pipe", "inherit", "inherit"], shell: true, env: { LESS: "FRX", ...process.env } });
  if (r.error || r.status === 127) process.stdout.write(text2);
}
var named = (repo, session) => {
  const turn = loadState(repo, session)?.turn;
  return turn ? turnName(session, turn) : session.slice(0, 8);
};
function oneSession(repo, target, current) {
  if (!target) return { repo, session: needSession(current) };
  const found = resolve3(repo, target);
  if (found.length === 1) return { repo, session: found[0].session };
  if (found.length > 1) throw new Error(`${target} matches ${found.length} sessions; name one (braid sessions lists them)`);
  const elsewhere = knownSessions(target).filter((k) => k.project && existsSync14(join12(k.project, ".braid")));
  if (elsewhere.length === 1) return { repo: repoAt(elsewhere[0].project), session: elsewhere[0].session };
  throw new Error(elsewhere.length ? `${target} matches ${elsewhere.length} sessions; name one` : `no session matches ${target}; braid sessions lists them`);
}
function main(argv) {
  const [command, ...rest] = argv;
  const { values: opts, positionals: args } = parseArgs({
    args: rest,
    allowPositionals: true,
    strict: false,
    options: {
      session: { type: "string" },
      transcript: { type: "string" },
      to: { type: "string" },
      agent: { type: "string" },
      detached: { type: "boolean" },
      record: { type: "string" },
      skip: { type: "string" },
      instruction: { type: "string" },
      strategy: { type: "string" },
      all: { type: "boolean" },
      undo: { type: "boolean" },
      new: { type: "boolean" },
      records: { type: "boolean" },
      cwd: { type: "string" }
    }
  });
  const str = (k) => typeof opts[k] === "string" ? opts[k] : void 0;
  const out = (s) => s && process.stdout.write(s.endsWith("\n") ? s : `${s}
`);
  const current = str("session") ?? currentSession();
  const here = () => repoFor(current, process.cwd());
  switch (command) {
    case "hook": {
      try {
        const input = JSON.parse((opts.detached === true ? process.env.BRAID_HOOK_INPUT : readStdin()) || "{}");
        const agent = str("agent") === "codex" ? "codex" : void 0;
        if (args[0] === "session-end" && agent && opts.detached !== true) {
          const env = { ...process.env, BRAID_HOOK_INPUT: JSON.stringify(input) };
          spawn(process.execPath, [cliPath(), "hook", "session-end", "--agent", agent, "--detached"], { detached: true, stdio: "ignore", env }).unref();
          return 0;
        }
        const handlers = { "session-start": sessionStart, stop, "session-end": sessionEnd };
        out(handlers[args[0] ?? ""]?.({ ...input, ...agent ? { agent } : {} }) ?? "");
      } catch (err) {
        logError(err);
      }
      return 0;
    }
    case "git-hook":
      return 0;
    case "statusline":
      try {
        out(statusline(readStdin()));
      } catch (err) {
        logError(err);
      }
      return 0;
    case "init": {
      if (opts.undo === true) {
        for (const note of setup({ undo: true })) out(`braid: ${note}`);
        return 0;
      }
      for (const note of init(process.cwd())) out(`braid: ${note}`);
      if (waitingToMove()) {
        for (const note of migrate()) if (/^(moved|took) /.test(note)) out(`braid: ${note}`);
      }
      const transcript = str("transcript") ?? (current ? transcriptOf(current) : void 0);
      if (current && transcript && existsSync14(transcript)) {
        const repo = here();
        recordSession(current, { transcript });
        const r = save(repo, current, transcript);
        out(`braid: saved this conversation (${named(repo, current)}), ${r.added} records, in ${sessionFile(repo, current)}`);
      }
      return 0;
    }
    case "migrate":
      for (const note of migrate()) out(`braid: ${note}`);
      return 0;
    case "save": {
      const session = needSession(current);
      const repo = here();
      const known = loadState(repo, session)?.transcript;
      const r = save(repo, session, str("transcript") ?? (known ? void 0 : transcriptOf(session)));
      out(`braid: saved ${r.added} records${r.state.turn ? `, up to ${turnName(session, r.state.turn)}` : ""}`);
      return 0;
    }
    case "status": {
      const session = needSession(current);
      const repo = here();
      const state = loadState(repo, session);
      if (!state || state.chunks === 0) {
        out(`braid \xB7 ${session.slice(0, 8)}: not saved yet; braid saves it when this turn ends`);
        return 0;
      }
      const s = computeStatus(repo, session);
      out(`braid \xB7 ${named(repo, session)}${state.title ? ` \xB7 ${state.title.text}` : ""}`);
      if (state.recap) out(`  recap, ${ago(state.recap.at)}: ${state.recap.text}`);
      out(`  kept in ${sessionFile(repo, session)}`);
      if (state.ran && state.ran !== repo.top) out(`  ran in ${state.ran}`);
      if (s.broken) out(`  \u26A0 braid verify found problems when it last ran: ${(state.verified?.problems ?? []).join("; ")}`);
      if (state.forkedFrom) out(`  a fork of ${turnName(state.forkedFrom.session, state.forkedFrom.turn)}`);
      return 0;
    }
    case "sessions": {
      const repo = here();
      const rows = allSessions(repo).map((f) => ({ f, state: loadState(repo, f.session), file: sessionFile(repo, f.session) })).filter((x) => x.state && x.state.chunks > 0 && existsSync14(x.file)).map((x) => ({ ...x, at: statSync2(x.file).mtime.toISOString() })).sort((a, b) => b.at.localeCompare(a.at));
      if (rows.length === 0) out(`braid: no saved sessions in ${repo.dir}`);
      for (const { f, state, at } of rows) {
        const where2 = state.ran && state.ran !== repo.top ? `, in ${basename2(state.ran)}` : "";
        const fork = state.forkedFrom ? `, a fork of ${turnName(state.forkedFrom.session, state.forkedFrom.turn)}` : "";
        out(`${named(repo, f.session).padEnd(14)} ${(state.title?.text ?? "").slice(0, 50).padEnd(50)} ${state.harness.padEnd(11)} ${ago(at)}${where2}${fork}`);
      }
      return 0;
    }
    case "log": {
      const { repo, session } = oneSession(here(), args[0], current);
      const records = readRecords(repo, session);
      if (!records.length) throw new Error(`${session.slice(0, 8)} is not saved here`);
      const lines = [];
      for (const t of turnsOf(records)) {
        if (!t.start) continue;
        if (opts.records === true) {
          for (const r of t.records.filter(isTurn)) lines.push(`${turnName(session, t.n).padEnd(12)}  ${(r.role ?? r.type).padEnd(9)} ${describe(r, 160).split("\n")[0]}`);
        } else {
          const did = turnDetail(t.records);
          lines.push(`${turnName(session, t.n).padEnd(12)}  ${promptLine(t.start)}${did ? `  (${did})` : ""}`);
        }
      }
      page(lines.length ? `${lines.join("\n")}
` : "");
      return 0;
    }
    case "fork": {
      const repo = here();
      const to = harness(str("to") ?? currentAgent());
      const resume = (dir2, id) => `  cd ${shellWord(dir2)} && ${claudeEnv()}claude --resume ${id} --fork-session`;
      const fresh = opts.new === true;
      const wrote = (what, r) => r.existing ? `braid: ${what} is already a ${to.title} session, from an earlier fork. To continue it in a new window, run in a terminal:
  ${to.resume(r.cwd, r.session)}
braid fork --new writes another.` : `braid: wrote ${what} as a new ${to.title} session. To continue it in a new window, run in a terminal:
  ${to.resume(r.cwd, r.session)}`;
      if (current) {
        const transcript = loadState(repo, current)?.transcript ?? transcriptOf(current);
        if (transcript && existsSync14(transcript)) save(repo, current, transcript);
      }
      const m = args[0] ? TURN.exec(args[0]) : null;
      if (m && !(m[1] && resolve3(repo, args[0]).length)) {
        const { repo: kept2, session: session2 } = oneSession(repo, m[1] || void 0, current);
        const turn = findTurn(kept2, { session: session2 }, Number(m[2]));
        if (!turn) throw new Error(`${session2.slice(0, 8)} has no turn ${m[2]}; braid log lists its turns`);
        out(wrote(`the conversation up to ${turnName(session2, turn.n)}`, replay(kept2, { session: session2 }, to, { cwd: str("cwd"), fresh, until: turn.until })));
        return 0;
      }
      const { repo: kept, session } = oneSession(repo, args[0], current);
      const state = loadState(kept, session);
      if (!state || state.chunks === 0) throw new Error(`${session.slice(0, 8)} is not saved yet`);
      const dir = to.agent === "claude-code" && state.harness === "claude-code" && !str("cwd") && !fresh ? launchDir(state.transcript) : void 0;
      if (dir) {
        const what = session === current ? "this conversation" : named(kept, session);
        out([`braid: to branch ${what} into a new window, run in a terminal:`, resume(dir, session), ...session === current ? ["or /branch to branch it in this window. braid saves the branch as a session of its own."] : []].join("\n"));
        return 0;
      }
      out(wrote(session === current ? "this conversation" : named(kept, session), replay(kept, { session }, to, { cwd: str("cwd"), fresh })));
      return 0;
    }
    case "verify": {
      const repo = here();
      const ids = opts.all === true ? allSessions(repo).filter((f) => (loadState(repo, f.session)?.chunks ?? 0) > 0).map((f) => ({ repo, session: f.session })) : [oneSession(repo, args[0], current)];
      let bad = 0;
      for (const { repo: repo2, session: id } of ids) {
        const v = verify(repo2, id);
        bad += v.problems.length ? 1 : 0;
        const st = loadState(repo2, id);
        if (st) saveState(repo2, { ...st, verified: { ok: !v.problems.length, at: (/* @__PURE__ */ new Date()).toISOString(), ...v.problems.length ? { problems: v.problems } : {} } });
        out(`braid verify ${named(repo2, id)}: ${v.problems.length ? `${v.problems.length} problems` : "ok"}`);
        for (const p of v.problems) out(`  \u2717 ${p}`);
        for (const c of v.checked) out(`  \u2713 ${c}`);
        for (const n of v.notes) out(`  \xB7 ${n}`);
      }
      return bad ? 1 : 0;
    }
    case "version":
    case "--version":
      out(VERSION);
      return 0;
    case void 0:
    case "help":
    case "--help":
      out(HELP);
      return 0;
    default:
      process.stderr.write(`braid: unknown command ${command}

${HELP}`);
      return 2;
  }
}
process.stdout.on("error", (err) => {
  if (err.code !== "EPIPE") throw err;
  process.exit(process.exitCode ?? 0);
});
try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`braid: ${err instanceof Error ? err.message : String(err)}
`);
  process.exitCode = 1;
}
