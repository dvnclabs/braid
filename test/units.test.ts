import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { publishedChunks } from "../src/publish.ts";
import { parseJsonl, type Rec } from "../src/records.ts";
import { redactString } from "../src/redact.ts";
import { cleanName, render, uncovered, type Status } from "../src/status.ts";
import { intact, readWindow, START } from "../src/transcript.ts";
import { parseToml } from "../src/rules.ts";
import { ignoredBy, parseIgnore } from "../src/ignore.ts";
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
  const base: Status = { session: "s", enabled: true, saved: true, private: false, local: false, ahead: 0, waiting: [] };
  assert.equal(render(base), "✓");
  assert.equal(render({ ...base, saved: false }), "not saved");
  assert.equal(render({ ...base, local: true, ahead: 3 }), "local");
  assert.equal(render({ ...base, ahead: 4 }), "↑4");
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
  }
  const whole = readWindow(t.path, START, session)!;
  assert.equal(whole.more, false);

  // Small windows with a small overlap: records cross every boundary.
  const pieces: Rec[] = [];
  let cursor = START;
  for (let w = readWindow(t.path, cursor, session, { maxBytes: 700, overlap: 300 }); w; w = readWindow(t.path, cursor, session, { maxBytes: 700, overlap: 300 })) {
    const seen = new Set(pieces.map((r) => r.id));
    pieces.push(...w.records.filter((r) => !seen.has(r.id)));
    cursor = w.cursor;
  }
  const shape = (rs: Rec[]) => rs.map((r) => `${r.type}:${r.id}<${r.parentId ?? ""}`);
  assert.deepEqual(shape(pieces), shape(whole.records));
  assert.ok(whole.records.some((r) => r.id === `claude-line-35@5b0e2c1a`), "line ids count lines of the whole file");
  assert.equal(cursor.offset, statSync(t.path).size);
  assert.equal(intact(t.path, cursor), true);

  // A rewritten file no longer matches the cursor.
  const text = readFileSync(t.path, "utf8");
  writeFileSync(t.path, text.replace("done 11", "done XI"));
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
