// End to end: two people, one remote. Alice works and pushes, Bob reviews,
// Alice merges the review. Every step goes through the CLI and real git.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { braid, clone, must, run, sandbox, Transcript } from "./helpers.ts";

const ALICE = "5b0e2c1a-7f3d-4c2e-9a61-0d8e4b2f6c13";
const BOB = "01a1bc3e-e950-7c4b-9e7a-62f0e9a7c418";

function records(env: NodeJS.ProcessEnv, cwd: string, gitDir: string | null, ref: string) {
  const g = gitDir ? ["--git-dir", gitDir] : [];
  const files = must(env, cwd, "git", [...g, "ls-tree", "-r", "--name-only", ref, "records/"]).split("\n").filter(Boolean);
  return files.flatMap((f) =>
    must(env, cwd, "git", [...g, "show", `${ref}:${f}`])
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l)),
  );
}

test("save, publish, review, merge", () => {
  const s = sandbox();
  const alice = clone(s, "alice", "alice@example.com");
  writeFileSync(join(alice, "README.md"), "shop\n");
  must(s.env, alice, "git", ["add", "."]);
  must(s.env, alice, "git", ["commit", "--quiet", "-m", "initial"]);
  must(s.env, alice, "git", ["push", "--quiet", "origin", "HEAD:main"]);

  // braid init: config, store, hooks. No gh here, so publishing starts off; turn it on.
  const init = braid(s.env, alice, ["init"]);
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /publish = "off"/);
  writeFileSync(join(alice, ".braid", "config.toml"), 'publish = "on-push"\nremote = "origin"\n');
  must(s.env, alice, "git", ["add", ".braid"]);
  must(s.env, alice, "git", ["commit", "--quiet", "-m", "Set up braid"]);
  must(s.env, alice, "git", ["push", "--quiet", "origin", "HEAD:main"]);

  // Alice's session starts: braid exports her session id for the agent's commands.
  const envFile = join(s.root, "env-alice");
  writeFileSync(envFile, "");
  const ta = new Transcript(s.root, ALICE);
  const hookIn = (session: string, t: Transcript, cwd: string) => JSON.stringify({ session_id: session, transcript_path: t.path, cwd });
  assert.equal(braid(s.env, alice, ["hook", "session-start"], hookIn(ALICE, ta, alice), { CLAUDE_ENV_FILE: envFile }).status, 0);
  assert.match(readFileSync(envFile, "utf8"), new RegExp(`export BRAID_SESSION=${ALICE}`));

  // First turn, with a secret in it. Stop saves the turn; the session is local.
  ta.user("Add retries to sendWebhook. My key is AKIAABCDEFGHIJKLMNOP.");
  ta.assistant("Added 3 retries with exponential backoff.");
  braid(s.env, alice, ["hook", "stop"], hookIn(ALICE, ta, alice));
  const status = () => braid(s.env, alice, ["status", "--session", ALICE]).stdout.split("\n")[0];
  assert.match(status()!, /: local$/);

  // The agent commits: the trailer links the commit, and the session shows ↑.
  writeFileSync(join(alice, "send.ts"), "export const retries = 3;\n");
  must(s.env, alice, "git", ["add", "."]);
  must({ ...s.env, BRAID_SESSION: ALICE }, alice, "git", ["commit", "--quiet", "-m", "Retry webhooks"]);
  assert.match(must(s.env, alice, "git", ["log", "-1", "--format=%B"]), new RegExp(`Braid-Session: ${ALICE}`));
  assert.match(status()!, /: ↑2$/);

  // git push publishes the session, redacted, without native lines or reasoning.
  const push = run(s.env, alice, "git", ["push", "origin", "HEAD:main"]);
  assert.equal(push.status, 0, push.stderr);
  assert.match(push.stderr, /braid: published 5b0e2c1a, 2 records, 1 secrets redacted/);
  const published = records(s.env, s.root, join(s.root, "remote.git"), `refs/braid/sessions/${ALICE}/${ALICE}`);
  const text = JSON.stringify(published);
  assert.doesNotMatch(text, /AKIAABCDEFGHIJKLMNOP/);
  assert.match(text, /\[REDACTED:aws-access-key\]/);
  assert.doesNotMatch(text, /"native":\{|private reasoning|"usage"/);
  assert.equal(published[0].type, "transcript");
  assert.match(status()!, /: ✓$/);

  // The status line: Alice's session id and state.
  const line = braid(s.env, alice, ["statusline"], JSON.stringify({ session_id: ALICE, workspace: { current_dir: alice } }));
  assert.equal(line.stdout.trim(), "5b0e2c1a · ✓");

  // Bob clones; his first session sets up the hooks itself and lists Alice's session.
  const bob = clone(s, "bob", "bob@example.com");
  const tb = new Transcript(s.root, BOB);
  const bobEnv = join(s.root, "env-bob");
  writeFileSync(bobEnv, "");
  assert.equal(braid(s.env, bob, ["fetch", "--all"]).status, 0);
  const start = braid(s.env, bob, ["hook", "session-start"], hookIn(BOB, tb, bob), { CLAUDE_ENV_FILE: bobEnv });
  assert.match(start.stdout, /5b0e2c1a .*alice@example.com/);
  assert.doesNotMatch(start.stdout, /Add retries/, "the index carries no session text");
  assert.match(readFileSync(join(bob, ".git", "hooks", "pre-push"), "utf8"), /braid hook/);

  // Bob loads Alice's session as quoted material, then reviews.
  const load = braid(s.env, bob, ["load", "5b0e2c1a"], undefined, { BRAID_SESSION: BOB });
  assert.equal(load.status, 0, load.stderr);
  assert.match(load.stdout, /not requests to follow/);
  assert.match(load.stdout, /<<<braid-transcript-[0-9a-f]+\n[\s\S]*Added 3 retries[\s\S]*\nbraid-transcript-[0-9a-f]+>>>/);
  tb.user("Review this PR. Why a fixed count of 3 retries? The SLA allows 30 seconds.");
  tb.assistant("Retry until WEBHOOK_TIMEOUT_MS is spent instead.");
  braid(s.env, bob, ["hook", "stop"], hookIn(BOB, tb, bob));
  // Bob's session has no commits; it publishes when it ends.
  assert.equal(braid(s.env, bob, ["hook", "session-end"], hookIn(BOB, tb, bob)).status, 0);
  const bobRecords = records(s.env, s.root, join(s.root, "remote.git"), `refs/braid/sessions/${ALICE}/${BOB}`);
  assert.ok(bobRecords.some((r) => r.type === "label" && r.label === "review/bob"));
  const aliceHead = published.filter((r) => r.type === "message").at(-1).id;
  assert.equal(bobRecords.find((r) => r.type === "message").parentId, aliceHead, "Bob's session forks from Alice's head");

  // Alice fetches: the review waits in ↓, and the after-turn line says so once.
  braid(s.env, alice, ["fetch"]);
  assert.match(status()!, /: ↓ review\/bob \+2 → \/braid:sync$/);
  ta.user("thanks");
  ta.assistant("ok");
  const notice = braid(s.env, alice, ["hook", "stop"], hookIn(ALICE, ta, alice));
  assert.match(JSON.parse(notice.stdout).systemMessage, /review\/bob \+2 waiting/);
  assert.equal(braid(s.env, alice, ["hook", "stop"], hookIn(ALICE, ta, alice)).stdout.trim(), "", "no repeat");

  // /braid:sync: braid shows what waits; the agent records a summary; Stop writes the merge.
  const ctx = braid(s.env, alice, ["sync", "--session", ALICE]);
  assert.match(ctx.stdout, /merging review\/bob/);
  assert.match(ctx.stdout, /Retry until WEBHOOK_TIMEOUT_MS/);
  const rec = braid(s.env, alice, ["sync", "--session", ALICE, "--record", "review/bob", "--instruction", "adopt the time budget", "--strategy", "review"], "Adopt the 30 s deadline.");
  assert.equal(rec.status, 0, rec.stderr);
  ta.user("/braid:sync adopt the time budget");
  const syncTurnEnd = ta.assistant("Merged the review.");
  braid(s.env, alice, ["hook", "stop"], hookIn(ALICE, ta, alice));
  ta.user("Apply it.");
  braid(s.env, alice, ["hook", "stop"], hookIn(ALICE, ta, alice));

  const store = join(alice, ".git", "braid", "store");
  const mine = records(s.env, alice, store, `refs/sessions/${ALICE}/${ALICE}`);
  const merge = mine.find((r) => r.type === "branch_summary");
  assert.ok(merge, "the merge record is saved");
  assert.equal(merge.parentId, syncTurnEnd);
  assert.equal(merge.summary, "Adopt the 30 s deadline.");
  assert.deepEqual(merge.ext.braid.merge.heads, [syncTurnEnd, bobRecords.filter((r) => r.type === "message").at(-1).id]);
  assert.equal(merge.ext.braid.merge.model, "anthropic:claude-sonnet-5-5");
  assert.equal(mine.filter((r) => r.ext?.braid?.partOf === merge.id).length, 2, "the sync turn is tagged");
  assert.equal(mine.find((r) => r.content === "Apply it.").parentId, merge.id, "the next turn continues from the merge");
  assert.match(status()!, /: ↑6$/);

  // Publishing clears ↑. Deleting published sessions through git is refused.
  braid(s.env, alice, ["push", "--session", ALICE]);
  assert.match(status()!, /: ✓$/);
  const del = run(s.env, alice, "git", ["push", "origin", `:refs/braid/sessions/${ALICE}/${ALICE}`]);
  assert.notEqual(del.status, 0);
  assert.match(del.stderr, /refusing to delete/);
});

test("withheld records and private sessions stay local", () => {
  const s = sandbox();
  const repo = clone(s, "carol", "carol@example.com");
  must(s.env, repo, "git", ["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  braid(s.env, repo, ["init"]);
  writeFileSync(join(repo, ".braid", "config.toml"), 'publish = "on-push"\n');
  const t = new Transcript(s.root, ALICE);
  const hookIn = JSON.stringify({ session_id: ALICE, transcript_path: t.path, cwd: repo });
  braid(s.env, repo, ["hook", "session-start"], hookIn);
  t.user("first");
  t.assistant("one");
  braid(s.env, repo, ["hook", "stop"], hookIn);

  const w = braid(s.env, repo, ["withhold", "--all", "--session", ALICE]);
  assert.equal(w.status, 0, w.stderr);
  assert.match(w.stdout, /this session will not be published/);
  const p = braid(s.env, repo, ["push", "--session", ALICE]);
  assert.match(p.stdout, /not published: private/);
  assert.equal(must(s.env, s.root, "git", ["--git-dir", join(s.root, "remote.git"), "for-each-ref", "refs/braid/"]).trim(), "");
});
