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
// Usage: node scripts/resume-check.mjs <transcript.jsonl>...
// Needs `claude` on PATH, and dist/braid.mjs built (npm run build).
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BRAID = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "braid.mjs");
const files = process.argv.slice(2);
if (!files.length) {
  console.error("usage: node scripts/resume-check.mjs <transcript.jsonl>...");
  process.exit(2);
}

const project = (dir) => dir.replace(/[^A-Za-z0-9]/g, "-");

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
  const args = ["-p", "--resume", session, "--model", "claude-sonnet-5-5", "--max-turns", "1", "--no-session-persistence", "Reply with OK."];
  await new Promise((ok) => spawn("claude", args, { cwd, env, stdio: ["ignore", "ignore", "ignore"] }).on("exit", ok));
  server.close();
  return requests.find((r) => Array.isArray(r.messages) && r.messages.length);
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
    const [home, config, code, copy] = ["home", "claude", "code", "transcript"].map((d) => join(root, d));
    for (const d of [home, config, code, copy]) mkdirSync(d, { recursive: true });
    const braid = (...args) => spawnSync(process.execPath, [BRAID, ...args], { cwd: code, env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: config, XDG_CONFIG_HOME: join(home, ".config"), BRAID_SESSION: "" }, encoding: "utf8" });
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
    const fork = /--resume (\S+)/.exec(braid("fork", session, "--cwd", cwd).stdout)?.[1];
    if (!fork) throw new Error("braid fork wrote no session");
    const [a, b] = [await resumeRequest(config, cwd, session), await resumeRequest(config, cwd, fork)];
    if (!a || !b) throw new Error(`Claude Code made no request for the ${a ? "fork" : "original"}`);
    const results = compare(a, b);
    console.log(`  Claude Code resumes the original with ${a.messages.length} messages, the fork with ${b.messages.length}:`);
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
