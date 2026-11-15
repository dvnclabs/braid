import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { about, ago, isPrompt, parseJsonl, printable, promptLine, type Rec } from "../src/records.ts";
import { patchedFiles, turnDetail, turnsOf } from "../src/turns.ts";
import { redactString } from "../src/redact.ts";
import { projectOf, repoFor } from "../src/repo.ts";
import { recordSession } from "../src/registry.ts";
import { spawnSync } from "node:child_process";
import { colors, render, type Status } from "../src/status.ts";
import { intact, readWindow, START } from "../src/transcript.ts";
import { Transcript } from "./helpers.ts";


test("redaction catches credentials and leaves code alone", () => {
  const cases: [string, string][] = [
    ["key AKIAABCDEFGHIJKLMNOP here", "aws-access-key"],
    [`token ghp_${"a".repeat(36)}`, "github-token"],
    [`sk-ant-${"b".repeat(30)}`, "anthropic-key"],
    [`OPENAI_API_KEY=sk-${"c".repeat(40)}`, "openai-key"],
    ["export DB_PASSWORD=hunter2hunter2", "env-secret"],
    ['const config = { password: "correct-horse-battery" }', "quoted-secret"],
    ["postgres://admin:s3cretpass@db:5432/app", "url-password"],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----", "private-key"],
  ];
  for (const [input, rule] of cases) {
    const counts = new Map<string, number>();
    const out = redactString(input, counts);
    assert.match(out, new RegExp(`\\[REDACTED:${rule}\\]`), input);
    assert.ok((counts.get(rule) ?? 0) >= 1, input);
  }
  for (const code of ["const token = getToken(request);", "if (password.length < 12) throw new Error()", "sendWebhook(url, body)"]) {
    const counts = new Map<string, number>();
    assert.equal(redactString(code, counts), code);
    assert.equal(counts.size, 0);
  }
  assert.equal(redactString(`${homedir()}/work/app.ts`, new Map()), "~/work/app.ts");
});

test("reading a transcript in windows gives the records of reading it whole", () => {
  const dir = mkdtempSync(join(tmpdir(), "braid-window-"));
  const session = "5b0e2c1a-7f3d-4c2e-9a61-0d8e4b2f6c13";
  const t = new Transcript(dir, session);
  for (let i = 0; i < 12; i++) {
    t.user(`step ${i} ${"x".repeat(i * 40)}`);
    appendFileSync(t.path, JSON.stringify({ type: "queue-operation", operation: "enqueue", sessionId: session }) + "\n");
    t.assistant(`done ${i}`);
    // A last prompt pointing back further than the overlap reaches.
    const first = JSON.parse(readFileSync(t.path, "utf8").split("\n")[0]!).uuid;
    if (i === 9) appendFileSync(t.path, JSON.stringify({ type: "last-prompt", lastPrompt: "step 0", leafUuid: first, sessionId: session }) + "\n");
  }
  // Claude Code writes some lines again under the uuid they have, as after a resume: one from far back, one from close by.
  const lines = readFileSync(t.path, "utf8").split("\n").filter(Boolean);
  const again = [lines[0]!, lines.at(-1)!].map((l) => ({ ...JSON.parse(l), cwd: "/work/sub" }));
  for (const l of again) appendFileSync(t.path, JSON.stringify(l) + "\n");
  const whole = readWindow(t.path, START, session)!;
  assert.equal(whole.more, false);

  // Small windows with a small overlap: records cross every boundary.
  const pieces: Rec[] = [];
  let cursor = START;
  for (let w = readWindow(t.path, cursor, session, { maxBytes: 700, overlap: 300 }); w; w = readWindow(t.path, cursor, session, { maxBytes: 700, overlap: 300 })) {
    pieces.push(...w.records.slice(w.fresh));
    cursor = w.cursor;
  }
  const shape = (rs: Rec[]) => rs.map((r) => `${r.type}:${r.id}<${r.parentId ?? ""}${r.targetId ? `>${String(r.targetId)}` : ""}`);
  assert.deepEqual(shape(pieces), shape(whole.records));
  for (const l of again) assert.equal(whole.records.filter((r) => r.id === l.uuid).length, 2, "a line written twice is two records under its uuid");
  assert.ok(whole.records.some((r) => r.id === `claude-line-36@5b0e2c1a`), "line ids count lines of the whole file");
  assert.equal(cursor.offset, statSync(t.path).size);
  assert.equal(intact(t.path, cursor), true);

  // A rewritten file no longer matches the cursor.
  const text = readFileSync(t.path, "utf8");
  const at = text.lastIndexOf("done 11");
  writeFileSync(t.path, `${text.slice(0, at)}done XI${text.slice(at + "done 11".length)}`);
  assert.equal(intact(t.path, cursor), false);
  writeFileSync(t.path, text.slice(0, 100));
  assert.equal(intact(t.path, cursor), false);
});

test("what a session is about: a name you gave, else the agent's title, else the first prompt; and the newest recap", () => {
  const meta = (title: string, kind: string): Rec => ({ type: "metadata", id: `m-${title}`, title, native: { source: "claude-code", records: [{ type: kind }] } });
  const recap = (text: string, time: string): Rec => ({
    type: "custom",
    id: `r-${time}`,
    time,
    namespace: "claude-code",
    name: "system:away_summary",
    native: { source: "claude-code", records: [{ type: "system", subtype: "away_summary", content: text }] },
  });
  const command: Rec = { type: "message", id: "u0", role: "user", content: "<command-name>/braid:init</command-name>" };
  const prompt: Rec = { type: "message", id: "u1", role: "user", content: [{ type: "text", text: "Add retries; key AKIAABCDEFGHIJKLMNOP\nand more" }] };
  assert.deepEqual(about([command, prompt]).title, { text: "Add retries; key [REDACTED:aws-access-key]", by: "prompt" });
  const titled = about([prompt, meta("Webhook retries", "ai-title")]);
  assert.deepEqual(titled.title, { text: "Webhook retries", by: "agent" });
  const named = about([meta("retries-v2", "custom-title")], titled);
  assert.equal(about([meta("A newer title", "ai-title"), prompt], named).title?.text, "retries-v2", "a name you gave stays");
  const latest = about([recap("first", "2026-11-14T10:00:00Z"), recap("You're adding retries.\u001b[31m Next: a budget", "2026-11-14T12:00:00Z")]);
  assert.deepEqual(latest.recap, { text: "You're adding retries. Next: a budget", at: "2026-11-14T12:00:00Z" });
  assert.equal(printable("a\u001b[2Kb\u0007c\nd", 20), "ab c d", "no escapes or control characters reach the terminal");
});

test("how long ago", () => {
  const now = Date.parse("2026-11-14T12:00:00Z");
  assert.equal(ago("2026-11-14T11:59:30Z", now), "just now");
  assert.equal(ago("2026-11-14T11:55:00Z", now), "5 minutes ago");
  assert.equal(ago("2026-11-14T10:00:00Z", now), "2 hours ago");
  assert.equal(ago("2026-11-13T12:00:00Z", now), "24 hours ago");
  assert.equal(ago("2026-11-11T12:00:00Z", now), "3 days ago");
});

test("a turn starts at a prompt you typed, or a merge", () => {
  const user = (content: unknown, extra: object = {}): Rec => ({ type: "message", id: `u${Math.random()}`, role: "user", content, ...extra });
  const claude = (line: object): object => ({ native: { source: "claude-code", records: [line] } });
  assert.equal(isPrompt(user("Add retries.")), true);
  assert.equal(isPrompt(user("<command-message>braid:init</command-message>\n<command-name>/braid:init</command-name>")), true, "a command you typed");
  assert.equal(isPrompt(user([{ type: "tool_result", tool_use_id: "t", content: "ok" }])), false);
  assert.equal(isPrompt(user("Base directory for this skill", { display: false })), false);
  assert.equal(isPrompt(user("<task-notification>done</task-notification>")), false);
  assert.equal(isPrompt(user("[Request interrupted by user]")), false);
  assert.equal(isPrompt(user("<local-command-stdout>ok</local-command-stdout>")), false);
  assert.equal(isPrompt(user("Background task finished", claude({ type: "user", origin: { kind: "task-notification" } }))), false);
  assert.equal(isPrompt(user("Summary of the session", claude({ type: "user", isCompactSummary: true }))), false);
  const codex = (text: string): Rec => ({ type: "message", id: `c${Math.random()}`, role: "user", content: [{ type: "text", text }], native: { source: "codex", format: "codex-rollout", records: [{}] } });
  assert.equal(isPrompt(codex("Fix the bug.")), true);
  assert.equal(isPrompt(codex("<environment_context>\n<cwd>/w</cwd>\n</environment_context>")), false);
  assert.equal(isPrompt(codex("<skill>\n<name>tests</name>\n</skill>")), false);
  assert.equal(isPrompt({ type: "message", id: "a", role: "assistant", content: "Done." }), false);
  assert.equal(promptLine(user("<command-message>braid:fork</command-message>\n<command-name>/braid:fork</command-name>\n<command-args>.3 --to codex</command-args>")), "/braid:fork .3 --to codex");
  assert.equal(promptLine(user("Add retries.\nAnd tests.")), "Add retries. And tests.");
});

test("what a turn did: the files Claude Code's edits write and a Codex patch names, and its tool calls", () => {
  const patch = (...files: string[]) =>
    `*** Begin Patch\n${files.map((f, i) => (i % 2 ? `*** Update File: ${f}\n@@\n-a\n+b` : `*** Add File: ${f}\n+new`)).join("\n")}\n*** End Patch\n`;
  assert.deepEqual(patchedFiles("*** Begin Patch\n*** Update File: a.ts\n*** Move to: b.ts\n@@\n*** Delete File: c.ts \n*** End Patch"), ["a.ts", "b.ts", "c.ts"]);
  assert.deepEqual(patchedFiles("no patch here\n*** Add File: x.ts"), []);
  const call = (block: object): Rec => ({ type: "message", id: `c${Math.random()}`, role: "assistant", content: [{ type: "tool_call", id: "x", ...block }] });
  assert.equal(turnDetail([call({ name: "apply_patch", kind: "custom", input: patch("a.ts", "b.ts", "c.ts", "d.ts") }), call({ name: "apply_patch", kind: "custom", input: patch("e.ts") })]), "5 files edited, 2 tool calls");
  assert.equal(turnDetail([call({ name: "exec_command", kind: "function", arguments: { cmd: `apply_patch <<'EOF'\n${patch("a.ts", "b.ts")}EOF` } }), call({ name: "local_shell", kind: "builtin", arguments: { command: ["apply_patch", patch("c.ts")] } })]), "3 files edited, 2 tool calls");
  const edit = (path: string) => call({ name: "Write", kind: "function", arguments: { file_path: path, content: "x" } });
  assert.equal(turnDetail([edit("a.ts"), edit("a.ts"), edit("b.ts")]), "2 files edited, 3 tool calls", "the same file twice is one file");
  assert.equal(turnDetail([call({ name: "Read", kind: "function", arguments: { file_path: "a.ts" } })]), "1 tool call");
  assert.equal(turnDetail([]), "");
});

test("a project is a git repository's main checkout, or the folder itself; a session stays where it was first kept", () => {
  const dir = mkdtempSync(join(tmpdir(), "braid-project-"));
  const git = (cwd: string, ...args: string[]) => assert.equal(spawnSync("git", args, { cwd, encoding: "utf8" }).status, 0, args.join(" "));
  const main = join(dir, "main");
  mkdirSync(main);
  git(main, "init", "--quiet");
  git(main, "-c", "user.email=a@b.c", "-c", "user.name=a", "commit", "--quiet", "--allow-empty", "-m", "init");
  git(main, "worktree", "add", "--quiet", join(dir, "feature"));
  mkdirSync(join(main, "sub"));
  const real = (p: string) => spawnSync("realpath", [p], { encoding: "utf8" }).stdout.trim();
  assert.equal(projectOf(join(main, "sub")), real(main));
  assert.equal(projectOf(join(dir, "feature")), real(main), "a worktree's conversations are kept in its main checkout");
  const loose = join(dir, "loose");
  mkdirSync(loose);
  assert.equal(projectOf(loose), real(loose), "outside any repository, the folder itself");
  const data = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = join(dir, "data");
  try {
    mkdirSync(join(main, ".braid"));
    recordSession("5b0e2c1a-0000-4000-8000-000000000000", { project: real(main) });
    assert.equal(repoFor("5b0e2c1a-0000-4000-8000-000000000000", loose).top, real(main), "a fork opened elsewhere stays with its conversation");
    assert.equal(repoFor("11111111-0000-4000-8000-000000000000", loose).top, real(loose));
  } finally {
    if (data === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = data;
  }
});

test("a session's turns, in the order of its file: each starts at a prompt you typed", () => {
  const msg = (id: string, role: string, content: unknown = "x"): Rec => ({ type: "message", id, role, content });
  const records = [{ type: "transcript", id: "h" } as Rec, msg("p1", "user", "Plan."), msg("a1", "assistant"), msg("n1", "user", "<task-notification>done</task-notification>"), msg("p2", "user", "Build."), msg("a2", "assistant")];
  assert.deepEqual(turnsOf(records).map((t) => [t.n, t.start?.id ?? null, t.records.map((r) => r.id)]), [[0, null, ["h"]], [1, "p1", ["p1", "a1", "n1"]], [2, "p2", ["p2", "a2"]]]);
});

test("the status line marks a session whose last check failed, in color, and without with NO_COLOR", () => {
  const base: Status = { session: "s", saved: true };
  assert.equal(render(base), "", "a session with nothing to say shows nothing more");
  assert.equal(render({ ...base, broken: true }), "⚠ braid verify");
  assert.equal(render({ ...base, broken: true }, colors({}).paint), "\x1b[31m⚠ braid verify\x1b[39m");
  assert.equal(render({ ...base, broken: true }, colors({ NO_COLOR: "1" }).paint), "⚠ braid verify");
});

