import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { publishedChunks } from "../src/publish.ts";
import { parseJsonl, type Rec } from "../src/records.ts";
import { redactString } from "../src/redact.ts";
import { cleanName, render, uncovered, type Status } from "../src/status.ts";

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
  assert.equal(render({ ...base, ahead: 4, waiting: [w] }), "↑4 · ↓ review/bob +5 → /braid:sync");
  assert.equal(render({ ...base, waiting: [w, { ...w, count: 2 }] }), "↓ 2 sessions +7 → /braid:sync");
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
