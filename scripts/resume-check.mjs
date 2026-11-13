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
// A Codex rollout given (rollout-…-<id>.jsonl) goes the other way: braid saves
// it, Codex resumes the original, Claude Code resumes the fork braid writes
// for it, and the conversation is compared the same way. With --to codex, a
// rollout is forked into Codex, and Codex resumes both.
//
// Usage: node scripts/resume-check.mjs [--to codex] <transcript.jsonl>...
// Needs `claude` on PATH (and `codex`, or CODEX=<path>, for --to codex and for rollouts), and dist/braid.mjs built (npm run build).
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

/** The directory the session was in last, where its agent resumes it. */
function lastCwd(file) {
  let cwd;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    try {
      const v = JSON.parse(line);
      if (typeof v.cwd === "string") cwd = v.cwd;
      if (typeof v.payload?.cwd === "string") cwd = v.payload.cwd;
    } catch {}
  }
  return cwd;
}

/** Whether a transcript is a Codex rollout, which starts with the session's metadata. */
const isRollout = (file) => /^\{[^\n]*"type":"session_meta"/.test(readFileSync(file, "utf8").slice(0, 4096));

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

/**
 * Resumes a session with Codex against a local server, and returns the first request it makes to the model.
 * Codex resumes a session only with the model provider it ran with, which goes to the local server too:
 * OpenAI's through openai_base_url, another as a provider of that name.
 */
async function codexRequest(home, cwd, session, provider = "check") {
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
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  const config =
    provider === "openai"
      ? `openai_base_url = "${url}"\nrequest_max_retries = 0\nstream_max_retries = 0\n`
      : `model_provider = ${JSON.stringify(provider)}\n\n[model_providers.${JSON.stringify(provider)}]\nname = ${JSON.stringify(provider)}\nbase_url = "${url}"\nwire_api = "responses"\nenv_key = "RESUME_CHECK_KEY"\nrequest_max_retries = 0\nstream_max_retries = 0\n`;
  writeFileSync(join(home, "config.toml"), config);
  const env = { ...process.env, CODEX_HOME: home, RESUME_CHECK_KEY: "resume-check" };
  for (const k of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY"]) delete env[k];
  if (provider === "openai") env.OPENAI_API_KEY = "sk-resume-check";
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
  // In a rollout braid wrote (ATXF's), a developer message is a note braid wrote; in one Codex wrote, Codex's context.
  const byBraid = rollout.find((l) => l.type === "session_meta")?.payload?.originator === "atxf";
  const ours = new Set(
    rollout.flatMap((l) =>
      l.type === "response_item" && l.payload?.type === "message" && (byBraid || !codexContext(l.payload)) ? [text(l.payload.content)]
      : l.type === "compacted" ? [String(l.payload?.message ?? "").trim()]
      : [],
    ),
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
    // A custom tool's call (apply_patch) takes its input as text, which Claude Code sends as {"input": text}.
    if (i.type === "custom_tool_call") return [`call ${i.call_id} ${i.name} ${args({ input: i.input })}`];
    if (i.type === "function_call_output" || i.type === "custom_tool_call_output") {
      const t = text(typeof i.output === "string" ? i.output : i.output?.content);
      return [`result ${i.call_id}: ${t === "aborted" ? UNRECORDED : t}`];
    }
    return [];
  });
}

// Codex's context for its own model: its instructions as developer messages, the environment and AGENTS.md.
const codexContext = (p) => p.role === "developer" || p.role === "system" || /^\s*(<environment_context>|<user_instructions>|# AGENTS\.md instructions for )/.test(text(p.content));

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

// Codex compacts a session it resumes before the next turn when its last recorded usage is near the model's limit:
// its first request then asks for a summary of the conversation, in place of the prompt.
const COMPACTING = /^user: You are performing a CONTEXT CHECKPOINT COMPACTION/;

/**
 * The conversation in a request to either agent's model, a Claude request having messages and a Codex request
 * input, up to the prompt that resumed it.
 */
const conversationOf = (req, rollout) => {
  const items = req.messages ? fromClaude(req) : fromCodex(req, rollout, PROMPT);
  const last = items.at(-1);
  return last === `user: ${PROMPT}` || COMPACTING.test(last ?? "") ? items.slice(0, -1) : items;
};

/** Compares the conversation of two requests, `a` resuming the original and `b` the fork, with the rollout each Codex one read. */
function compareConversation(a, b, rollouts) {
  const recorded = (l) => !l.endsWith(`: ${UNRECORDED}`);
  const x = conversationOf(a, rollouts.a).filter(recorded);
  const y = conversationOf(b, rollouts.b).filter(recorded);
  // Claude Code is the one that sends a call otherwise: unmoved and added apply to its side.
  const match = (l, m) => (a.messages ? same(l, m) : same(m, l));
  const at = x.findIndex((l, i) => y[i] === undefined || !match(l, y[i]));
  if (at < 0 && x.length === y.length) return { ok: true, text: `conversation: the same (${x.length} items: ${x.filter((l) => l.startsWith("call ")).length} tool calls)` };
  const i = at < 0 ? Math.min(x.length, y.length) : at;
  const [na, nb] = [a, b].map((r) => (r.messages ? "claude" : "codex "));
  return { ok: false, text: `conversation: ${x.length} items in the original's request, ${y.length} in the fork's; they differ at item ${i + 1}\n      ${na} …${(x[i] ?? "(none)").slice(0, 200)}\n      ${nb} …${(y[i] ?? "(none)").slice(0, 200)}` };
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
  const fromCodexSession = isRollout(file);
  const session = fromCodexSession ? /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(file)?.[1] : basename(file, ".jsonl");
  if (!session) {
    console.log(`${file}\n  skipped: no session id in the rollout's name`);
    continue;
  }
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
    // A copy for braid to save, and the same copy where the agent looks for the original.
    const saved = join(copy, fromCodexSession ? basename(file) : `${session}.jsonl`);
    cpSync(file, saved);
    // Codex finds a rollout by its id under the day its name starts with.
    const day = /^rollout-(\d{4})-(\d{2})-(\d{2})T/.exec(basename(file))?.slice(1) ?? [];
    const original = fromCodexSession ? join(codexHome, "sessions", ...day, basename(file)) : join(config, "projects", project(realpathSync(cwd)), `${session}.jsonl`);
    mkdirSync(dirname(original), { recursive: true });
    cpSync(saved, original);
    const sidecar = file.replace(/\.jsonl$/, "");
    if (existsSync(sidecar)) cpSync(sidecar, join(copy, session), { recursive: true });
    braid("save", "--session", session, "--transcript", saved);
    const verified = braid("verify", "--session", session);
    console.log(verified.stdout.trimEnd().replace(/^/gm, "  "));
    // Without the transcript, braid writes the fork from the store alone.
    writeFileSync(saved, "");
    const fork = /(?:--resume|codex resume) (\S+)/.exec(braid("fork", session, "--cwd", cwd, "--to", to).stdout)?.[1];
    if (!fork) throw new Error("braid fork wrote no session");
    // Each rollout as Codex reads it, before it resumes it and adds its own lines.
    const lines = (f) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const rolloutFile = to === "codex" ? readdirSync(join(codexHome, "sessions"), { recursive: true }).find((f) => String(f).endsWith(`${fork}.jsonl`)) : undefined;
    const rollouts = { a: fromCodexSession ? lines(original) : [], b: rolloutFile ? lines(join(codexHome, "sessions", String(rolloutFile))) : [] };
    const provider = (rollout) => rollout.find((l) => l.type === "session_meta")?.payload?.model_provider;
    const resume = (agent, id, rollout) => (agent === "codex" ? codexRequest(codexHome, cwd, id, provider(rollout)) : resumeRequest(config, cwd, id));
    const a = await resume(fromCodexSession ? "codex" : "claude-code", session, rollouts.a);
    const b = await resume(to, fork, rollouts.b);
    if (!a || !b) throw new Error(`${a ? to : fromCodexSession ? "codex" : "claude-code"} made no request for the ${a ? "fork" : "original"}`);
    // RESUME_CHECK_KEEP=<dir> keeps both requests, for a closer look.
    if (process.env.RESUME_CHECK_KEEP) {
      for (const [name, req] of [["original", a], ["fork", b], ["rollout", rollouts.a.length ? rollouts.a : rollouts.b]]) writeFileSync(join(process.env.RESUME_CHECK_KEEP, `${session}.${name}.json`), JSON.stringify(req));
    }
    const across = fromCodexSession || to === "codex";
    const results = across ? [compareConversation(a, b, rollouts)] : compare(a, b);
    const size = (r) => (r.messages ? `${r.messages.length} messages` : `${r.input.length} items`);
    const who = (agent) => (agent === "codex" ? "Codex" : "Claude Code");
    console.log(`  ${who(fromCodexSession ? "codex" : "claude-code")} resumes the original with ${size(a)}, ${who(to)} the fork with ${size(b)}:`);
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
