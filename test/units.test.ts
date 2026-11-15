import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { publishedChunks } from "../src/publish.ts";
import { about, ago, isPrompt, parseJsonl, printable, promptLine, type Rec } from "../src/records.ts";
import { lineOf, numbering, turnsAlong } from "../src/turns.ts";
import { redactString } from "../src/redact.ts";
import { readConfig, type Repo } from "../src/repo.ts";
import { cleanName, colors, render, uncovered, type Status } from "../src/status.ts";
import { intact, readWindow, START } from "../src/transcript.ts";
import { parseToml } from "../src/rules.ts";
import { ignoredBy, parseIgnore } from "../src/ignore.ts";
import { bigTurn, patchedFiles } from "../src/points.ts";
import { Transcript } from "./helpers.ts";

const example = parseJsonl(readFileSync(join(import.meta.dirname, "..", "examples", "pr-review", "conversation.atxf.jsonl"), "utf8"));
const ids = (...list: string[]) => example.filter((r) => list.includes(r.id));
const range = (prefix: string, from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);

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

test("↓ counts records that no merge covers", () => {
  const bob = ids(...range("r", 1, 5), "l1");
  const beforeMerge = ids(...range("e", 1, 12));
  assert.equal(uncovered(beforeMerge, bob).length, 5);
  const afterMerge = ids(...range("e", 1, 12), ...range("s", 1, 4), "m1");
  assert.equal(uncovered(afterMerge, bob).length, 0);
  const r6: Rec = { ...bob.find((r) => r.id === "r5")!, id: "r6", parentId: "r5" };
  assert.equal(uncovered(afterMerge, [...bob, r6]).length, 1, "a record after the merged head waits again");
  assert.equal(uncovered(beforeMerge, bob, ["r5"]).length, 0, "a recorded merge not yet saved covers too");
});

test("the status line text", () => {
  const base: Status = { session: "s", enabled: true, saved: true, private: false, local: false, ahead: 0, uncommitted: 0, waiting: [] };
  assert.equal(render(base), "✓");
  assert.equal(render({ ...base, saved: false }), "not saved");
  assert.equal(render({ ...base, local: true, ahead: 3 }), "local");
  assert.equal(render({ ...base, ahead: 4 }), "↑4");
  assert.equal(render({ ...base, ahead: 4, uncommitted: 2 }), "↑4 · *2");
  assert.equal(render({ ...base, uncommitted: 2 }), "*2");
  const w = { session: "01a1bc3e", name: "review/bob", count: 5, head: "r5", base: "e8" };
  assert.equal(render({ ...base, ahead: 4, waiting: [w] }), "↑4 · ↓ review/bob +5 → /braid:merge");
  assert.equal(render({ ...base, waiting: [w, { ...w, count: 2 }] }), "↓ 2 sessions +7 → /braid:merge");
  assert.equal(cleanName("\u001b[2Kall clear ✓"), "2Kallclear");
});

test("published copies drop withheld and unpublished records and keep the tree connected", () => {
  const chunk: Rec[] = [
    { type: "message", id: "u1", parentId: null, role: "user", content: "hello" },
    { type: "custom", id: "c1", parentId: "u1" },
    { type: "message", id: "a1", parentId: "c1", role: "assistant", content: [{ type: "reasoning", text: "x" }] },
    { type: "message", id: "a2", parentId: "a1", role: "assistant", content: [{ type: "text", text: "secret AKIAABCDEFGHIJKLMNOP" }] },
    { type: "message", id: "u2", parentId: "a2", role: "user", content: "withheld" },
    { type: "message", id: "a3", parentId: "u2", role: "assistant", content: [{ type: "text", text: "after" }], native: { records: [] } },
  ];
  const { chunks, counts } = publishedChunks([chunk], new Set(["u2"]));
  const out = chunks.flat();
  assert.deepEqual(out.map((r) => r.id), ["u1", "a2", "a3"]);
  assert.equal(out.find((r) => r.id === "a2")!.parentId, "u1", "custom and reasoning-only records are skipped over");
  assert.equal(out.find((r) => r.id === "a3")!.parentId, "a2", "withheld records are skipped over");
  assert.equal(out.find((r) => r.id === "a3")!.native, undefined);
  assert.equal(counts.get("aws-access-key"), 1);
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

test("rules files, .braidignore and home directories", () => {
  const t = parseToml(`# team rules
terms = ["Acme Corp",
  "Project Falcon"]   # names under NDA
patterns = ['CUST-\\d{6}']
withhold-session = true
`);
  assert.deepEqual(t.terms, ["Acme Corp", "Project Falcon"]);
  assert.deepEqual(t.patterns, ["CUST-\\d{6}"]);
  assert.equal(t["withhold-session"], true);

  const rules = parseIgnore(`# .braidignore
.env
.env.*
!.env.example
*.pem
/customers/
data/raw/**
secrets
!secrets/README.md
`);
  const ignored = (p: string) => ignoredBy(rules, p)?.pattern;
  assert.equal(ignored(".env"), ".env");
  assert.equal(ignored("api/.env.local"), ".env.*", "a pattern without a slash matches in any directory");
  assert.equal(ignored(".env.example"), undefined, "! re-includes");
  assert.equal(ignored("keys/server.pem"), "*.pem");
  assert.equal(ignored("keys/server.pem.txt"), undefined);
  assert.equal(ignored("customers/acme/contract.md"), "/customers/", "everything under an ignored directory");
  assert.equal(ignored("old/customers/x.md"), undefined, "a leading slash anchors to the root");
  assert.equal(ignored("data/raw/2026/x.csv"), "data/raw/**");
  assert.equal(ignored("src/data/raw/x.csv"), undefined, "a slash inside anchors too");
  assert.equal(ignored("secrets/README.md"), "secrets", "nothing is re-included inside an ignored directory");
  assert.equal(ignored("src/app.ts"), undefined);
  const counts = new Map<string, number>();
  assert.equal(redactString("ran /home/alice/dev/app and C:\\Users\\bob\\x and /Users/carol", counts), "ran ~/dev/app and ~\\x and ~");
});

test("autopilot by default, and the settings that change it", () => {
  const dir = mkdtempSync(join(tmpdir(), "braid-config-"));
  const home = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(dir, "config");
  try {
    mkdirSync(join(dir, ".braid"));
    const repo = { top: dir } as Repo;
    const write = (text: string) => writeFileSync(join(dir, ".braid", "config.toml"), text);
    write("");
    const d = readConfig(repo);
    assert.deepEqual([d.autopilot, d.autofork, d.autopush, d.link, d.autocommit], [true, true, false, "store", false], "the defaults: autopilot, so no autopush and no trailers");
    write("autopilot = false\nautopush = false\n");
    assert.equal(readConfig(repo).autopush, false, "autopush off");
    write("autopilot = false\n");
    assert.deepEqual([readConfig(repo).autopush, readConfig(repo).autocommit, readConfig(repo).link], [true, false, "trailer"], "the defaults off autopilot");
    mkdirSync(join(dir, "config", "braid"), { recursive: true });
    writeFileSync(join(dir, "config", "braid", "config.toml"), "autocommit = true\nautopush = false\n");
    assert.deepEqual([readConfig(repo).autopush, readConfig(repo).autocommit], [false, true], "your own settings win");
    writeFileSync(join(dir, "config", "braid", "config.toml"), "autopilot = true\n");
    assert.equal(readConfig(repo).autopush, false, "your own autopilot keeps git push from publishing");
  } finally {
    if (home === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = home;
  }
});

test("a session that failed braid verify says so in the status line", () => {
  const base: Status = { session: "s", enabled: true, saved: true, private: false, local: true, ahead: 0, uncommitted: 0, waiting: [] };
  assert.equal(render(base), "local");
  assert.equal(render({ ...base, broken: true }), "⚠ braid verify · local");
});

test("the status line's colors, and none with NO_COLOR", () => {
  const base: Status = { session: "s", enabled: true, saved: true, private: false, local: false, ahead: 0, uncommitted: 0, waiting: [] };
  const { paint, sep } = colors({});
  assert.equal(render(base, paint, sep), "\x1b[32m✓\x1b[39m");
  assert.equal(render({ ...base, broken: true, ahead: 2 }, paint, sep), "\x1b[31m⚠ braid verify\x1b[39m\x1b[2m · \x1b[22m\x1b[33m↑2\x1b[39m");
  const off = colors({ NO_COLOR: "1" });
  assert.equal(render({ ...base, broken: true, ahead: 2 }, off.paint, off.sep), "⚠ braid verify · ↑2");
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

test("a big turn counts the files Codex patches, as Claude Code's edits", () => {
  const patch = (...files: string[]) =>
    `*** Begin Patch\n${files.map((f, i) => (i % 2 ? `*** Update File: ${f}\n@@\n-a\n+b` : `*** Add File: ${f}\n+new`)).join("\n")}\n*** End Patch\n`;
  assert.deepEqual(patchedFiles("*** Begin Patch\n*** Update File: a.ts\n*** Move to: b.ts\n@@\n*** Delete File: c.ts \n*** End Patch"), ["a.ts", "b.ts", "c.ts"]);
  assert.deepEqual(patchedFiles("no patch here\n*** Add File: x.ts"), []);
  const call = (block: object): Rec => ({ type: "message", id: `c${Math.random()}`, role: "assistant", content: [{ type: "tool_call", id: "x", ...block }] });
  // apply_patch as a custom tool: four files in one patch, a fifth in another.
  const turn = [call({ name: "apply_patch", kind: "custom", input: patch("a.ts", "b.ts", "c.ts", "d.ts") }), call({ name: "apply_patch", kind: "custom", input: patch("e.ts") })];
  assert.equal(bigTurn(turn), "5 files edited");
  assert.equal(bigTurn(turn.slice(0, 1)), undefined, "four files are not a big turn");
  // apply_patch run through the shell, as exec_command or local_shell.
  assert.equal(bigTurn([call({ name: "exec_command", kind: "function", arguments: { cmd: `apply_patch <<'EOF'\n${patch("a.ts", "b.ts", "c.ts")}EOF` } }), call({ name: "local_shell", kind: "builtin", arguments: { command: ["apply_patch", patch("d.ts", "e.ts")] } })]), "5 files edited");
  // Claude Code's edits still count, and the same file twice is one file.
  const edit = (path: string) => call({ name: "Write", kind: "function", arguments: { file_path: path, content: "x" } });
  assert.equal(bigTurn([edit("a.ts"), edit("a.ts"), edit("b.ts"), edit("c.ts"), edit("d.ts")]), undefined);
  assert.equal(bigTurn([edit("a.ts"), edit("b.ts"), edit("c.ts"), edit("d.ts"), edit("e.ts")]), "5 files edited");
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

test("turns are numbered along a session's line: a fork continues the numbering of the session it forks from", () => {
  const msg = (id: string, parentId: string | null, role: string, content: unknown = "x"): Rec => ({ type: "message", id, parentId, role, content });
  const a: Rec[] = [msg("p1", null, "user", "Plan."), msg("a1", "p1", "assistant"), msg("p2", "a1", "user", "Build."), msg("a2", "p2", "assistant")];
  // Forked after turn 1, then a merge.
  const b: Rec[] = [msg("q", "a1", "user", "Build it differently."), msg("r", "q", "assistant"), { type: "branch_summary", id: "m", parentId: "r", fromId: "a2", summary: "took the tests" }];
  const sessions = [{ session: "aaaaaaaa-1", records: a }, { session: "bbbbbbbb-2", records: b }];
  const turns = numbering(sessions);
  assert.deepEqual([...turns.get("aaaaaaaa-1")!.values()], [1, 1, 2, 2]);
  assert.deepEqual([...turns.get("bbbbbbbb-2")!.values()], [2, 2, 3]);
  const line = lineOf(sessions, "bbbbbbbb-2");
  assert.deepEqual(line.map((s) => [s.session, s.records.map((r) => r.id)]), [["aaaaaaaa-1", ["p1", "a1"]], ["bbbbbbbb-2", ["q", "r", "m"]]]);
  assert.deepEqual(turnsAlong(line, turns).map((t) => [t.session, t.n, t.start?.id]), [["aaaaaaaa-1", 1, "p1"], ["bbbbbbbb-2", 2, "q"], ["bbbbbbbb-2", 3, "m"]]);
});
