#!/usr/bin/env node
// Checks that a fork braid writes resumes in Claude Code exactly as the
// session it came from does. For each transcript given:
//
// 1. braid saves it into a scratch store, checks it with braid verify, and
//    writes a fork of it from the store alone, as `braid fork` does when the
//    transcript is gone;
// 2. Claude Code resumes the original and the fork, in the session's own
//    directory, against a local server that records the request it would
//    send to the model and answers with an error, so no model is called and
//    nothing leaves the machine;
// 3. the two requests are compared byte for byte: messages, system prompt,
//    tools.
//
// With --to codex, braid writes the fork as a Codex session instead, Codex
// resumes it against a local server the same way, and the conversation in the
// two requests is compared item by item: what the user and the agent said, each
// tool call with its arguments, and each result. Each agent adds its own
// instructions, tools and notes, and reasoning stays with the provider that
// wrote it, so those are left out, and so is how each presents the rest: a
// result neither recorded, a long result Codex shortens, a note sent in the
// system or developer role, and how Claude Code sends a call (a cd before a
// command that ran elsewhere, \uXXXX text, without the fields it added to the
// call when it saved it).
//
// Usage: node scripts/resume-check.mjs [--to codex] <transcript.jsonl>...
// Needs `claude` on PATH (and `codex`, or CODEX=<path>, with --to codex), and dist/braid.mjs built (npm run build).
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BRAID = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "braid.mjs");
const argv = process.argv.slice(2);
const to = argv[0] === "--to" ? argv[1] : "claude-code";
const files = argv[0] === "--to" ? argv.slice(2) : argv;
if (!files.length || !["claude-code", "codex"].includes(to)) {
  console.error("usage: node scripts/resume-check.mjs [--to codex] <transcript.jsonl>...");
  process.exit(2);
}

const project = (dir) => dir.replace(/[^A-Za-z0-9]/g, "-");
const PROMPT = "Reply with OK.";

/** The directory the session was in last, where Claude Code resumes it. */
function lastCwd(file) {
  let cwd;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    try {
      const v = JSON.parse(line);
      if (typeof v.cwd === "string") cwd = v.cwd;
    } catch {}
  }
  return cwd;
}

/** Resumes a session with Claude Code against a local server, and returns the first request it makes to the model. */
async function resumeRequest(config, cwd, session) {
  const requests = [];
  const server = createServer((req, res) => {
    // Chunks are joined as bytes: a character split across two of them would not survive decoding each alone.
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (req.url?.startsWith("/v1/messages") && body) requests.push(JSON.parse(body));
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "recorded by braid resume-check" } }));
    });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: "sk-ant-resume-check", ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}` };
  for (const k of ["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDECODE"]) delete env[k];
  Object.assign(env, { DISABLE_TELEMETRY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
  const args = ["-p", "--resume", session, "--model", "claude-sonnet-5-5", "--max-turns", "1", "--no-session-persistence", PROMPT];
  await new Promise((ok) => spawn("claude", args, { cwd, env, stdio: ["ignore", "ignore", "ignore"] }).on("exit", ok));
  server.close();
  return requests.find((r) => Array.isArray(r.messages) && r.messages.length);
}

/** Resumes a session with Codex against a local server, and returns the first request it makes to the model. */
async function codexRequest(home, cwd, session) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (req.url?.endsWith("/responses") && body) requests.push(JSON.parse(body));
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "recorded by braid resume-check", code: "resume_check" } }));
    });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const provider = `model_provider = "check"\n\n[model_providers.check]\nname = "check"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nenv_key = "RESUME_CHECK_KEY"\nrequest_max_retries = 0\nstream_max_retries = 0\n`;
  writeFileSync(join(home, "config.toml"), provider);
  const env = { ...process.env, CODEX_HOME: home, RESUME_CHECK_KEY: "resume-check" };
  for (const k of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY"]) delete env[k];
  const args = ["exec", "--skip-git-repo-check", "-C", cwd, "resume", session, PROMPT];
  await new Promise((ok) => spawn(process.env.CODEX || "codex", args, { env, stdio: ["ignore", "ignore", "ignore"] }).on("exit", ok));
  server.close();
  return requests.find((r) => Array.isArray(r.input) && r.input.length);
}

const text = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (typeof b?.text === "string" ? b.text : b?.type === "image" || b?.type === "input_image" ? "[image]" : "")).join("\n") : "").trim();
// Tool arguments with their keys in order, each agent writing them in its own.
// Claude Code sends some characters in tool arguments as \\uXXXX text.
const chars = (s) => s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
const sorted = (v) =>
  Array.isArray(v) ? v.map(sorted)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])]))
  : typeof v === "string" ? chars(v)
  : v;
const args = (a) => JSON.stringify(sorted(typeof a === "string" ? JSON.parse(a || "{}") : (a ?? {})));
// Notes an agent adds to the conversation for its own model: Claude Code's reminders, the record of its own slash
// commands and of tools it loaded, Codex's environment.
const note = (s) => /^<(system-reminder|environment_context|command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)>/.test(s) || s === "Tool loaded.";
// Claude Code wraps a message the user typed while the agent worked, and one from another session.
const typed = (s) => /^The user sent a new message while you were working:\n([\s\S]*?)\n\nThis is how Claude Code surfaces/.exec(s)?.[1] ?? s;
// A message from another session, or a notice that a background task finished, as the note that carries it.
const peer = (s) => /<(agent-message|task-notification)[\s\S]*<\/\1>/.exec(s)?.[0];
// Each agent fills in a result that was never recorded, Claude Code saying the call was interrupted and Codex
// "aborted", each where it chooses: neither is part of the conversation braid wrote.
const UNRECORDED = "(no result recorded)";

/**
 * The conversation in a Claude request: each thing said, called and returned, in order. What the user did not
 * write, a note, counts as said to the user, as Claude Code sends it.
 */
function fromClaude(req) {
  return req.messages.flatMap((m) =>
    (typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content).flatMap((b) => {
      if (b.type === "text") {
        const t = b.text.trim();
        // In the system role, Claude Code's notes (hook output, token counts, the environment), and sometimes a
        // message the user typed while the agent worked.
        if (m.role === "system") return typed(t) !== t ? [`user: ${typed(t)}`] : [];
        if (peer(t)) return [`user: ${peer(t)}`];
        if (note(t) || !t || (m.role === "assistant" && t === "No response requested.")) return [];
        return [`${m.role}: ${typed(t)}`];
      }
      if (b.type === "image") return [`${m.role}: [image]`];
      if (b.type === "tool_use") return [`call ${b.id} ${b.name} ${args(b.input)}`];
      if (b.type === "tool_result") {
        // Claude Code fills in a result that was never recorded, and one that named tools it no longer has.
        const t = text(b.content);
        return [`result ${b.tool_use_id}: ${t.startsWith("[Tool call interrupted:") ? UNRECORDED : t === "[Tool references removed - tools no longer available]" ? "" : t}`];
      }
      return [];
    }),
  );
}

/**
 * The conversation in a Codex request, the same way, of the messages braid wrote in `rollout` and the prompt
 * after it: Codex adds its own instructions and environment. A note braid wrote for Codex's model is a developer
 * message, and counts as said to the user.
 */
function fromCodex(req, rollout, prompt) {
  const ours = new Set(
    rollout.flatMap((l) => (l.type === "response_item" && l.payload?.type === "message" ? [text(l.payload.content)] : l.type === "compacted" ? [String(l.payload?.message ?? "").trim()] : [])),
  );
  return req.input.flatMap((i) => {
    if (i.type === "message") {
      if (i.role !== "assistant" && !ours.has(text(i.content)) && text(i.content) !== prompt) return [];
      const role = i.role === "developer" ? "user" : i.role;
      return i.content.flatMap((c) => {
        const t = c.type === "input_image" ? "[image]" : (c.text ?? "").trim();
        if (peer(t)) return [`user: ${peer(t)}`];
        return note(t) || !t ? [] : [`${role}: ${t}`];
      });
    }
    if (i.type === "function_call") return [`call ${i.call_id} ${i.name} ${args(i.arguments)}`];
    if (i.type === "function_call_output") {
      const t = text(typeof i.output === "string" ? i.output : i.output?.content);
      return [`result ${i.call_id}: ${t === "aborted" ? UNRECORDED : t}`];
    }
    return [];
  });
}

// Codex shortens a long result in the request, keeping its start and end.
const shortened = (full, short) => {
  const m = /^([\s\S]*?)…\d+ tokens truncated…([\s\S]*)$/.exec(short);
  return !!m && full.startsWith(m[1]) && full.endsWith(m[2]);
};
// Claude Code starts a shell command that ran in another directory with a cd there, when it sends it.
const unmoved = (sent) => sent.replace(/^(call \S+ Bash \{"command":")cd \S+ && /, "$1");
// Claude Code leaves out of a call it sends the fields it added when it saved it, such as an Edit's replace_all or
// the routing of a SendMessage: each argument it sends is the call's own.
const added = (sent, called) => {
  const [x, y] = [sent, called].map((l) => /^(call \S+ \S+ )(\{[\s\S]*\})$/.exec(l));
  if (!x || !y || x[1] !== y[1]) return false;
  const [a, b] = [JSON.parse(x[2]), JSON.parse(y[2])];
  return Object.keys(a).every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
};
const same = (x, y) => x === y || shortened(x, y) || unmoved(x) === y || added(x, y) || added(unmoved(x), y);

function compareConversation(a, b, rollout) {
  const recorded = (l) => !l.endsWith(`: ${UNRECORDED}`);
  const x = fromClaude(a).filter(recorded);
  const y = fromCodex(b, rollout, PROMPT).filter(recorded);
  const at = x.findIndex((l, i) => y[i] === undefined || !same(l, y[i]));
  if (at < 0 && x.length === y.length) return { ok: true, text: `conversation: the same (${x.length} items: ${x.filter((l) => l.startsWith("call ")).length} tool calls)` };
  const i = at < 0 ? Math.min(x.length, y.length) : at;
  return { ok: false, text: `conversation: ${x.length} items in Claude Code, ${y.length} in Codex; they differ at item ${i + 1}\n      claude …${(x[i] ?? "(none)").slice(0, 200)}\n      codex  …${(y[i] ?? "(none)").slice(0, 200)}` };
}

function compare(a, b) {
  return ["messages", "system", "tools"].map((k) => {
    const x = JSON.stringify(a?.[k]);
    const y = JSON.stringify(b?.[k]);
    if (x === y) return { ok: true, text: `${k}: identical (${x?.length ?? 0} bytes)` };
    let i = 0;
    while (i < Math.min(x?.length ?? 0, y?.length ?? 0) && x[i] === y[i]) i++;
    return { ok: false, text: `${k}: differ at byte ${i}\n      original …${x?.slice(Math.max(0, i - 80), i + 120)}…\n      fork     …${y?.slice(Math.max(0, i - 80), i + 120)}…` };
  });
}

let failed = 0;
for (const file of files) {
  const session = basename(file, ".jsonl");
  const cwd = lastCwd(file);
  console.log(`${session.slice(0, 8)} (${file})`);
  if (!cwd || !existsSync(cwd)) {
    console.log(`  skipped: the session's directory ${cwd ?? "(none)"} is not on this machine`);
    continue;
  }
  const root = realpathSync(mkdtempSync(join(tmpdir(), "braid-resume-check-")));
  try {
    const [home, config, code, copy, codexHome] = ["home", "claude", "code", "transcript", "codex"].map((d) => join(root, d));
    for (const d of [home, config, code, copy, codexHome]) mkdirSync(d, { recursive: true });
    const braid = (...args) => spawnSync(process.execPath, [BRAID, ...args], { cwd: code, env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: config, CODEX_HOME: codexHome, XDG_CONFIG_HOME: join(home, ".config"), BRAID_SESSION: "" }, encoding: "utf8" });
    spawnSync("git", ["init", "-q"], { cwd: code });
    braid("init");
    // A copy for braid to save, and the same copy where Claude Code looks for the original.
    const saved = join(copy, `${session}.jsonl`);
    cpSync(file, saved);
    const projects = join(config, "projects", project(realpathSync(cwd)));
    mkdirSync(projects, { recursive: true });
    cpSync(saved, join(projects, `${session}.jsonl`));
    const sidecar = file.replace(/\.jsonl$/, "");
    if (existsSync(sidecar)) cpSync(sidecar, join(copy, session), { recursive: true });
    braid("save", "--session", session, "--transcript", saved);
    const verified = braid("verify", "--session", session);
    console.log(verified.stdout.trimEnd().replace(/^/gm, "  "));
    // Without the transcript, braid writes the fork from the store alone.
    writeFileSync(saved, "");
    const fork = /(?:--resume|codex resume) (\S+)/.exec(braid("fork", session, "--cwd", cwd, "--to", to).stdout)?.[1];
    if (!fork) throw new Error("braid fork wrote no session");
    // The rollout braid wrote, read before Codex resumes it and adds its own lines.
    const rolloutFile = to === "codex" ? readdirSync(join(codexHome, "sessions"), { recursive: true }).find((f) => String(f).endsWith(`${fork}.jsonl`)) : undefined;
    const rollout = rolloutFile ? readFileSync(join(codexHome, "sessions", String(rolloutFile)), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    const a = await resumeRequest(config, cwd, session);
    const b = to === "codex" ? await codexRequest(codexHome, cwd, fork) : await resumeRequest(config, cwd, fork);
    if (!a || !b) throw new Error(`${a ? (to === "codex" ? "Codex" : "Claude Code") : "Claude Code"} made no request for the ${a ? "fork" : "original"}`);
    // RESUME_CHECK_KEEP=<dir> keeps both requests, for a closer look.
    if (process.env.RESUME_CHECK_KEEP) {
      for (const [name, req] of [["original", a], [to === "codex" ? "codex" : "fork", b], ...(to === "codex" ? [["rollout", rollout]] : [])]) writeFileSync(join(process.env.RESUME_CHECK_KEEP, `${session}.${name}.json`), JSON.stringify(req));
    }
    const results = to === "codex" ? [compareConversation(a, b, rollout)] : compare(a, b);
    console.log(to === "codex" ? `  Claude Code resumes the original with ${a.messages.length} messages, Codex the fork with ${b.input.length} items:` : `  Claude Code resumes the original with ${a.messages.length} messages, the fork with ${b.messages.length}:`);
    for (const r of results) console.log(`    ${r.ok ? "✓" : "✗"} ${r.text}`);
    if (verified.status !== 0 || results.some((r) => !r.ok)) failed++;
  } catch (e) {
    console.log(`  ✗ ${e.message}`);
    failed++;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
process.exit(failed ? 1 : 0);
