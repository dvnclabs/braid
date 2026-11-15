// End to end: two people, one remote. Alice works and pushes, Bob reviews,
// Alice merges the review. Every step goes through the CLI and real git.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { braid, clone, must, Rollout, run, sandbox, storeOf, Transcript } from "./helpers.ts";

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

  // braid init: config, store, hooks. No gh here, so git push does not publish; turn it on.
  const init = braid(s.env, alice, ["init", "--no-autopilot"]);
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /autocommit = false, autopush = false: visibility unknown/);
  writeFileSync(join(alice, ".braid", "config.toml"), 'autopilot = false\nautopush = true\nremote = "origin"\n');
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

  // The agent commits: the trailer links the commit. The conversation is not committed with it.
  writeFileSync(join(alice, "send.ts"), "export const retries = 3;\n");
  must(s.env, alice, "git", ["add", "."]);
  must({ ...s.env, BRAID_SESSION: ALICE }, alice, "git", ["commit", "--quiet", "-m", "Retry webhooks"]);
  assert.match(must(s.env, alice, "git", ["log", "-1", "--format=%B"]), new RegExp(`Braid-Session: ${ALICE}`));
  assert.match(status()!, /: local$/);

  // Alice reviews what would go out, then commits the conversation: the session shows ↑.
  const listing = braid(s.env, alice, ["edit", "--session", ALICE]);
  assert.equal(listing.status, 0, listing.stderr);
  assert.match(listing.stdout, /3 records, nothing committed yet, 0 withheld, 1 redacted/);
  assert.match(listing.stdout, /\n 1 +you +Add retries to sendWebhook\. My key is \[REDACTED:aws-access-key\]\.\n 2 +agent +Added 3 retries[^\n]*\n 3 +code +Retry webhooks \([0-9a-f]{7}\)\n/);
  const committed = braid(s.env, alice, ["commit", "-m", "Retry webhooks", "--session", ALICE]);
  assert.match(committed.stdout, /committed 5b0e2c1a: Retry webhooks \(2 records, 1 redacted\); the next git push/);
  assert.match(status()!, /: ↑2$/);

  // git push publishes the session, redacted, without native lines or reasoning.
  const push = run(s.env, alice, "git", ["push", "origin", "HEAD:main"]);
  assert.equal(push.status, 0, push.stderr);
  assert.match(push.stderr, /braid: published 5b0e2c1a, 2 records, 1 redacted/);
  const published = records(s.env, s.root, join(s.root, "remote.git"), `refs/braid/sessions/${ALICE}/${ALICE}`);
  const text = JSON.stringify(published);
  assert.doesNotMatch(text, /AKIAABCDEFGHIJKLMNOP/);
  assert.match(text, /\[REDACTED:aws-access-key\]/);
  assert.doesNotMatch(text, /"native":\{|private reasoning|"usage"/);
  assert.equal(published[0].type, "transcript");
  assert.match(status()!, /: ✓$/);

  // The status line: Alice's session id and state.
  const line = braid(s.env, alice, ["statusline"], JSON.stringify({ session_id: ALICE, workspace: { current_dir: alice } }));
  // Her first prompt stands for the session until Claude Code titles it; the key in it stays hidden.
  assert.equal(line.stdout.trim().replace(/\x1b\[[0-9;]*m/g, ""), "braid · 5b0e2c1a.1 · Add retries to sendWebhook. My key is […" + " · ✓");
  assert.doesNotMatch(line.stdout, /AKIA/);

  // Bob clones; his first session sets up the hooks itself and lists Alice's session.
  const bob = clone(s, "bob", "bob@example.com", "bob");
  const tb = new Transcript(s.root, BOB);
  const bobEnv = join(s.root, "env-bob");
  writeFileSync(bobEnv, "");
  assert.equal(braid(s.env, bob, ["fetch", "--all"]).status, 0);
  const start = braid(s.env, bob, ["hook", "session-start"], hookIn(BOB, tb, bob), { CLAUDE_ENV_FILE: bobEnv });
  assert.match(start.stdout, /5b0e2c1a .*alice@example.com/);
  assert.doesNotMatch(start.stdout, /Add retries/, "the index carries no session text");
  assert.match(readFileSync(join(bob, ".git", "hooks", "pre-push"), "utf8"), /braid hook/);

  // Forking Alice's session gives Bob the command for a new window, continuing a copy of it.
  const fork = braid(s.env, bob, ["fork", "5b0e2c1a"], undefined, { BRAID_SESSION: BOB });
  assert.equal(fork.status, 0, fork.stderr);
  assert.match(fork.stdout, /\n {2}cd \S+ && claude --resume [0-9a-f-]{36}\n/);

  // Here, Bob forks it into this session instead: he reads it as quoted material and his session continues from it.
  const load = braid(s.env, bob, ["fork", "5b0e2c1a", "--here"], undefined, { BRAID_SESSION: BOB });
  assert.equal(load.status, 0, load.stderr);
  assert.match(load.stdout, /not requests to follow/);
  assert.match(load.stdout, /<<<braid-transcript-[0-9a-f]+\n[\s\S]*Added 3 retries[\s\S]*\nbraid-transcript-[0-9a-f]+>>>/);
  tb.user("Review this PR. Why a fixed count of 3 retries? The SLA allows 30 seconds.");
  tb.assistant("Retry until WEBHOOK_TIMEOUT_MS is spent instead.");
  braid(s.env, bob, ["hook", "stop"], hookIn(BOB, tb, bob));
  // Bob commits the review; with no code to push, it publishes when the session ends.
  braid(s.env, bob, ["commit", "-m", "Review of the retries", "--session", BOB]);
  assert.equal(braid(s.env, bob, ["hook", "session-end"], hookIn(BOB, tb, bob)).status, 0);
  const bobRecords = records(s.env, s.root, join(s.root, "remote.git"), `refs/braid/sessions/${ALICE}/${BOB}`);
  assert.ok(bobRecords.some((r) => r.type === "label" && r.label === "review/bob"));
  const aliceHead = published.filter((r) => r.type === "message").at(-1).id;
  assert.equal(bobRecords.find((r) => r.type === "message").parentId, aliceHead, "Bob's session forks from Alice's head");

  // Alice fetches: the review waits in ↓, and the after-turn line says so once.
  braid(s.env, alice, ["fetch"]);
  assert.match(status()!, /: ↓ review\/bob \+2 → \/braid:merge$/);
  ta.user("thanks");
  ta.assistant("ok");
  const notice = braid(s.env, alice, ["hook", "stop"], hookIn(ALICE, ta, alice));
  assert.match(JSON.parse(notice.stdout).systemMessage, /review\/bob \+2 waiting/);
  assert.equal(braid(s.env, alice, ["hook", "stop"], hookIn(ALICE, ta, alice)).stdout.trim(), "", "no repeat");

  // /braid:merge: braid shows what waits; the agent records a summary; Stop writes the merge.
  const ctx = braid(s.env, alice, ["merge", "--session", ALICE]);
  assert.match(ctx.stdout, /merging review\/bob/);
  assert.match(ctx.stdout, /Retry until WEBHOOK_TIMEOUT_MS/);
  const rec = braid(s.env, alice, ["merge", "--session", ALICE, "--record", "review/bob", "--instruction", "adopt the time budget", "--strategy", "review"], "Adopt the 30 s deadline.");
  assert.equal(rec.status, 0, rec.stderr);
  ta.user("/braid:merge adopt the time budget");
  const syncTurnEnd = ta.assistant("Merged the review.");
  braid(s.env, alice, ["hook", "stop"], hookIn(ALICE, ta, alice));
  ta.user("Apply it.");
  braid(s.env, alice, ["hook", "stop"], hookIn(ALICE, ta, alice));

  const store = storeOf(s.env, alice);
  const mine = records(s.env, alice, store, `refs/sessions/${ALICE}/${ALICE}`);
  const merge = mine.find((r) => r.type === "branch_summary");
  assert.ok(merge, "the merge record is saved");
  assert.equal(merge.parentId, syncTurnEnd);
  assert.equal(merge.summary, "Adopt the 30 s deadline.");
  assert.deepEqual(merge.ext.braid.merge.heads, [syncTurnEnd, bobRecords.filter((r) => r.type === "message").at(-1).id]);
  assert.equal(merge.ext.braid.merge.model, "anthropic:claude-sonnet-5-5");
  assert.equal(mine.filter((r) => r.ext?.braid?.partOf === merge.id).length, 2, "the sync turn is tagged");
  assert.equal(mine.find((r) => r.content === "Apply it.").parentId, merge.id, "the next turn continues from the merge");
  const codeLabel = mine.find((r) => r.type === "label" && r.ext?.braid?.code);
  assert.equal(codeLabel?.label, "Retry webhooks", "the agent's git commit is noted in the conversation");
  const log = braid(s.env, alice, ["log", ALICE]).stdout;
  assert.match(log, /code +Retry webhooks \([0-9a-f]{7}\)/);
  assert.match(log, /commit +Retry webhooks\n/);
  assert.match(status()!, /: \*6$/, "the turns since the commit are not committed");
  assert.match(braid(s.env, alice, ["push", "--session", ALICE]).stdout, /up to date/);

  // Committing and publishing clears it. Deleting published sessions through git is refused.
  braid(s.env, alice, ["commit", "-m", "Adopt the deadline", "--session", ALICE]);
  assert.match(status()!, /: ↑6$/);
  braid(s.env, alice, ["push", "--session", ALICE]);
  assert.match(status()!, /: ✓$/);
  const del = run(s.env, alice, "git", ["push", "origin", `:refs/braid/sessions/${ALICE}/${ALICE}`]);
  assert.notEqual(del.status, 0);
  assert.match(del.stderr, /refusing to delete/);
});

test("braid edit withholds and hides parts of a session, also after they are published", () => {
  const s = sandbox();
  const repo = clone(s, "carol", "carol@example.com");
  must(s.env, repo, "git", ["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  braid(s.env, repo, ["init", "--no-autopilot", "--autopush"]);
  const t = new Transcript(s.root, ALICE);
  const hookIn = JSON.stringify({ session_id: ALICE, transcript_path: t.path, cwd: repo });
  braid(s.env, repo, ["hook", "session-start"], hookIn);
  t.user("Fix the Acme Corp import.");
  t.toolCall("Read", { file_path: "notes.txt" }, "toolu_n1", "login: carol / hunter2");
  t.assistant("Fixed the import.");
  braid(s.env, repo, ["hook", "stop"], hookIn);

  const list = braid(s.env, repo, ["edit", "--session", ALICE]).stdout;
  assert.match(list, /\n 1 +you +Fix the Acme Corp import\.\n 2 +agent +→ Read notes\.txt\n 3 +tool +login: carol \/ hunter2\n 4 +agent +Fixed the import\.\n/);
  braid(s.env, repo, ["commit", "-m", "Import fix", "--session", ALICE]);
  assert.match(braid(s.env, repo, ["push", "--session", ALICE]).stdout, /published 5b0e2c1a, 4 records/);
  const remote = join(s.root, "remote.git");
  const ref = `refs/braid/sessions/${ALICE}/${ALICE}`;
  assert.match(JSON.stringify(records(s.env, s.root, remote, ref)), /hunter2/);

  // Edits name the session: outside an agent session, braid edit only reads.
  assert.match(braid(s.env, repo, ["edit", "2"]).stderr, /name the session to edit/);

  // Withholding the call takes its result along; the text is hidden everywhere. Both were published.
  const w = braid(s.env, repo, ["edit", "2", "--session", ALICE]);
  assert.equal(w.status, 0, w.stderr);
  assert.match(w.stdout, /2 records withheld:\n +2 agent +→ Read notes\.txt\n +3 tool +login/);
  assert.match(w.stdout, /2 of them are already published: the next push replaces the published copy/);
  assert.match(braid(s.env, repo, ["edit", "--hide", "acme corp", "--session", ALICE]).stdout, /"acme corp" hidden in 1 records/);
  const after = braid(s.env, repo, ["edit", "--session", ALICE]).stdout;
  assert.match(after, /Hidden text: "acme corp"/);
  assert.match(after, /\n 2 ✗ agent +→ Read notes\.txt {2}\[withheld\]\n/);
  assert.match(after, /\n 1 +you +Fix the \[REDACTED:term\] import\.\n/);

  // A record's text can be rewritten: from stdin here, in an editor on a terminal. A tool call has no text to rewrite.
  const edited = braid(s.env, repo, ["edit", "--rewrite", "4", "--session", ALICE], "Fixed the import for the client.\n");
  assert.match(edited.stdout, /4 rewritten; it is already published/, edited.stderr);
  assert.match(braid(s.env, repo, ["edit", "--rewrite", "2", "--session", ALICE], "x").stderr, /2 is a tool call/);
  assert.match(braid(s.env, repo, ["edit", "--session", ALICE]).stdout, /\n 4 ✎ agent +Fixed the import for the client\.\n/);

  // The next push replaces the published copy, without the history that held the old one.
  const push = braid(s.env, repo, ["push", "--session", ALICE]).stdout;
  assert.match(push, /replaced 4 records published before/);
  const text = JSON.stringify(records(s.env, s.root, remote, ref));
  assert.doesNotMatch(text, /hunter2|Acme Corp|notes\.txt/);
  assert.match(text, /Fixed the import for the client\./);
  assert.equal(must(s.env, s.root, "git", ["--git-dir", remote, "rev-list", "--count", ref]).trim(), "1");

  // Putting back the result puts back its call too.
  assert.match(braid(s.env, repo, ["edit", "--undo", "3", "--session", ALICE]).stdout, /2 records put back/);
  assert.doesNotMatch(braid(s.env, repo, ["edit", "--session", ALICE]).stdout, /\n *\d+ ✗/);

  // --last withholds by time, and --undo --last puts the same records back.
  assert.match(braid(s.env, repo, ["edit", "--last", "3650d", "--session", ALICE]).stdout, /\d+ records withheld/);
  const back = braid(s.env, repo, ["edit", "--undo", "--last", "3650d", "--session", ALICE]).stdout;
  assert.match(back, /\d+ records put back/);
  assert.doesNotMatch(braid(s.env, repo, ["edit", "--session", ALICE]).stdout, /\n *\d+ ✗/);

  // --all keeps the whole session back.
  assert.match(braid(s.env, repo, ["edit", "--all", "--session", ALICE]).stdout, /will not be published/);
  assert.match(braid(s.env, repo, ["push", "--session", ALICE]).stdout, /not published: private/);
  braid(s.env, repo, ["edit", "--undo", "--all", "--session", ALICE]);
  assert.match(braid(s.env, repo, ["push", "--session", ALICE]).stdout, /published 5b0e2c1a/);
});

test("commit, branch, and merge the branch back", () => {
  const s = sandbox();
  const repo = clone(s, "dana", "dana@example.com");
  must(s.env, repo, "git", ["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  braid(s.env, repo, ["init", "--no-autopilot"]);
  const t = new Transcript(s.root, ALICE);
  const hookIn = (session: string, tr: Transcript) => JSON.stringify({ session_id: session, transcript_path: tr.path, cwd: repo });
  braid(s.env, repo, ["hook", "session-start"], hookIn(ALICE, t));
  t.user("Plan the cache.");
  const lru = t.assistant("Use an LRU.");
  braid(s.env, repo, ["hook", "stop"], hookIn(ALICE, t));
  const status = (session: string) => braid(s.env, repo, ["status", "--session", session]).stdout.split("\n")[0];
  assert.match(status(ALICE)!, /: local$/);

  // braid commit commits the conversation without any code.
  const c = braid(s.env, repo, ["commit", "-m", "cache plan", "--session", ALICE]);
  assert.equal(c.status, 0, c.stderr);
  assert.match(status(ALICE)!, /: ↑2$/);
  assert.match(braid(s.env, repo, ["log", ALICE]).stdout, /commit\s+cache plan/);

  // Claude Code's /branch copies the transcript under a new id; braid files the copy as a branch of the same conversation.
  const BRANCH = "7c1d2e3f-0000-4000-8000-0000000000aa";
  const tb = t.fork(s.root, BRANCH);
  tb.user("Try a TTL cache instead.");
  const ttl = tb.assistant("A TTL of 60 s fits.");
  braid(s.env, repo, ["hook", "stop"], hookIn(BRANCH, tb));
  const store = storeOf(s.env, repo);
  const branch = records(s.env, repo, store, `refs/sessions/${ALICE}/${BRANCH}`).filter((r) => r.type === "message");
  assert.deepEqual(branch.map((r) => r.id).at(-1), ttl);
  assert.equal(branch.length, 2, "the copied records are not saved twice");
  assert.equal(branch[0].parentId, lru, "the branch continues from where it was made");

  // braid fork prints how to branch in a new window; your own session forks with Claude Code itself.
  assert.match(braid(s.env, repo, ["fork", "--session", ALICE]).stdout, new RegExp(`\\n  cd /work && claude --resume ${ALICE} --fork-session\\n`));
  assert.match(braid(s.env, repo, ["fork", "7c1d2e3f", "--session", ALICE]).stdout, new RegExp(`\\n  cd /work && claude --resume ${BRANCH} --fork-session`));

  // Back in the first session, the branch waits in ↓ and merges like a review.
  assert.match(status(ALICE)!, /↓ 7c1d2e3f \+2 → \/braid:merge$/);
  assert.match(braid(s.env, repo, ["merge", "--session", ALICE]).stdout, /TTL of 60 s/);
  const rec = braid(s.env, repo, ["merge", "--session", ALICE, "--record", "7c1d2e3f", "--instruction", "keep the LRU"], "Keep the LRU; the TTL idea is noted.");
  assert.equal(rec.status, 0, rec.stderr);
  t.user("/braid:merge keep the LRU");
  t.assistant("Kept the LRU.");
  braid(s.env, repo, ["hook", "stop"], hookIn(ALICE, t));
  assert.doesNotMatch(status(ALICE)!, /↓/);
  const merge = records(s.env, repo, store, `refs/sessions/${ALICE}/${ALICE}`).find((r) => r.type === "branch_summary");
  assert.equal(merge.ext.braid.merge.heads[1], ttl);
});

test("with git-hooks off, braid leaves git alone", () => {
  const s = sandbox();
  const repo = clone(s, "erin", "erin@example.com");
  must(s.env, repo, "git", ["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  assert.equal(braid(s.env, repo, ["init", "--no-autopilot", "--no-git-hooks"]).status, 0);
  assert.match(readFileSync(join(repo, ".braid", "config.toml"), "utf8"), /^git-hooks = false$/m);
  const t = new Transcript(s.root, ALICE);
  const hookIn = JSON.stringify({ session_id: ALICE, transcript_path: t.path, cwd: repo });
  braid(s.env, repo, ["hook", "session-start"], hookIn);
  assert.equal(existsSync(join(repo, ".git", "hooks", "pre-push")), false);
  t.user("hi");
  t.assistant("hello");
  braid(s.env, repo, ["hook", "stop"], hookIn);

  // Turned on later, the hooks link the agent's commits again.
  braid(s.env, repo, ["init", "--no-autopilot", "--git-hooks"]);
  assert.match(readFileSync(join(repo, ".git", "hooks", "pre-push"), "utf8"), /braid hook/);
  must({ ...s.env, BRAID_SESSION: ALICE }, repo, "git", ["commit", "--quiet", "--allow-empty", "-m", "linked"]);
  assert.match(must(s.env, repo, "git", ["log", "-1", "--format=%B"]), new RegExp(`Braid-Session: ${ALICE}`));
  braid(s.env, repo, ["init", "--no-autopilot", "--no-git-hooks"]);
  assert.equal(existsSync(join(repo, ".git", "hooks", "pre-push")), false);
});

test("subagents are saved, published and briefed with their session", () => {
  const s = sandbox();
  const repo = clone(s, "fay", "fay@example.com");
  must(s.env, repo, "git", ["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  braid(s.env, repo, ["init", "--no-autopilot", "--autopush"]);
  const t = new Transcript(s.root, ALICE);
  const hookIn = JSON.stringify({ session_id: ALICE, transcript_path: t.path, cwd: repo });
  braid(s.env, repo, ["hook", "session-start"], hookIn);
  t.user("Audit the webhook code.");
  t.toolCall("Agent", { description: "Find webhook callers", prompt: "List callers" }, "toolu_agent1", "Three callers, see report.");

  // Claude Code writes the subagent next to the transcript, with a meta file naming the tool call.
  const dir = join(s.root, ALICE, "subagents");
  mkdirSync(dir, { recursive: true });
  const sub = new Transcript(dir, "agent-a36fc26663a698234");
  sub.add("user", { role: "user", content: "List callers" }, { isSidechain: true, agentId: "a36fc26663a698234" });
  sub.add("assistant", { id: "m1", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: "Callers: billing, alerts, sync. Token ghp_" + "a".repeat(36) }] }, { isSidechain: true, agentId: "a36fc26663a698234" });
  writeFileSync(join(dir, "agent-a36fc26663a698234.meta.json"), JSON.stringify({ agentType: "Explore", description: "Find webhook callers", toolUseId: "toolu_agent1" }));
  braid(s.env, repo, ["hook", "stop"], hookIn);

  const store = storeOf(s.env, repo);
  const ref = `refs/sessions/${ALICE}/${ALICE}`;
  const mine = records(s.env, repo, store, ref);
  const link = mine.find((r) => r.type === "agent_link");
  assert.equal(link?.transcriptId, "a36fc26663a698234");
  assert.equal(link.toolCallId, "toolu_agent1");
  assert.equal(mine.find((r) => r.id === link.parentId)?.content?.[0]?.type, "tool_call", "linked from the call that spawned it");
  assert.match(must(s.env, repo, "git", ["--git-dir", store, "ls-tree", "-r", "--name-only", ref]), /agents\/a36fc26663a698234\/000001\.jsonl/);
  assert.match(braid(s.env, repo, ["sessions"]).stdout, /↳ a36fc266 {2}Explore: Find webhook callers {2}2 records/);

  // A later save adds only what the subagent wrote since.
  sub.add("assistant", { id: "m2", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: "Also: retries." }] }, { isSidechain: true, agentId: "a36fc26663a698234" });
  braid(s.env, repo, ["hook", "stop"], hookIn);
  const agentFiles = must(s.env, repo, "git", ["--git-dir", store, "ls-tree", "-r", "--name-only", ref, "agents/"]).trim().split("\n");
  assert.equal(agentFiles.length, 2);
  assert.equal(records(s.env, repo, store, ref).filter((r) => r.type === "agent_link").length, 1, "linked once");

  // Listed under the call that spawned it, and published with the session, redacted.
  assert.match(braid(s.env, repo, ["edit", "--session", ALICE]).stdout, /\n +4 +spawn +→ subagent a36fc26663a698234 \(Explore\): Find webhook callers\n4\.1 +prompt +List callers\n/);
  must(s.env, repo, "git", ["push", "--quiet", "origin", "HEAD:main"]);
  braid(s.env, repo, ["commit", "-m", "Audit", "--session", ALICE]);
  assert.match(braid(s.env, repo, ["push", "--session", ALICE]).stdout, /published 5b0e2c1a/);
  const remote = join(s.root, "remote.git");
  const published = `refs/braid/sessions/${ALICE}/${ALICE}`;
  const shown = must(s.env, s.root, "git", ["--git-dir", remote, "show", `${published}:agents/a36fc26663a698234/000001.jsonl`]);
  assert.match(shown, /Callers: billing/);
  assert.match(shown, /\[REDACTED:github-token\]/);

  // A briefing carries the subagent's answer.
  assert.match(braid(s.env, repo, ["show", "5b0e2c1a"]).stdout, /subagent a36fc266 · assistant\] Also: retries\./);
  // Saved as it happened, subagents too, and loads back the same.
  const v = braid(s.env, repo, ["verify", "--all"]);
  assert.equal(v.status, 0, v.stdout);
  assert.match(v.stdout, /✓ saved: 1 subagents/);

  // What subagents write after the last save, in a file the save read or in a new one, waits for the next save.
  sub.add("assistant", { id: "m3", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: "And timeouts." }] }, { isSidechain: true, agentId: "a36fc26663a698234" });
  new Transcript(dir, "agent-b47fc26663a698235").add("user", { role: "user", content: "Check retries" }, { isSidechain: true, agentId: "b47fc26663a698235" });
  const later = braid(s.env, repo, ["verify", "--session", ALICE]);
  assert.equal(later.status, 0, later.stdout);
  assert.match(later.stdout, /· 2 records written since the last save, which the next save takes in/);
});

test("a session publishes to each repository it commits in", () => {
  const s = sandbox();
  const bare = (name: string) => must(s.env, s.root, "git", ["init", "--quiet", "--bare", "--initial-branch=main", `${name}.git`]);
  const setUp = (dir: string, remote: string) => {
    must(s.env, s.root, "git", ["clone", "--quiet", join(s.root, `${remote}.git`), dir]);
    must(s.env, dir, "git", ["config", "user.email", "gus@example.com"]);
    must(s.env, dir, "git", ["commit", "--quiet", "--allow-empty", "-m", "initial"]);
    braid(s.env, dir, ["init", "--no-autopilot"]);
    writeFileSync(join(dir, ".braid", "config.toml"), "autopilot = false\nautopush = true\nautocommit = true\n");
    must(s.env, dir, "git", ["add", ".braid"]);
    must(s.env, dir, "git", ["commit", "--quiet", "-m", "Set up braid"]);
    must(s.env, dir, "git", ["push", "--quiet", "origin", "HEAD:main"]);
  };
  bare("b");
  bare("c");
  const a = clone(s, "a", "gus@example.com");
  must(s.env, a, "git", ["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  braid(s.env, a, ["init", "--no-autopilot"]);
  writeFileSync(join(a, ".braid", "config.toml"), "autopilot = false\nautopush = true\nautocommit = true\n");
  const b = join(a, "services", "api"); // a repository nested in A
  setUp(b, "b");
  const c = join(s.root, "c");
  setUp(c, "c");
  const cWork = join(s.root, "c-feature");
  must(s.env, c, "git", ["worktree", "add", "--quiet", "-b", "feature", cWork]);

  // The session starts in A, then commits in B and in C's worktree.
  const t = new Transcript(s.root, ALICE);
  const hookIn = JSON.stringify({ session_id: ALICE, transcript_path: t.path, cwd: a });
  braid(s.env, a, ["hook", "session-start"], hookIn);
  t.user("Add the endpoint in the API and the client.");
  t.assistant("Done in both.");
  const agent = { ...s.env, BRAID_SESSION: ALICE };
  for (const dir of [b, cWork]) {
    writeFileSync(join(dir, "change.ts"), "export {};\n");
    must(agent, dir, "git", ["add", "change.ts"]);
    must(agent, dir, "git", ["commit", "--quiet", "-m", "Add endpoint"]);
    assert.match(must(s.env, dir, "git", ["log", "-1", "--format=%B"]), new RegExp(`Braid-Session: ${ALICE}`));
  }

  // With autocommit, each commit commits the conversation; pushing B and C publishes it to each.
  braid(s.env, a, ["hook", "stop"], hookIn);
  must(s.env, b, "git", ["push", "--quiet", "origin", "HEAD:main"]);
  must(s.env, cWork, "git", ["push", "--quiet", "origin", "feature"]);
  const published = (remote: string) =>
    must(s.env, s.root, "git", ["--git-dir", join(s.root, `${remote}.git`), "for-each-ref", "--format=%(refname)", "refs/braid/"]).trim();
  assert.equal(published("b"), `refs/braid/sessions/${ALICE}/${ALICE}`);
  assert.equal(published("c"), `refs/braid/sessions/${ALICE}/${ALICE}`);
  assert.match(must(s.env, s.root, "git", ["--git-dir", join(s.root, "b.git"), "show", `refs/braid/sessions/${ALICE}/${ALICE}:records/000001.jsonl`]), /Done in both/);

  // The conversation names each commit by its message, from the repository it was made in.
  assert.equal([...braid(s.env, a, ["log", ALICE]).stdout.matchAll(/commit +Add endpoint \([0-9a-f]{7}\)/g)].length, 2);

  // A has no commit from the session, so pushing A publishes nothing.
  must(s.env, a, "git", ["push", "--quiet", "origin", "HEAD:main"]);
  assert.equal(published("remote"), "");
});

test("with link = store, commits carry no trailer and still lead to their sessions", () => {
  const s = sandbox();
  const alice = clone(s, "alice", "alice@example.com");
  must(s.env, alice, "git", ["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  braid(s.env, alice, ["init", "--no-autopilot"]);
  writeFileSync(join(alice, ".braid", "config.toml"), 'autopilot = false\nautopush = true\nlink = "store"\n');
  must(s.env, alice, "git", ["add", ".braid"]);
  must(s.env, alice, "git", ["commit", "--quiet", "-m", "Set up braid"]);
  must(s.env, alice, "git", ["push", "--quiet", "origin", "HEAD:main"]);

  const t = new Transcript(s.root, ALICE);
  const hookIn = JSON.stringify({ session_id: ALICE, transcript_path: t.path, cwd: alice });
  braid(s.env, alice, ["hook", "session-start"], hookIn);
  t.user("Add retries.");
  t.assistant("Added.");
  braid(s.env, alice, ["hook", "stop"], hookIn);
  must(s.env, alice, "git", ["checkout", "--quiet", "-b", "retries"]);
  writeFileSync(join(alice, "send.ts"), "export const retries = 3;\n");
  must(s.env, alice, "git", ["add", "send.ts"]);
  const agent = { ...s.env, BRAID_SESSION: ALICE };
  must(agent, alice, "git", ["commit", "--quiet", "-m", "Retry webhooks"]);
  assert.doesNotMatch(must(s.env, alice, "git", ["log", "-1", "--format=%B"]), /Braid-Session/);

  // An amend keeps the link: post-rewrite carries it to the new commit.
  const before = must(s.env, alice, "git", ["rev-parse", "HEAD"]).trim();
  must(agent, alice, "git", ["commit", "--quiet", "--amend", "-m", "Retry webhook deliveries"]);
  const commit = must(s.env, alice, "git", ["rev-parse", "HEAD"]).trim();
  assert.notEqual(commit, before);

  // git push publishes the committed session, found through the commit, not a trailer.
  braid(s.env, alice, ["commit", "-m", "Retries", "--session", ALICE]);
  const push = run(s.env, alice, "git", ["push", "origin", "retries"]);
  assert.match(push.stderr, /braid: published 5b0e2c1a/);
  const published = records(s.env, s.root, join(s.root, "remote.git"), `refs/braid/sessions/${ALICE}/${ALICE}`);
  assert.deepEqual(
    published.filter((r) => r.ext?.braid?.code).map((r) => r.ext.braid.code.sha).sort(),
    [before, commit].sort(),
  );

  // A teammate on the branch sees the session in the index.
  const bob = clone(s, "bob", "bob@example.com", "bob");
  must(s.env, bob, "git", ["checkout", "--quiet", "retries"]);
  braid(s.env, bob, ["fetch"]);
  const tb = new Transcript(s.root, BOB);
  const start = braid(s.env, bob, ["hook", "session-start"], JSON.stringify({ session_id: BOB, transcript_path: tb.path, cwd: bob }));
  assert.match(start.stdout, /5b0e2c1a .*alice@example.com/);

  // After a squash merge, pr:N still finds the session through the pull request's own commits.
  must(s.env, bob, "git", ["checkout", "--quiet", "main"]);
  must(s.env, bob, "git", ["merge", "--quiet", "--squash", "retries"]);
  must(s.env, bob, "git", ["commit", "--quiet", "-m", "Retry webhook deliveries (#7)"]);
  writeFileSync(join(s.root, "bin", "gh"), `#!/bin/sh\necho '${JSON.stringify({ commits: [{ oid: commit, messageBody: "" }] })}'\n`);
  chmodSync(join(s.root, "bin", "gh"), 0o755);
  const shown = braid(s.env, bob, ["show", "pr:7"]);
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /session 5b0e2c1a/);
});

test("team rules withhold paths and redact terms, and a dry run shows it first", () => {
  const s = sandbox();
  const repo = clone(s, "hal", "hal@example.com");
  must(s.env, repo, "git", ["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  braid(s.env, repo, ["init", "--no-autopilot", "--autopush"]);
  writeFileSync(join(repo, ".braid", "redact.toml"), 'terms = ["Acme Corp"]\n');
  appendFileSync(join(repo, ".braidignore"), "customers/\n");
  must(s.env, repo, "git", ["add", ".braid", ".braidignore"]);
  must(s.env, repo, "git", ["commit", "--quiet", "-m", "Set up braid"]);
  must(s.env, repo, "git", ["push", "--quiet", "origin", "HEAD:main"]);
  must(s.env, repo, "git", ["fetch", "--quiet", "origin"]);

  // A feature branch cannot weaken the rules: redaction rules come from the
  // default branch, and its .braidignore applies whatever the branch's says.
  must(s.env, repo, "git", ["checkout", "--quiet", "-b", "feature"]);
  writeFileSync(join(repo, ".braid", "redact.toml"), "terms = []\n");
  appendFileSync(join(repo, ".braidignore"), "!customers/x.md\n");
  must(s.env, repo, "git", ["commit", "--quiet", "-am", "Drop the rules"]);

  const t = new Transcript(s.root, ALICE);
  const hookIn = JSON.stringify({ session_id: ALICE, transcript_path: t.path, cwd: repo });
  braid(s.env, repo, ["hook", "session-start"], hookIn);
  t.user("Summarize the Acme Corp contract.");
  t.toolCall("Read", { file_path: join(repo, "customers", "x.md") }, "toolu_read1", "Contract terms: pays 1M a year.");
  t.assistant("Acme Corp pays 1M a year.");
  braid(s.env, repo, ["hook", "stop"], hookIn);
  assert.match(braid(s.env, repo, ["push", "--dry-run", "--session", ALICE]).stdout, /would not publish: nothing committed yet/);

  braid(s.env, repo, ["commit", "-m", "Contract summary", "--session", ALICE]);
  const dry = braid(s.env, repo, ["push", "--dry-run", "--session", ALICE]);
  assert.match(dry.stdout, /would publish 2 records/);
  assert.match(dry.stdout, /redacted: term 2/);
  assert.match(dry.stdout, /withheld: customers\/ 1/);
  assert.match(dry.stdout, /rules: built in, \.braid\/redact\.toml on origin\/main, \.braidignore on origin\/main, \.braidignore\n/);
  const remote = join(s.root, "remote.git");
  assert.equal(must(s.env, s.root, "git", ["--git-dir", remote, "for-each-ref", "refs/braid/"]).trim(), "", "a dry run pushes nothing");

  assert.match(braid(s.env, repo, ["push", "--session", ALICE]).stdout, /published 5b0e2c1a/);
  const text = JSON.stringify(records(s.env, s.root, remote, `refs/braid/sessions/${ALICE}/${ALICE}`));
  assert.doesNotMatch(text, /Contract terms|Acme Corp|customers\/x\.md/);
  assert.match(text, /\[REDACTED:term\] pays 1M a year/);

  // Your own settings win: with autopush = false in ~/.config/braid/config.toml, git push publishes nothing.
  mkdirSync(join(s.env.XDG_CONFIG_HOME!, "braid"), { recursive: true });
  writeFileSync(join(s.env.XDG_CONFIG_HOME!, "braid", "config.toml"), "autopush = false\n");
  t.user("more");
  must({ ...s.env, BRAID_SESSION: ALICE }, repo, "git", ["commit", "--quiet", "--allow-empty", "-m", "More"]);
  braid(s.env, repo, ["commit", "-m", "More", "--session", ALICE]);
  const gitPush = run(s.env, repo, "git", ["push", "origin", "feature"]);
  assert.equal(gitPush.status, 0, gitPush.stderr);
  assert.doesNotMatch(gitPush.stderr, /braid: published/);
  assert.match(braid(s.env, repo, ["push", "--session", ALICE]).stdout, /published 5b0e2c1a/, "braid push still publishes");
});

test("a session moves to another machine, and two machines publish one session", () => {
  const s = sandbox();
  const machineB = () => ({ ...s.env, HOME: join(s.root, "home-b"), XDG_CONFIG_HOME: join(s.root, "home-b", ".config"), CLAUDE_CONFIG_DIR: join(s.root, "home-b", ".claude") });
  mkdirSync(join(s.root, "home-b"));
  const a = clone(s, "laptop", "alice@example.com");
  must(s.env, a, "git", ["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  braid(s.env, a, ["init", "--no-autopilot", "--autopush"]);
  must(s.env, a, "git", ["add", ".braid"]);
  must(s.env, a, "git", ["commit", "--quiet", "-m", "Set up braid"]);
  must(s.env, a, "git", ["push", "--quiet", "origin", "HEAD:main"]);

  // On the laptop: a turn that names a file by its absolute path, published.
  const t = new Transcript(s.root, ALICE);
  const hookIn = (session: string, path: string, cwd: string) => JSON.stringify({ session_id: session, transcript_path: path, cwd });
  braid(s.env, a, ["hook", "session-start"], hookIn(ALICE, t.path, a));
  t.user("Fix the parser.");
  t.toolCall("Read", { file_path: "/work/src/parser.ts" }, "toolu_p1", "export function parse() {}");
  const head = t.assistant("Fixed /work/src/parser.ts.");
  braid(s.env, a, ["hook", "stop"], hookIn(ALICE, t.path, a));
  braid(s.env, a, ["commit", "-m", "Parser fix", "--session", ALICE]);
  assert.match(braid(s.env, a, ["push", "--session", ALICE]).stdout, /published 5b0e2c1a/);

  // On the server, in a checkout at another path: fork it as a new session.
  const b = join(s.root, "server");
  const envB = machineB();
  must(envB, s.root, "git", ["clone", "--quiet", join(s.root, "remote.git"), b]);
  must(envB, b, "git", ["config", "user.email", "alice@example.com"]);
  braid(envB, b, ["fetch", "--all"]);
  const r = braid(envB, b, ["fork", "5b0e2c1a", "--cwd", b]);
  assert.equal(r.status, 0, r.stderr);
  const real = realpathSync(b);
  const newId = new RegExp(`\\n  cd ${real.replace(/[/.-]/g, "\\$&")} && claude --resume (\\S+)\\n`).exec(r.stdout)![1]!;
  const file = join(s.root, "home-b", ".claude", "projects", real.replace(/[^A-Za-z0-9]/g, "-"), `${newId}.jsonl`);
  assert.ok(existsSync(file), "where claude --resume looks");
  const native = readFileSync(file, "utf8");
  assert.match(native, new RegExp(`${real.replace(/[/.-]/g, "\\$&")}/src/parser\\.ts`));
  assert.doesNotMatch(native, /\/work\/src/);

  // Claude Code resumes it and adds a turn; the first save keeps only the new turn, continuing Alice's head.
  const last = JSON.parse(native.trim().split("\n").at(-1)!).uuid;
  appendFileSync(file, JSON.stringify({ parentUuid: last, type: "user", message: { role: "user", content: "Now add tests." }, uuid: "b0000000-0000-4000-8000-000000000001", timestamp: "2026-11-09T12:00:00.000Z", sessionId: newId, cwd: real }) + "\n");
  braid(envB, b, ["hook", "session-start"], hookIn(newId, file, b));
  braid(envB, b, ["hook", "stop"], hookIn(newId, file, b));
  const store = storeOf(envB, b);
  const saved = records(envB, b, store, `refs/sessions/${ALICE}/${newId}`).filter((x) => x.type === "message");
  assert.deepEqual(saved.map((x) => x.content), ["Now add tests."], "the copied records are not saved again");
  assert.equal(saved[0].parentId, head, "the fork continues from the source head");
  braid(envB, b, ["commit", "-m", "Tests", "--session", newId]);
  assert.match(braid(envB, b, ["push", "--session", newId]).stdout, /published/);

  // The same session id saved on both machines (a transcript copied by hand): both publish, and the remote keeps both sides.
  const copy = join(s.root, "copy.jsonl");
  writeFileSync(copy, readFileSync(t.path, "utf8"));
  appendFileSync(copy, JSON.stringify({ parentUuid: head, type: "user", message: { role: "user", content: "From the server." }, uuid: "c0000000-0000-4000-8000-000000000001", timestamp: "2026-11-09T12:00:00.000Z", sessionId: ALICE, cwd: "/work" }) + "\n");
  braid(envB, b, ["hook", "session-start"], hookIn(ALICE, copy, b));
  braid(envB, b, ["hook", "stop"], hookIn(ALICE, copy, b));
  t.user("From the laptop.");
  braid(s.env, a, ["hook", "stop"], hookIn(ALICE, t.path, a));
  braid(envB, b, ["commit", "-m", "Server", "--session", ALICE]);
  braid(s.env, a, ["commit", "-m", "Laptop", "--session", ALICE]);
  const pushB = braid(envB, b, ["push", "--session", ALICE]);
  assert.match(pushB.stdout, /published 5b0e2c1a/, pushB.stderr);
  const pushA = braid(s.env, a, ["push", "--session", ALICE]);
  assert.match(pushA.stdout, /published 5b0e2c1a/, pushA.stderr);
  const remote = records(s.env, s.root, join(s.root, "remote.git"), `refs/braid/sessions/${ALICE}/${ALICE}`);
  const texts = remote.filter((x) => x.role === "user").map((x) => x.content);
  assert.ok(texts.includes("From the server.") && texts.includes("From the laptop."), JSON.stringify(texts));
});

test("OpenClaw sessions import from SQLite, incrementally", async () => {
  const s = sandbox();
  const repo = clone(s, "ivy", "ivy@example.com");
  must(s.env, repo, "git", ["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  braid(s.env, repo, ["init", "--no-autopilot"]);
  const { DatabaseSync } = await import("node:sqlite");
  const { zstdCompressSync } = await import("node:zlib");
  const path = join(s.root, "openclaw-agent.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE session_nodes (session_key TEXT PRIMARY KEY, current_session_id TEXT, parent_session_key TEXT, label TEXT, display_name TEXT);
    CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT, created_at INTEGER, event_zstd BLOB, PRIMARY KEY (session_id, seq));`);
  const MAIN = "6f0a5d05-1708-4b07-a961-bb6dcc33bb13";
  const CHILD = "77aa0000-1708-4b07-a961-bb6dcc33bb13";
  db.prepare("INSERT INTO session_nodes VALUES (?, ?, ?, ?, ?)").run("agent:main:main", MAIN, null, null, "Inbox");
  db.prepare("INSERT INTO session_nodes VALUES (?, ?, ?, ?, ?)").run("agent:main:sub", CHILD, "agent:main:main", null, "Research");
  const add = (session: string, seq: number, event: object, compressed = false) => {
    const json = JSON.stringify(event);
    db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?, 0, ?)").run(session, seq, compressed ? null : json, compressed ? zstdCompressSync(Buffer.from(json)) : null);
  };
  const msg = (id: string, parentId: string | null, message: object) => ({ type: "message", id, parentId, timestamp: "2026-11-09T10:00:00.000Z", message });
  for (const id of [MAIN, CHILD]) add(id, 0, { type: "session", version: 4, id, timestamp: "2026-11-09T10:00:00.000Z", cwd: "/Users/ivy/.openclaw/workspace" });
  add(MAIN, 1, msg("m1", null, { role: "user", content: "Check the build.", timestamp: 1 }));
  add(MAIN, 2, msg("m2", "m1", { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "ci/build.log" } }], provider: "openai", model: "gpt-5.5", api: "openai-responses", stopReason: "toolUse", timestamp: 2 }), true);
  add(MAIN, 3, msg("m3", "m2", { role: "toolResult", toolCallId: "call_1", toolName: "read", content: [{ type: "text", text: "build ok" }], isError: false, timestamp: 3 }));
  add(MAIN, 4, msg("m4", "m3", { role: "assistant", content: [{ type: "text", text: "The build passes." }], provider: "openai", model: "gpt-5.5", api: "openai-responses", stopReason: "stop", timestamp: 4 }));
  add(CHILD, 1, msg("c1", null, { role: "user", content: "Find sources.", timestamp: 5 }));

  const first = braid(s.env, repo, ["import", "openclaw", "--db", path]);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /6f0a5d05 Inbox: imported 4 records/);
  assert.match(first.stdout, /77aa0000 Research: imported 1 records/);
  assert.doesNotMatch(first.stderr, /ExperimentalWarning/);
  const store = storeOf(s.env, repo);
  assert.ok(must(s.env, repo, "git", ["--git-dir", store, "for-each-ref", "--format=%(refname)"]).includes(`refs/sessions/${MAIN}/${CHILD}`), "a spawned session joins its parent's conversation");

  // Only new events are imported the next time.
  add(MAIN, 5, msg("m5", "m4", { role: "user", content: "Thanks.", timestamp: 6 }));
  const again = braid(s.env, repo, ["import", "openclaw", "--db", path]);
  assert.match(again.stdout, /6f0a5d05 Inbox: imported 1 records/);
  assert.match(again.stdout, /77aa0000 Research: up to date/);
  db.close();

  // An imported session commits like any other.
  assert.match(braid(s.env, repo, ["commit", "-m", "Build check", "--session", MAIN]).stdout, /committed 6f0a5d05: Build check/);

  const shown = braid(s.env, repo, ["show", "6f0a5d05"]);
  assert.match(shown.stdout, /via openclaw · assistant\] → read ci\/build\.log/);
  assert.match(shown.stdout, /The build passes\./);
});

test(".braidignore withholds tool calls on the paths it names", () => {
  const s = sandbox();
  const repo = clone(s, "jo", "jo@example.com");
  mkdirSync(join(repo, "data"));
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, ".env"), "DB_URL=postgres://localhost/app\n");
  writeFileSync(join(repo, "data", "clients.csv"), "name,revenue\n");
  writeFileSync(join(repo, "src", "app.ts"), "export {};\n");
  must(s.env, repo, "git", ["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  // braid init writes a .braidignore that covers .env files; this team adds its data.
  braid(s.env, repo, ["init", "--no-autopilot", "--autopush"]);
  assert.match(readFileSync(join(repo, ".braidignore"), "utf8"), /^\.env$/m);
  appendFileSync(join(repo, ".braidignore"), "data/\n");

  const t = new Transcript(s.root, ALICE);
  const hookIn = JSON.stringify({ session_id: ALICE, transcript_path: t.path, cwd: repo });
  braid(s.env, repo, ["hook", "session-start"], hookIn);
  t.user("Why is the import failing?");
  t.toolCall("Read", { file_path: join(repo, ".env") }, "toolu_env", "DB_URL=postgres://localhost/app");
  t.toolCall("Bash", { command: "head -3 data/clients.csv" }, "toolu_csv", "name,revenue\nAcme,1200000");
  t.toolCall("Read", { file_path: join(repo, "src", "app.ts") }, "toolu_app", "export {};");
  t.assistant("The CSV has no header row for region.");
  braid(s.env, repo, ["hook", "stop"], hookIn);
  braid(s.env, repo, ["commit", "-m", "Import check", "--session", ALICE]);
  assert.match(braid(s.env, repo, ["edit", "--session", ALICE]).stdout, /✗ agent +→ Read \S*\/\.env {2}\[\.braidignore \.env\]/);

  const dry = braid(s.env, repo, ["push", "--dry-run", "--session", ALICE]).stdout;
  assert.match(dry, /withheld: \.env 1, data\/ 1/);
  assert.match(dry, /would publish 4 records/, "the prompt, the call on src/app.ts and its result, and the answer");
  braid(s.env, repo, ["push", "--session", ALICE]);
  const text = JSON.stringify(records(s.env, s.root, join(s.root, "remote.git"), `refs/braid/sessions/${ALICE}/${ALICE}`));
  assert.doesNotMatch(text, /DB_URL|Acme,1200000|clients\.csv/);
  assert.match(text, /src\/app\.ts/);

  // Your own ~/.config/braid/ignore adds to it.
  mkdirSync(join(s.env.XDG_CONFIG_HOME!, "braid"), { recursive: true });
  writeFileSync(join(s.env.XDG_CONFIG_HOME!, "braid", "ignore"), "src/\n");
  assert.match(braid(s.env, repo, ["push", "--dry-run", "--session", ALICE]).stdout, /withheld: \.env 1, data\/ 1, src\/ 1/);
});

test("on autopilot, braid keeps conversations on this machine, saves the conversation init runs in, and marks fork points before big turns", () => {
  const s = sandbox();
  const repo = clone(s, "erin", "erin@example.com");
  must(s.env, repo, "git", ["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  must(s.env, repo, "git", ["push", "--quiet", "origin", "HEAD:main"]);

  // A session that started before braid was set up: nothing is saved yet, not even where a cache left a .git folder
  // in the braid repository's place.
  mkdirSync(join(s.env.HOME!, ".braid", ".git", "braid", "cache", "erin"), { recursive: true });
  const t = new Transcript(s.root, ALICE);
  const hookIn = JSON.stringify({ session_id: ALICE, transcript_path: t.path, cwd: repo });
  braid(s.env, repo, ["hook", "session-start"], hookIn);
  t.user("Plan the parser rewrite.");
  t.assistant("Start with the tokenizer.");
  braid(s.env, repo, ["hook", "stop"], hookIn);
  assert.equal(existsSync(storeOf(s.env, repo)), false);

  // /braid:init in that session saves it from its first turn, and leaves autopilot on.
  const init = braid(s.env, repo, ["init"], undefined, { BRAID_SESSION: ALICE });
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /autopilot: conversations stay on this machine/);
  assert.match(init.stdout, /created \S+\/home\/\.braid, the braid repository/);
  assert.match(init.stdout, /saved this conversation \(5b0e2c1a\), 3 records, in \S+\/home\/\.braid$/m);
  assert.equal(existsSync(join(repo, ".git", "braid")), false, "nothing in the code repository's .git");
  assert.match(readFileSync(join(repo, ".braid", "config.toml"), "utf8"), /^autopilot = true$/m);

  // A big turn: braid marks the conversation as it stood before it.
  t.user("Rewrite the parser.");
  for (let i = 1; i <= 5; i++) t.toolCall("Edit", { file_path: join(repo, `p${i}.ts`), old_string: "a", new_string: "b" }, `toolu_e${i}`, "ok");
  t.assistant("Rewrote the parser across five files.");
  braid(s.env, repo, ["hook", "stop"], hookIn);
  const log = braid(s.env, repo, ["log", "--session", ALICE]).stdout;
  assert.match(log, /^5b0e2c1a\.\d+ +Rewrite the parser\. +\(5 files edited, 5 tool calls\)$/m);
  // A small turn marks nothing.
  t.user("Thanks.");
  t.assistant("You're welcome.");
  braid(s.env, repo, ["hook", "stop"], hookIn);
  assert.match(braid(s.env, repo, ["log", "--session", ALICE]).stdout, /^5b0e2c1a\.\d+ +Thanks\.$/m, "a turn that called no tools says nothing more");

  // Forking the point writes the conversation as it was, before the rewrite.
  const fork = braid(s.env, repo, ["fork", "@1", "--session", ALICE]);
  assert.equal(fork.status, 0, fork.stderr);
  assert.match(fork.stdout, /as it was before "Rewrite the parser\."[^\n]*\n {2}cd \S+ && claude --resume [0-9a-f-]{36}\n?$/);
  const forked = readFileSync(join(s.env.HOME!, ".claude", "projects", realpathSync(repo).replace(/[^A-Za-z0-9]/g, "-"), `${/--resume (\S+)/.exec(fork.stdout)![1]}.jsonl`), "utf8");
  assert.match(forked, /Start with the tokenizer/);
  assert.doesNotMatch(forked, /Rewrite the parser|Rewrote/);

  // Nothing leaves the machine: no trailer, no publishing on git push or braid push, no fetch, no pull requests.
  writeFileSync(join(repo, "p1.ts"), "export {};\n");
  must(s.env, repo, "git", ["add", "p1.ts"]);
  must({ ...s.env, BRAID_SESSION: ALICE }, repo, "git", ["commit", "--quiet", "-m", "Parser"]);
  assert.doesNotMatch(must(s.env, repo, "git", ["log", "-1", "--format=%B"]), /Braid-Session/);
  braid(s.env, repo, ["commit", "-m", "Parser rewrite", "--session", ALICE]);
  must(s.env, repo, "git", ["push", "--quiet", "origin", "HEAD:main"]);
  assert.match(braid(s.env, repo, ["push", "--session", ALICE]).stdout, /not published: autopilot is on/);
  assert.equal(must(s.env, s.root, "git", ["--git-dir", join(s.root, "remote.git"), "for-each-ref", "refs/braid"]), "");
  assert.match(braid(s.env, repo, ["fetch"]).stderr, /autopilot is on/);
  assert.match(braid(s.env, repo, ["review", "1", "--session", ALICE]).stderr, /autopilot is on/);

  // On autopilot braid keeps the conversations of any git repository in the braid repository, with no files and no hooks in the code.
  const other = clone(s, "erin2", "erin@example.com");
  const t2 = new Transcript(s.root, BOB);
  const in2 = JSON.stringify({ session_id: BOB, transcript_path: t2.path, cwd: other });
  braid(s.env, other, ["hook", "session-start"], in2);
  t2.user("Read the README.");
  t2.assistant("It says shop.");
  braid(s.env, other, ["hook", "stop"], in2);
  assert.equal(records(s.env, s.root, storeOf(s.env, other), `refs/sessions/${BOB}/${BOB}`).length, 3);
  assert.equal(existsSync(join(other, ".braid")), false);
  assert.equal(existsSync(join(other, ".git", "braid")), false);
  assert.equal(existsSync(join(other, ".git", "hooks", "post-commit")), false);
  // One braid repository holds both conversations, and lists each with where it ran.
  const list = braid(s.env, other, ["sessions"]).stdout;
  assert.match(list, new RegExp(`^${ALICE.slice(0, 8)} .*\\(yours, in \\S+/erin\\)$`, "m"));
  assert.match(list, new RegExp(`^${BOB.slice(0, 8)} .*\\(yours, in \\S+/erin2\\)$`, "m"));
});

test("/braid:init saves the conversation it runs in, also one that started before braid was installed", () => {
  const s = sandbox();
  const repo = clone(s, "fay", "fay@example.com");
  must(s.env, repo, "git", ["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  // No session-start hook ran: braid knows neither the session nor its transcript. Claude Code names the session to
  // the commands it runs, and keeps the transcript in its projects folder.
  const projects = join(s.env.HOME!, ".claude", "projects", realpathSync(repo).replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(projects, { recursive: true });
  const t = new Transcript(projects, ALICE);
  t.user("Install braid.");
  t.assistant("Installed.");
  const claude = { CLAUDE_CODE_SESSION_ID: ALICE };
  const init = braid(s.env, repo, ["init"], undefined, claude);
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /saved this conversation \(5b0e2c1a\), 3 records/);
  t.user("Thanks.");
  t.assistant("You're welcome.");
  assert.match(braid(s.env, repo, ["save"], undefined, claude).stdout, /saved 2 records/);
  // BRAID_SESSION set empty names no session, whatever Claude Code names.
  assert.match(braid(s.env, repo, ["save"], undefined, { ...claude, BRAID_SESSION: "" }).stderr, /no session/);
});

test("the repo setting names another braid repository; the code's remote still publishes; outside any repository, ~/.braid", () => {
  const s = sandbox();
  const repo = clone(s, "dana", "dana@example.com");
  writeFileSync(join(repo, ".env"), "TOKEN=hunter2\n");
  must(s.env, repo, "git", ["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  const init = braid(s.env, repo, ["init", "--no-autopilot", "--repo", "~/convos"]);
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /conversations here are kept in \S+\/convos, apart from the code/);
  assert.match(readFileSync(join(repo, ".braid", "config.toml"), "utf8"), /^repo = "~\/convos"$/m);
  assert.ok(existsSync(join(repo, ".git", "hooks", "pre-push")), "the code repository's git hooks still publish");
  assert.ok(existsSync(join(s.env.HOME!, "convos", ".git", "braid", "store", "HEAD")), "init makes the store there");
  const again = braid(s.env, repo, ["init"]);
  assert.equal(again.status, 0, again.stderr);
  assert.doesNotMatch(again.stdout, /created/);

  const t = new Transcript(s.root, ALICE);
  const hookIn = JSON.stringify({ session_id: ALICE, transcript_path: t.path, cwd: repo });
  braid(s.env, repo, ["hook", "session-start"], hookIn);
  t.user("Check the token.");
  t.toolCall("Read", { file_path: join(repo, ".env") }, "toolu_env", "TOKEN=hunter2");
  t.assistant("The token is set.");
  braid(s.env, repo, ["hook", "stop"], hookIn);
  const convos = join(s.env.HOME!, "convos");
  assert.ok(records(s.env, s.root, join(convos, ".git", "braid", "store"), `refs/sessions/${ALICE}/${ALICE}`).length > 0);
  assert.equal(existsSync(join(repo, ".git", "braid")), false);

  // The code repository's .braidignore applies, and braid push publishes to the code repository's remote.
  braid(s.env, repo, ["commit", "-m", "Token check", "--session", ALICE]);
  assert.match(braid(s.env, repo, ["edit", "--session", ALICE]).stdout, /✗ agent +→ Read \S*\/\.env {2}\[\.braidignore \.env\]/);
  assert.match(braid(s.env, repo, ["push", "--session", ALICE]).stdout, /published 5b0e2c1a, 2 records/);
  const text = JSON.stringify(records(s.env, s.root, join(s.root, "remote.git"), `refs/braid/sessions/${ALICE}/${ALICE}`));
  assert.match(text, /The token is set/);
  assert.doesNotMatch(text, /hunter2/);

  // Outside any git repository, sessions go to ~/.braid.
  const scratch = join(s.root, "scratch");
  mkdirSync(scratch);
  const t2 = new Transcript(s.root, BOB);
  const in2 = JSON.stringify({ session_id: BOB, transcript_path: t2.path, cwd: scratch });
  braid(s.env, scratch, ["hook", "session-start"], in2);
  t2.user("Sketch a retry policy.");
  t2.assistant("Exponential backoff, 3 tries.");
  braid(s.env, scratch, ["hook", "stop"], in2);
  assert.match(JSON.stringify(records(s.env, s.root, join(s.env.HOME!, ".braid", ".git", "braid", "store"), `refs/sessions/${BOB}/${BOB}`)), /Exponential backoff/);
  assert.match(braid(s.env, scratch, ["review"]).stderr, /usage: braid review <pull request number>/);
});

test("braid verify: sessions are saved as they happened and load back the same, also read in several windows", () => {
  const s = sandbox();
  const repo = clone(s, "gus", "gus@example.com");
  must(s.env, repo, "git", ["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  braid(s.env, repo, ["init"]);
  // Small windows, so each save reads the transcript in several of them, with overlaps.
  const small = { BRAID_WINDOW_BYTES: "4000" };
  const t = new Transcript(s.root, ALICE);
  const hookIn = (session: string, tr: Transcript) => JSON.stringify({ session_id: session, transcript_path: tr.path, cwd: repo });
  braid(s.env, repo, ["hook", "session-start"], hookIn(ALICE, t));
  for (let i = 1; i <= 12; i++) {
    t.user(`Step ${i}: ${"plan ".repeat(60)}`);
    t.assistant(`Done with step ${i}.`);
  }
  // After a resume, Claude Code writes an early line again under its uuid: several windows back.
  const early = JSON.parse(readFileSync(t.path, "utf8").split("\n")[1]!);
  appendFileSync(t.path, JSON.stringify({ ...early, cwd: "/work/sub" }) + "\n");
  braid(s.env, repo, ["hook", "stop"], hookIn(ALICE, t), small);
  const ok = braid(s.env, repo, ["verify", "--session", ALICE], undefined, small);
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /braid verify 5b0e2c1a: ok\n {2}✓ saved: 25 records of the transcript\n {2}✓ loads: 25 lines, the same in a fork as in the transcript/);
  assert.equal(records(s.env, repo, storeOf(s.env, repo), `refs/sessions/${ALICE}/${ALICE}`).filter((r) => r.id === early.uuid).length, 2, "each line is saved once");

  // A /branch copy whose first save spans several windows saves each record once.
  const BRANCH = "7c1d2e3f-0000-4000-8000-0000000000bb";
  const tb = t.fork(s.root, BRANCH);
  for (let i = 1; i <= 12; i++) {
    tb.user(`Branch step ${i}: ${"try ".repeat(60)}`);
    tb.assistant(`Branch step ${i} done.`);
  }
  braid(s.env, repo, ["hook", "stop"], hookIn(BRANCH, tb), small);
  const ids = records(s.env, repo, storeOf(s.env, repo), `refs/sessions/${ALICE}/${BRANCH}`).map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, "no record saved twice");
  const branch = braid(s.env, repo, ["verify", "--session", BRANCH], undefined, small);
  assert.equal(branch.status, 0, branch.stdout);

  // A turn written since the last save, as in a session still running, is noted and is no problem: the next save takes it in.
  t.user("One more thing.");
  t.assistant("Noted.");
  const behind = braid(s.env, repo, ["verify", "--session", ALICE]);
  assert.equal(behind.status, 0, behind.stdout);
  assert.match(behind.stdout, /^braid verify 5b0e2c1a: ok\n[\s\S]*\n {2}· 2 records written since the last save, which the next save takes in$/m);
  braid(s.env, repo, ["hook", "stop"], hookIn(ALICE, t));
  const all = braid(s.env, repo, ["verify", "--all"]);
  assert.equal(all.status, 0, all.stdout);
  assert.doesNotMatch(all.stdout, /written since the last save/);
});

test("a session continues in Codex: braid fork --to codex writes what the model saw as a Codex session", () => {
  const s = sandbox();
  const repo = clone(s, "hal", "hal@example.com");
  must(s.env, repo, "git", ["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  braid(s.env, repo, ["init"]);
  const path = join(s.root, `${ALICE}.jsonl`);
  let n = 0;
  const uuid = () => `5b0e2c1a-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const put = (fields: Record<string, unknown>) => {
    appendFileSync(path, JSON.stringify({ isSidechain: false, timestamp: new Date(Date.UTC(2026, 10, 9, 10, 0, n)).toISOString(), cwd: repo, sessionId: ALICE, version: "2.1.316", ...fields }) + "\n");
    return fields.uuid as string;
  };
  const say = (parentUuid: string | null, role: "user" | "assistant", content: unknown, id?: string) =>
    put({ parentUuid, type: role, uuid: uuid(), message: role === "user" ? { role, content } : { id: id ?? `msg_${n}`, type: "message", role, model: "claude-sonnet-5-5", content } });

  const start = say(null, "user", "Start.");
  const kept = say(start, "assistant", [{ type: "text", text: "Earlier answer, kept by the compaction." }]);
  const boundary = uuid();
  const summary = uuid();
  put({ parentUuid: null, logicalParentUuid: kept, type: "system", subtype: "compact_boundary", uuid: boundary, content: "Conversation compacted", compactMetadata: { trigger: "auto", preservedMessages: { anchorUuid: summary, uuids: [kept], allUuids: [kept] } } });
  put({ parentUuid: boundary, type: "user", uuid: summary, isCompactSummary: true, message: { role: "user", content: "Summary: we started." } });
  const ask = say(summary, "user", `Read ${repo}/a.ts and ${repo}/b.ts.`);
  // Reasoning signed for Claude, then one response in two lines with two calls; each result hangs from its call.
  const think = say(ask, "assistant", [{ type: "thinking", thinking: "Both at once.", signature: "c2lnbmVkIGJ5IEFudGhyb3BpYw==" }], "msg_par");
  const callA = say(think, "assistant", [{ type: "tool_use", id: "toolu_a", name: "Read", input: { file_path: `${repo}/a.ts` } }], "msg_par");
  const callB = say(callA, "assistant", [{ type: "tool_use", id: "toolu_b", name: "Read", input: { file_path: `${repo}/b.ts` } }], "msg_par");
  // A failed call, with a note Claude Code wrote for its model below the result; a message the user typed while the
  // agent worked; a notice that a background task finished, in the user's place.
  const resultB = say(callB, "user", [{ type: "tool_result", tool_use_id: "toolu_b", content: "Error: b.ts is locked", is_error: true }]);
  put({ parentUuid: resultB, type: "user", uuid: uuid(), isMeta: true, message: { role: "user", content: [{ type: "text", text: "Base directory for this skill: /skills/locks" }] } });
  const resultA = say(callA, "user", [{ type: "tool_result", tool_use_id: "toolu_a", content: "export const a = 1;" }]);
  const typed = put({ parentUuid: resultA, type: "attachment", uuid: uuid(), attachment: { type: "queued_command", prompt: "Also check the README.", commandMode: "prompt", origin: { kind: "human" } } });
  const answer = say(typed, "assistant", [{ type: "text", text: "a is 1, and b is locked." }]);
  const notice = put({ parentUuid: answer, type: "user", uuid: uuid(), origin: { kind: "task-notification" }, message: { role: "user", content: "<task-notification>build finished</task-notification>" } });
  say(notice, "assistant", [{ type: "text", text: "The build finished." }]);
  const hookIn = JSON.stringify({ session_id: ALICE, transcript_path: path, cwd: repo });
  braid(s.env, repo, ["hook", "session-start"], hookIn);
  braid(s.env, repo, ["hook", "stop"], hookIn);

  // Codex keeps sessions under CODEX_HOME as sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl, and resumes one by its id.
  const codexHome = join(s.root, "codex");
  const elsewhere = join(s.root, "elsewhere");
  mkdirSync(elsewhere);
  const r = braid(s.env, repo, ["fork", "5b0e2c1a", "--to", "codex", "--cwd", elsewhere], undefined, { CODEX_HOME: codexHome });
  assert.equal(r.status, 0, r.stderr);
  const id = /codex resume (\S+)$/m.exec(r.stdout)![1]!;
  assert.match(r.stdout, /^braid: wrote 5b0e2c1a as a new Codex session\. To continue it in a new window, run in a terminal:\n {2}cd \S+\/elsewhere && codex resume [0-9a-f-]{36}\n$/);
  // The same fork asked for again is the same session; --new writes another.
  const twice = braid(s.env, repo, ["fork", "5b0e2c1a", "--to", "codex", "--cwd", elsewhere], undefined, { CODEX_HOME: codexHome });
  assert.match(twice.stdout, new RegExp(`^braid: 5b0e2c1a is already a Codex session, from an earlier fork\\. To continue it in a new window, run in a terminal:\\n {2}cd \\S+ && codex resume ${id}\\nbraid fork --new writes another\\.\\n$`));
  const another = braid(s.env, repo, ["fork", "5b0e2c1a", "--to", "codex", "--cwd", elsewhere, "--new"], undefined, { CODEX_HOME: codexHome });
  const other = /codex resume (\S+)$/m.exec(another.stdout)![1]!;
  assert.notEqual(other, id);
  rmSync(join(codexHome, "sessions", readdirSync(join(codexHome, "sessions"), { recursive: true }).map(String).find((f) => f.endsWith(`${other}.jsonl`))!));
  const files = readdirSync(join(codexHome, "sessions"), { recursive: true }).map(String).filter((f) => f.endsWith(".jsonl"));
  assert.equal(files.length, 1);
  assert.match(files[0]!, new RegExp(`^\\d{4}/\\d{2}/\\d{2}/rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-${id}\\.jsonl$`));
  const lines = readFileSync(join(codexHome, "sessions", files[0]!), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].type, "session_meta");
  assert.deepEqual([lines[0].payload.id, lines[0].payload.cwd], [id, realpathSync(elsewhere)]);
  // One line of history, as the model read it: what the compaction kept after its summary, both calls, then both
  // results, a failed one as its text, then the note on it, with paths moved to the new directory. The typed message
  // is the user's, and the notice a note for the model. Reasoning signed for Claude is left out.
  const there = realpathSync(elsewhere);
  const said = lines.slice(1).map(({ type, payload: p }) =>
    type === "compacted" ? `compacted: ${p.message}`
    : type !== "response_item" ? type
    : p.type === "message" ? `${p.role}: ${p.content.map((c: { text: string }) => c.text).join("")}`
    : p.type === "function_call" ? `call ${p.call_id} ${p.name} ${p.arguments}`
    : p.type === "function_call_output" ? `result ${p.call_id}: ${p.output}`
    : p.type,
  );
  assert.deepEqual(said, [
    "compacted: Summary: we started.",
    "assistant: Earlier answer, kept by the compaction.",
    `user: Read ${there}/a.ts and ${there}/b.ts.`,
    `call toolu_a Read {"file_path":"${there}/a.ts"}`,
    `call toolu_b Read {"file_path":"${there}/b.ts"}`,
    "result toolu_b: Error: b.ts is locked",
    "result toolu_a: export const a = 1;",
    "developer: Base directory for this skill: /skills/locks",
    "user: Also check the README.",
    "assistant: a is 1, and b is locked.",
    "developer: <task-notification>build finished</task-notification>",
    "assistant: The build finished.",
  ]);

  // From inside the session, the conversation as it is now, with the turn since the last save.
  say(null, "user", "One more question.");
  const now = braid(s.env, repo, ["fork", "--to", "codex", "--cwd", elsewhere], undefined, { CODEX_HOME: codexHome, BRAID_SESSION: ALICE });
  assert.equal(now.status, 0, now.stderr);
  assert.match(now.stdout, /^braid: wrote this conversation as a new Codex session/);
  assert.match(braid(s.env, repo, ["fork", "5b0e2c1a", "--to", "gemini"]).stderr, /braid writes sessions for claude-code and codex, not gemini/);
});

test("a session that ended right after compacting continues from the compaction, in Claude Code and in Codex", () => {
  const s = sandbox();
  const repo = clone(s, "ivy", "ivy@example.com");
  must(s.env, repo, "git", ["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  braid(s.env, repo, ["init"]);
  const path = join(s.root, `${ALICE}.jsonl`);
  let n = 0;
  const uuid = () => `5b0e2c1a-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const put = (fields: Record<string, unknown>) => {
    appendFileSync(path, JSON.stringify({ isSidechain: false, timestamp: new Date(Date.UTC(2026, 10, 9, 10, 0, n)).toISOString(), cwd: repo, sessionId: ALICE, version: "2.1.316", ...fields }) + "\n");
    return fields.uuid as string;
  };
  const say = (parentUuid: string | null, role: "user" | "assistant", content: unknown) =>
    put({ parentUuid, type: role, uuid: uuid(), message: role === "user" ? { role, content } : { id: `msg_${n}`, type: "message", role, model: "claude-sonnet-5-5", content } });
  const first = say(null, "user", "Plan the migration.");
  const kept = say(first, "assistant", [{ type: "text", text: "Step one is the schema." }]);
  const boundary = uuid();
  const summary = uuid();
  put({ parentUuid: null, logicalParentUuid: kept, type: "system", subtype: "compact_boundary", uuid: boundary, content: "Conversation compacted", compactMetadata: { trigger: "auto", preservedMessages: { anchorUuid: summary, uuids: [kept], allUuids: [kept] } } });
  put({ parentUuid: boundary, type: "user", uuid: summary, isCompactSummary: true, message: { role: "user", content: "Summary: planning a migration." } });
  const hookIn = JSON.stringify({ session_id: ALICE, transcript_path: path, cwd: repo });
  braid(s.env, repo, ["hook", "session-start"], hookIn);
  braid(s.env, repo, ["hook", "stop"], hookIn);
  const ok = braid(s.env, repo, ["verify", "--session", ALICE]);
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /✓ loads: \d+ lines since the last compaction, the same in a fork as in the transcript/);

  const codexHome = join(s.root, "codex");
  const r = braid(s.env, repo, ["fork", "5b0e2c1a", "--to", "codex", "--cwd", repo], undefined, { CODEX_HOME: codexHome });
  assert.equal(r.status, 0, r.stderr);
  const file = readdirSync(join(codexHome, "sessions"), { recursive: true }).map(String).find((f) => f.endsWith(".jsonl"))!;
  const lines = readFileSync(join(codexHome, "sessions", file), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const said = lines.slice(1).map(({ type, payload: p }) => (type === "compacted" ? `compacted: ${p.message}` : `${p.role}: ${p.content.map((c: { text: string }) => c.text).join("")}`));
  assert.deepEqual(said, ["compacted: Summary: planning a migration.", "assistant: Step one is the schema."]);
});

test("a fork holds what Claude Code reads to resume: what a compaction kept, parallel calls beside the chain, notes, messages typed mid-turn, and the session's settings", () => {
  const s = sandbox();
  const repo = clone(s, "gus", "gus@example.com");
  must(s.env, repo, "git", ["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  braid(s.env, repo, ["init"]);
  const path = join(s.root, `${ALICE}.jsonl`);
  let n = 0;
  const uuid = () => `5b0e2c1a-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const put = (fields: Record<string, unknown>) => {
    const line = { isSidechain: false, timestamp: new Date(Date.UTC(2026, 10, 9, 10, 0, n)).toISOString(), cwd: repo, sessionId: ALICE, version: "2.1.316", ...fields };
    appendFileSync(path, JSON.stringify(line) + "\n");
    return fields.uuid as string;
  };
  const say = (parentUuid: string | null, role: "user" | "assistant", content: unknown, id?: string) =>
    put({ parentUuid, type: role, uuid: uuid(), message: role === "user" ? { role, content } : { id: id ?? `msg_${n}`, type: "message", role, model: "claude-sonnet-5-5", content } });
  const note = (parentUuid: string, attachment: object) => put({ parentUuid, type: "attachment", uuid: uuid(), attachment });

  const start = say(null, "user", "Start.");
  const kept = say(start, "assistant", [{ type: "text", text: "Earlier answer, kept by the compaction." }]);
  const boundary = uuid();
  const summary = uuid();
  put({ parentUuid: null, logicalParentUuid: kept, type: "system", subtype: "compact_boundary", uuid: boundary, content: "Conversation compacted", compactMetadata: { trigger: "auto", preservedSegment: { headUuid: kept, anchorUuid: summary, tailUuid: kept }, preservedMessages: { anchorUuid: summary, uuids: [kept], allUuids: [kept] } } });
  put({ parentUuid: boundary, type: "user", uuid: summary, isCompactSummary: true, message: { role: "user", content: "Summary: we started." } });
  put({ type: "permission-mode", permissionMode: "auto" });
  const ask = say(summary, "user", "Read the two files.");
  // One response in two lines, two calls; each result hangs from its call, and the conversation goes on from the first.
  const callA = say(ask, "assistant", [{ type: "tool_use", id: "toolu_a", name: "Read", input: { file_path: "a.ts" } }], "msg_par");
  const callB = say(callA, "assistant", [{ type: "tool_use", id: "toolu_b", name: "Read", input: { file_path: "b.ts" } }], "msg_par");
  const resultB = say(callB, "user", [{ type: "tool_result", tool_use_id: "toolu_b", content: "export const b = 2;" }]);
  note(resultB, { type: "bash_output_audience_note", content: "A note on the second result." });
  const resultA = say(callA, "user", [{ type: "tool_result", tool_use_id: "toolu_a", content: "export const a = 1;" }]);
  const queued = note(resultA, { type: "queued_command", prompt: "Also check the README.", commandMode: "prompt", origin: { kind: "human" } });
  const delta = note(queued, { type: "deferred_tools_delta", addedNames: ["Monitor"], removedNames: [] });
  const record = note(delta, { type: "deferred_tools_record", entries: [], nameOnlyAnnouncements: [delta] });
  put({ type: "bridge-session", bridgeSessionId: "cse_1", ownerAccountUuid: "3c5ee1cb-26a1-454b-a6f9-5625d9a0aecc" });
  say(record, "assistant", [{ type: "text", text: "Both files read, and the README." }]);

  const hookIn = JSON.stringify({ session_id: ALICE, transcript_path: path, cwd: repo });
  braid(s.env, repo, ["hook", "session-start"], hookIn);
  braid(s.env, repo, ["hook", "stop"], hookIn);
  const ok = braid(s.env, repo, ["verify", "--session", ALICE]);
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /✓ loads: 15 lines since the last compaction, the same in a fork as in the transcript/);

  // Without the transcript, braid writes the fork itself, from the store.
  writeFileSync(`${path}.gone`, readFileSync(path));
  writeFileSync(path, "");
  const r = braid(s.env, repo, ["fork", "5b0e2c1a", "--cwd", repo]);
  assert.equal(r.status, 0, r.stderr);
  const id = /--resume (\S+)/.exec(r.stdout)![1]!;
  const file = join(s.env.HOME!, ".claude", "projects", realpathSync(repo).replace(/[^A-Za-z0-9]/g, "-"), `${id}.jsonl`);
  const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const text = (l: { message?: { content?: unknown }; attachment?: unknown }) => JSON.stringify(l.message?.content ?? l.attachment ?? "");
  const find = (what: string) => lines.find((l) => text(l).includes(what));
  assert.ok(find("Earlier answer"), "what the compaction kept");
  assert.ok(!find("Start."), "not what it summarized");
  assert.ok(find("Also check the README."), "a message typed while the agent worked");
  assert.ok(find("A note on the second result."), "a note on a result beside the chain");
  assert.ok(lines.some((l) => l.type === "permission-mode"), "the session's settings");
  const [a, b, rb] = [find("toolu_a\",\"name"), find("toolu_b\",\"name"), find("export const b")];
  assert.equal(rb.parentUuid, b.uuid, "the second result hangs from its call");
  assert.equal(b.parentUuid, a.uuid, "the response's second line from its first");
  const boundaryLine = lines.find((l) => l.subtype === "compact_boundary");
  assert.equal(boundaryLine.parentUuid, null, "the compaction starts the chain");
  assert.deepEqual(boundaryLine.compactMetadata.preservedMessages.allUuids, [find("Earlier answer").uuid], "and names what it kept by its uuid in the fork");
  assert.equal(find("nameOnlyAnnouncements").attachment.nameOnlyAnnouncements[0], find("addedNames").uuid, "a line named inside an attachment, too");
  assert.equal(lines.find((l) => l.type === "bridge-session").ownerAccountUuid, "3c5ee1cb-26a1-454b-a6f9-5625d9a0aecc", "other ids stay as they are");
  assert.ok(lines.every((l) => l.sessionId === id));

  // Claude Code resumes the fork and adds a turn: the first save keeps only the new turn.
  appendFileSync(file, JSON.stringify({ parentUuid: lines.at(-1).uuid, type: "user", message: { role: "user", content: "Next." }, uuid: "b0000000-0000-4000-8000-000000000001", timestamp: "2026-11-10T12:00:00.000Z", sessionId: id, cwd: repo }) + "\n");
  const forkIn = JSON.stringify({ session_id: id, transcript_path: file, cwd: repo });
  braid(s.env, repo, ["hook", "session-start"], forkIn);
  braid(s.env, repo, ["hook", "stop"], forkIn);
  const saved = records(s.env, repo, storeOf(s.env, repo), `refs/sessions/${ALICE}/${id}`).filter((x) => x.type !== "transcript");
  assert.deepEqual(saved.map((x) => x.content), ["Next."], "the copied lines are not saved again");
});

/** The lines of a Claude Code transcript, as said: each message's text, tool calls and results, by response. */
function claudeSaid(path: string): string[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .flatMap((l) => {
      const m = l.message;
      if (!m) return [];
      const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
      const who = l.type === "assistant" ? "assistant" : l.isMeta ? "note" : "user";
      return blocks.map((b: Record<string, unknown>) =>
        b.type === "text" ? `${who}: ${b.text}`
        : b.type === "tool_use" ? `call ${b.id} ${b.name} ${JSON.stringify(b.input)}`
        : b.type === "tool_result" ? `result ${b.tool_use_id}: ${b.content}`
        : String(b.type),
      );
    });
}

test("Codex sessions save as they happen, from braid's hooks in Codex, and continue in Claude Code", () => {
  const s = sandbox();
  const repo = clone(s, "jo", "jo@example.com");
  must(s.env, repo, "git", ["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  const codexHome = join(s.root, "codex");
  mkdirSync(codexHome);
  // A hook of the user's own, which braid leaves as it is.
  writeFileSync(join(codexHome, "hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "notify-me", timeout: 5 }] }] } }));
  const env = { ...s.env, CODEX_HOME: codexHome };
  assert.match(braid(env, repo, ["init"]).stdout, /added braid's hooks to \S+\/hooks\.json, so braid saves Codex sessions too: open \/hooks in Codex once to trust them/);
  const commands = () => {
    const hooks = JSON.parse(readFileSync(join(codexHome, "hooks.json"), "utf8")).hooks as Record<string, { hooks: { command: string; timeout: number }[] }[]>;
    return Object.fromEntries(Object.entries(hooks).map(([event, groups]) => [event, groups.flatMap((g) => g.hooks.map((h) => `${h.command.replace(/^\S+\/\.local\/bin\/braid /, "braid ")} ${h.timeout}`))]));
  };
  const installed = {
    Stop: ["notify-me 5", "braid hook stop --agent codex 30"],
    SessionStart: ["braid hook session-start --agent codex 15"],
    SessionEnd: ["braid hook session-end --agent codex 3"],
  };
  assert.deepEqual(commands(), installed);
  // Set up again, braid's hooks are there once; undone, the user's own stays.
  assert.doesNotMatch(braid(env, repo, ["init"]).stdout, /hooks\.json/);
  assert.deepEqual(commands(), installed);
  assert.match(braid(env, repo, ["init", "--undo"]).stdout, /took braid's hooks out of \S+\/hooks\.json/);
  assert.deepEqual(commands(), { Stop: ["notify-me 5"] });
  braid(env, repo, ["init"]);

  // Codex runs SessionStart before it writes the rollout, and Stop after each turn.
  const ID = "01a1d58a-9cbc-7901-ae2d-6eed8de9cde3";
  const hook = (name: string, transcript: string | null, extra: NodeJS.ProcessEnv = {}) =>
    braid(env, repo, ["hook", name, "--agent", "codex"], JSON.stringify({ session_id: ID, transcript_path: transcript, cwd: repo, hook_event_name: name, model: "gpt-5.5" }), extra);
  assert.equal(hook("session-start", null).status, 0);
  const r = new Rollout(codexHome, ID, repo);
  r.turn("Fix the bug in a.ts.", repo);
  r.reasoning("Read both files.");
  r.call("exec_command", { cmd: "cat a.ts" }, "call_a");
  r.call("exec_command", { cmd: "cat b.ts" }, "call_b");
  r.line("token_usage_record", { total_token_usage: { input_tokens: 10, output_tokens: 1 } });
  r.output("call_a", "Process exited with code 0\nOutput:\nexport const a = 1;\n");
  r.output("call_b", "Process exited with code 1\nOutput:\ncat: b.ts: No such file\n");
  r.assistant("a.ts is fine; b.ts is missing, so I add it.");
  r.patch("*** Begin Patch\n*** Add File: b.ts\n+export const b = 2;\n*** End Patch\n", "call_p");
  r.output("call_p", "Success. Updated the following files:\nA b.ts\n", true);
  r.end();
  // Saved in windows of a few lines, as a long rollout is.
  assert.equal(hook("stop", r.path, { BRAID_WINDOW_BYTES: "600" }).stdout, "");
  r.turn("Now run the tests.", repo, false);
  r.item({ type: "message", role: "user", content: [{ type: "input_text", text: "<skill>\n<name>tests</name>\nRun npm test.\n</skill>" }] });
  r.call("exec_command", { cmd: "npm test" }, "call_t");
  r.output("call_t", { content: "1 failing", success: false });
  r.assistant("One test fails.");
  r.end();
  assert.equal(hook("stop", r.path, { BRAID_WINDOW_BYTES: "600" }).stdout, "");

  // The log lists the conversation, without the instructions, environment and AGENTS.md Codex gave its model.
  const log = braid(env, repo, ["log", ID, "--records"]).stdout.split("\n").filter(Boolean).map((l) => l.replace(/^\S+\s+/, ""));
  assert.deepEqual(log, [
    "user      Fix the bug in a.ts.",
    "assistant ",
    "assistant → exec_command cat a.ts",
    "assistant → exec_command cat b.ts",
    "tool      Process exited with code 0 Output: export const a = 1;",
    "tool      Process exited with code 1 Output: cat: b.ts: No such file",
    "assistant a.ts is fine; b.ts is missing, so I add it.",
    "assistant → apply_patch",
    "tool      Success. Updated the following files: A b.ts",
    "user      Now run the tests.",
    "user      <skill> <name>tests</name> Run npm test. </skill>",
    "assistant → exec_command npm test",
    "tool      1 failing",
    "assistant One test fails.",
  ]);
  const verified = braid(env, repo, ["verify", "--session", ID]);
  assert.equal(verified.status, 0, verified.stdout);
  assert.match(verified.stdout, /✓ loads: 26 lines as Codex wrote them, and 14 items, the same in a fork as in the rollout/);

  // From inside Codex, braid finds the session by CODEX_THREAD_ID, which Codex gives the commands it runs, and the
  // rollout under CODEX_HOME. A commit the agent makes is noted in its conversation.
  r.turn("Thanks.", repo, false);
  const inCodex = { ...env, CODEX_THREAD_ID: ID };
  writeFileSync(join(repo, "b.ts"), "export const b = 2;\n");
  must(inCodex, repo, "git", ["add", "b.ts"]);
  must(inCodex, repo, "git", ["commit", "--quiet", "-m", "Add b.ts"]);
  assert.equal(braid(inCodex, repo, ["save"]).stdout, "braid: saved 4 records, up to 01a1d58a.3\n");
  assert.match(braid(env, repo, ["log", ID, "--records"]).stdout, /user {6}Thanks\.\n\S+ +code {6}Add b\.ts \([0-9a-f]{7}\)\n$/);
  // A fork asked for from inside Codex continues in Codex, as a branch of this conversation.
  const branch = braid(inCodex, repo, ["fork"]);
  assert.match(branch.stdout, /^braid: wrote this conversation as a new Codex session\. To continue it in a new window, run in a terminal:\n {2}cd \S+ && codex resume [0-9a-f-]{36}\n$/);

  // In Claude Code, as Claude Code writes a conversation: each response one message, results after it, Codex's own
  // context left behind, and what Codex wrote in the user's place a note. Codex's reasoning stays with OpenAI.
  const there = join(s.root, "there");
  mkdirSync(there);
  const claude = join(s.env.HOME!, ".claude");
  const f = braid(env, repo, ["fork", "01a1d58a", "--cwd", there]);
  assert.equal(f.status, 0, f.stderr);
  const fork = /claude --resume (\S+)$/m.exec(f.stdout)![1]!;
  assert.match(f.stdout, /^braid: wrote 01a1d58a as a new Claude Code session\./);
  const file = join(claude, "projects", realpathSync(there).replace(/[^A-Za-z0-9]/g, "-"), `${fork}.jsonl`);
  assert.deepEqual(claudeSaid(file), [
    "user: Fix the bug in a.ts.",
    'call call_a exec_command {"cmd":"cat a.ts"}',
    'call call_b exec_command {"cmd":"cat b.ts"}',
    "result call_a: Process exited with code 0\nOutput:\nexport const a = 1;\n",
    "result call_b: Process exited with code 1\nOutput:\ncat: b.ts: No such file\n",
    "assistant: a.ts is fine; b.ts is missing, so I add it.",
    'call call_p apply_patch {"input":"*** Begin Patch\\n*** Add File: b.ts\\n+export const b = 2;\\n*** End Patch\\n"}',
    "result call_p: Success. Updated the following files:\nA b.ts\n",
    "user: Now run the tests.",
    "note: <skill>\n<name>tests</name>\nRun npm test.\n</skill>",
    'call call_t exec_command {"cmd":"npm test"}',
    "result call_t: 1 failing",
    "assistant: One test fails.",
    "user: Thanks.",
  ]);
  // A response's lines share its id, and each line continues the one before.
  const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[1].message.id, lines[2].message.id);
  assert.notEqual(lines[2].message.id, lines[5].message.id);
  assert.deepEqual(lines.map((l, i) => l.parentUuid === (i ? lines[i - 1].uuid : null)), lines.map(() => true));
  assert.equal(lines.find((l) => l.message.content[0]?.tool_use_id === "call_t").message.content[0].is_error, true);

  // Into Codex again, Codex's own lines go out as it wrote them, its reasoning and bookkeeping too; only the
  // session_meta line names the new session and directory.
  const rollout = readFileSync(r.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const again = braid(env, repo, ["fork", "01a1d58a", "--to", "codex", "--cwd", there]);
  const againId = /codex resume (\S+)$/m.exec(again.stdout)![1]!;
  const rolloutOf = (id: string) =>
    readFileSync(join(codexHome, "sessions", readdirSync(join(codexHome, "sessions"), { recursive: true }).map(String).find((f) => f.endsWith(`${id}.jsonl`))!), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  const copy = rolloutOf(againId);
  // Paths move to the new directory, as in any fork.
  const moved = (l: unknown) => JSON.parse(JSON.stringify(l).split(repo).join(realpathSync(there)));
  assert.deepEqual(copy.slice(1), rollout.slice(1).map(moved));
  assert.deepEqual([copy[0].payload.id, copy[0].payload.cwd, copy[0].payload.cli_version], [againId, realpathSync(there), "0.169.0"]);

  // Continued in Claude Code and back into Codex: Codex's lines as it wrote them, then Claude's turn converted.
  const last = lines.at(-1);
  appendFileSync(file, JSON.stringify({ ...last, parentUuid: last.uuid, uuid: "c1aude00-0000-4000-8000-000000000001", type: "user", isMeta: undefined, message: { role: "user", content: "And in Claude?" }, timestamp: "2026-11-09T12:00:00.000Z" }) + "\n");
  appendFileSync(file, JSON.stringify({ ...last, parentUuid: "c1aude00-0000-4000-8000-000000000001", uuid: "c1aude00-0000-4000-8000-000000000002", type: "assistant", isMeta: undefined, message: { id: "msg_c1", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "thinking", thinking: "Signed.", signature: "c2ln" }, { type: "text", text: "Here too." }] }, timestamp: "2026-11-09T12:00:01.000Z" }) + "\n");
  braid(env, repo, ["hook", "stop"], JSON.stringify({ session_id: fork, transcript_path: file, cwd: there }));
  const hop = /codex resume (\S+)$/m.exec(braid(env, repo, ["fork", fork.slice(0, 8), "--to", "codex", "--cwd", there]).stdout)![1]!;
  const hopped = rolloutOf(hop);
  const said = (l: { type: string; payload: { type?: string; role?: string; content?: { text: string }[] } }) => `${l.payload.role}: ${l.payload.content?.map((c) => c.text).join("")}`;
  // The Claude session continued from "Thanks.", the Codex session's head when it was forked.
  const thanks = rollout.findIndex((l) => l.payload?.content?.[0]?.text === "Thanks.");
  assert.deepEqual(hopped.slice(1, thanks + 1), rollout.slice(1, thanks + 1).map(moved));
  assert.deepEqual(hopped.slice(thanks + 1).filter((l) => l.type === "response_item").map(said), ["user: And in Claude?", "assistant: Here too."]);
  assert.equal(hopped[0].payload.id, hop);

  // SessionEnd: Codex gives it three seconds, so braid saves and checks the session after the hook returns.
  r.assistant("You're welcome.");
  const stateFile = join(s.env.HOME!, ".braid", ".git", "braid", "sessions", `${ID}.json`);
  const checked = () => JSON.parse(readFileSync(stateFile, "utf8")).verified?.at;
  const before = checked();
  assert.equal(hook("session-end", r.path).status, 0);
  for (let i = 0; i < 100 && checked() === before; i++) spawnSync("sleep", ["0.1"]);
  assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")).verified?.ok, true);
  assert.match(braid(env, repo, ["log", ID, "--records"]).stdout, /assistant You're welcome\.\n$/);
});

test("a session continued in Codex is saved where it left off, and comes back to Claude Code", () => {
  const s = sandbox();
  const repo = clone(s, "kit", "kit@example.com");
  must(s.env, repo, "git", ["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  const codexHome = join(s.root, "codex");
  mkdirSync(codexHome);
  const env = { ...s.env, CODEX_HOME: codexHome };
  braid(env, repo, ["init"]);
  const t = new Transcript(s.root, ALICE);
  t.user("Plan the release.");
  const head = t.assistant("First, tag the version.");
  const hookIn = JSON.stringify({ session_id: ALICE, transcript_path: t.path, cwd: repo });
  braid(env, repo, ["hook", "session-start"], hookIn);
  braid(env, repo, ["hook", "stop"], hookIn);

  const r = braid(env, repo, ["fork", "5b0e2c1a", "--to", "codex", "--cwd", repo]);
  assert.equal(r.status, 0, r.stderr);
  const id = /codex resume (\S+)$/m.exec(r.stdout)![1]!;
  const file = join(codexHome, "sessions", readdirSync(join(codexHome, "sessions"), { recursive: true }).map(String).find((f) => f.endsWith(`${id}.jsonl`))!);
  const copied = readFileSync(file, "utf8").trim().split("\n").length;
  // Codex resumes the rollout braid wrote, and appends to it.
  const append = (type: string, payload: object) => appendFileSync(file, JSON.stringify({ timestamp: "2026-11-09T11:00:00.000Z", type, payload }) + "\n");
  append("event_msg", { type: "task_started", turn_id: "t1" });
  append("response_item", { type: "message", role: "developer", content: [{ type: "input_text", text: "<permissions instructions>\nWrite in the workspace.\n</permissions instructions>" }] });
  append("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: `<environment_context>\n  <cwd>${repo}</cwd>\n</environment_context>` }] });
  append("turn_context", { cwd: repo, model: "gpt-5.5", model_provider: "openai" });
  append("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Then what?" }] });
  append("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Then write the notes." }] });
  append("event_msg", { type: "task_complete", turn_id: "t1" });
  const codexIn = JSON.stringify({ session_id: id, transcript_path: file, cwd: repo, hook_event_name: "Stop" });
  braid(env, repo, ["hook", "session-start", "--agent", "codex"], codexIn);
  braid(env, repo, ["hook", "stop", "--agent", "codex"], codexIn);

  // The Codex session continues the conversation: it holds only what Codex added, from the Claude session's head.
  const sessions = braid(env, repo, ["sessions"]).stdout;
  assert.match(sessions, new RegExp(`${id.slice(0, 8)}\\s+conv 5b0e2c1a`));
  assert.deepEqual(
    braid(env, repo, ["log", id, "--records"]).stdout.split("\n").filter(Boolean).map((l) => l.replace(/^\S+\s+/, "")),
    ["user      Then what?", "assistant Then write the notes."],
  );
  const state = JSON.parse(readFileSync(join(s.env.HOME!, ".braid", ".git", "braid", "sessions", `${id}.json`), "utf8"));
  assert.deepEqual([state.harness, state.copied], ["codex", copied]);
  const saved = records(env, repo, storeOf(env, repo), `refs/sessions/${ALICE}/${id}`);
  assert.equal(saved.find((x) => x.type === "message")?.parentId === undefined, false);
  assert.equal(saved[0].parentId, head);
  assert.equal(saved[0].ext.braid.actor.userAgent, "codex");
  const v = braid(env, repo, ["verify", "--session", id]);
  assert.equal(v.status, 0, v.stdout);

  // Back in Claude Code: the Claude session's own lines, then what was said in Codex.
  const back = braid(env, repo, ["fork", id.slice(0, 8), "--cwd", repo]);
  assert.equal(back.status, 0, back.stderr);
  const fork = /claude --resume (\S+)$/m.exec(back.stdout)![1]!;
  const path = join(s.env.HOME!, ".claude", "projects", realpathSync(repo).replace(/[^A-Za-z0-9]/g, "-"), `${fork}.jsonl`);
  assert.deepEqual(claudeSaid(path), ["user: Plan the release.", "thinking", "assistant: First, tag the version.", "user: Then what?", "assistant: Then write the notes."]);
});

test("braid shows what a session is about: its title in the status line and braid status, and where it stands when it resumes", () => {
  const s = sandbox();
  const repo = clone(s, "ida", "ida@example.com");
  must(s.env, repo, "git", ["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  braid(s.env, repo, ["init"]);
  const t = new Transcript(s.root, ALICE);
  const hookIn = (source?: string) => JSON.stringify({ session_id: ALICE, transcript_path: t.path, cwd: repo, ...(source ? { source } : {}) });
  const statusline = (env: NodeJS.ProcessEnv = {}) => braid(s.env, repo, ["statusline"], JSON.stringify({ session_id: ALICE, workspace: { current_dir: repo } }), env).stdout.trim();
  const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
  const started = (out: string) => JSON.parse(out || "{}") as { systemMessage?: string };

  // Before Claude Code titles the session, its first prompt stands for it.
  t.user("<command-name>/braid:init</command-name>");
  t.user("Add retries to the webhook sender");
  t.assistant("Added exponential backoff with jitter.");
  braid(s.env, repo, ["hook", "stop"], hookIn());
  assert.equal(plain(statusline()), "braid · 5b0e2c1a.2 · Add retries to the webhook sender · local", "the newest turn by name: a command you typed is a turn too");

  // Claude Code's own title, then the recap it writes when you come back to the session.
  t.raw({ type: "ai-title", aiTitle: "Webhook retries with backoff", sessionId: ALICE });
  t.system("away_summary", "You're adding retries to the webhook sender; backoff is in, next is a time budget.");
  braid(s.env, repo, ["hook", "stop"], hookIn());
  assert.equal(statusline({ NO_COLOR: "1" }), "braid · 5b0e2c1a.2 · Webhook retries with backoff · local", "a title and a recap start no turn");
  assert.equal(statusline(), "\x1b[2mbraid\x1b[22m\x1b[2m · \x1b[22m5b0e2c1a.2\x1b[2m · \x1b[22mWebhook retries with backoff\x1b[2m · \x1b[22m\x1b[2mlocal\x1b[22m", "the label, separators and quiet marks dimmed");
  const status = braid(s.env, repo, ["status", "--session", ALICE]).stdout;
  assert.match(status, /\n {2}Webhook retries with backoff\n {2}recap, [^:]+: You're adding retries to the webhook sender; backoff is in, next is a time budget\.\n/);

  // Resuming shows what the session is about. Claude Code shows its own recap again, so braid adds none there.
  assert.equal(started(braid(s.env, repo, ["hook", "session-start"], hookIn("resume")).stdout).systemMessage, "braid · 5b0e2c1a.2 · Webhook retries with backoff");
  assert.equal(started(braid(s.env, repo, ["hook", "session-start"], hookIn("startup")).stdout).systemMessage, undefined, "a new session has nothing to recap");

  // A name you give with /rename wins over Claude Code's titles, also newer ones.
  t.raw({ type: "custom-title", customTitle: "retries-v2", sessionId: ALICE });
  t.raw({ type: "ai-title", aiTitle: "A newer title", sessionId: ALICE });
  braid(s.env, repo, ["hook", "stop"], hookIn());
  assert.equal(statusline({ NO_COLOR: "1" }), "braid · 5b0e2c1a.2 · retries-v2 · local");

  // A session saved before braid kept titles gets its own back from the store, the name you gave included.
  const statePath = join(s.env.HOME!, ".braid", ".git", "braid", "sessions", `${ALICE}.json`);
  const { title: _title, recap: _recap, ...older } = JSON.parse(readFileSync(statePath, "utf8"));
  writeFileSync(statePath, JSON.stringify(older));
  t.raw({ type: "ai-title", aiTitle: "Yet another title", sessionId: ALICE });
  braid(s.env, repo, ["hook", "stop"], hookIn());
  assert.equal(statusline({ NO_COLOR: "1" }), "braid · 5b0e2c1a.2 · retries-v2 · local");

  // A fork into Codex is about what its source was about. Codex writes no recaps, so braid shows Claude Code's latest.
  const codexHome = join(s.root, "codex");
  const r = braid(s.env, repo, ["fork", "5b0e2c1a", "--to", "codex"], undefined, { CODEX_HOME: codexHome });
  assert.equal(r.status, 0, r.stderr);
  const id = /codex resume (\S+)$/m.exec(r.stdout)![1]!;
  const codexIn = JSON.stringify({ session_id: id, cwd: repo, source: "resume", transcript_path: null });
  const inCodex = started(braid(s.env, repo, ["hook", "session-start", "--agent", "codex"], codexIn, { CODEX_HOME: codexHome }).stdout).systemMessage;
  assert.equal(inCodex?.split("\n")[0], `braid · ${id.slice(0, 8)}.2 · retries-v2, a fork of 5b0e2c1a.2`);
  assert.match(inCodex!, /\nLast recap, [^:]+: You're adding retries to the webhook sender; backoff is in, next is a time budget\.$/);
});

test("braid init keeps the status line that ran before braid, also over another braid's", () => {
  const s = sandbox();
  const repo = clone(s, "joe", "joe@example.com");
  must(s.env, repo, "git", ["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  const settings = join(s.env.HOME!, ".claude", "settings.json");
  mkdirSync(join(s.env.HOME!, ".claude"), { recursive: true });
  writeFileSync(settings, JSON.stringify({ statusLine: { type: "command", command: "echo mine" } }));
  braid(s.env, repo, ["init"]);
  const saved = join(s.env.XDG_CONFIG_HOME!, "braid", "statusline.json");
  assert.equal(JSON.parse(readFileSync(saved, "utf8")).previous, "echo mine");

  // A braid set up under another home left its own status line here: init keeps "echo mine" as the one before braid.
  writeFileSync(settings, JSON.stringify({ statusLine: { type: "command", command: "/tmp/elsewhere/.local/bin/braid statusline" } }));
  braid(s.env, repo, ["init"]);
  assert.equal(JSON.parse(readFileSync(saved, "utf8")).previous, "echo mine");
  const line = (env: NodeJS.ProcessEnv = {}) => braid(s.env, repo, ["statusline"], JSON.stringify({ session_id: ALICE, workspace: { current_dir: repo } }), { NO_COLOR: "1", ...env }).stdout.trim();
  assert.match(line(), /^mine · braid · 5b0e2c1a/);

  // And a previous line that is braid's own is never run before braid's.
  writeFileSync(saved, JSON.stringify({ previous: "/tmp/elsewhere/.local/bin/braid statusline" }));
  assert.match(line(), /^braid · 5b0e2c1a/);
});

test("autofork marks the point before a Codex turn that patches many files", () => {
  const s = sandbox();
  const repo = clone(s, "kim", "kim@example.com");
  must(s.env, repo, "git", ["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  const codexHome = join(s.root, "codex");
  const env = { ...s.env, CODEX_HOME: codexHome };
  braid(env, repo, ["init"]);
  const ID = "019a0000-0000-7000-8000-00000000c0de";
  const hook = (name: string, transcript: string | null) =>
    braid(env, repo, ["hook", name, "--agent", "codex"], JSON.stringify({ session_id: ID, transcript_path: transcript, cwd: repo, hook_event_name: name }));
  hook("session-start", null);
  const r = new Rollout(codexHome, ID, repo);
  r.turn("Look at the project.", repo);
  r.assistant("It has five modules.");
  r.end();
  hook("stop", r.path);
  // One patch, as apply_patch takes it, edits five files: the turn is big.
  r.turn("Rename the logger in every module.", repo, false);
  r.patch(`*** Begin Patch\n${["a", "b", "c", "d", "e"].map((m) => `*** Update File: src/${m}.ts\n@@\n-log\n+logger`).join("\n")}\n*** End Patch\n`, "call_p");
  r.output("call_p", "Success. Updated the following files:\nM src/a.ts\n", true);
  r.assistant("Renamed it in five files.");
  r.end();
  hook("stop", r.path);
  assert.match(braid(env, repo, ["log", ID]).stdout, /^019a0000\.2 +Rename the logger in every module\. +\(5 files edited, 1 tool call\)$/m);
  // The fork point autofork marked still works.
  assert.equal(braid(env, repo, ["fork", "@1", "--session", ID, "--to", "codex"]).status, 0);
});

test("every turn has a name, <session>.<n>: braid log lists them, braid fork and braid edit take them", () => {
  const s = sandbox();
  const repo = clone(s, "lea", "lea@example.com");
  must(s.env, repo, "git", ["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  braid(s.env, repo, ["init"]);
  const t = new Transcript(s.root, ALICE);
  const stop = (session: string, path: string) => braid(s.env, repo, ["hook", "stop"], JSON.stringify({ session_id: session, transcript_path: path, cwd: repo }));
  t.user("Plan the cache.");
  t.assistant("Keep it in memory, with a TTL.");
  t.user("Write the cache.");
  t.toolCall("Write", { file_path: join(repo, "cache.ts"), content: "export {}" }, "toolu_w1", "ok");
  t.toolCall("Edit", { file_path: join(repo, "app.ts"), old_string: "a", new_string: "b" }, "toolu_w2", "ok");
  t.assistant("Wrote cache.ts and used it in app.ts.");
  t.user("Thanks.");
  t.assistant("You're welcome.");
  stop(ALICE, t.path);

  // One line per turn: its name, the prompt, and what it did.
  const log = braid(s.env, repo, ["log", ALICE]).stdout;
  assert.deepEqual(log.split("\n").filter(Boolean), [
    "5b0e2c1a.1    Plan the cache.",
    "5b0e2c1a.2    Write the cache.  (2 files edited, 2 tool calls)",
    "5b0e2c1a.3    Thanks.",
  ]);
  assert.match(braid(s.env, repo, ["log", ALICE, "--records"]).stdout, /^5b0e2c1a\.2 +tool +ok$/m, "each record under its turn");
  const line = braid(s.env, repo, ["statusline"], JSON.stringify({ session_id: ALICE, workspace: { current_dir: repo } }), { NO_COLOR: "1" }).stdout;
  assert.match(line, /^braid · 5b0e2c1a\.3 · Plan the cache\. · local/);

  // A fork from the end of turn 2 holds turns 1 and 2, and continues as turn 3 of its own.
  const fork = braid(s.env, repo, ["fork", ".2", "--session", ALICE]);
  assert.equal(fork.status, 0, fork.stderr);
  assert.match(fork.stdout, /^braid: wrote the conversation up to 5b0e2c1a\.2 as a new Claude Code session\./);
  const id = /--resume (\S+)/.exec(fork.stdout)![1]!;
  const file = join(s.env.HOME!, ".claude", "projects", realpathSync(repo).replace(/[^A-Za-z0-9]/g, "-"), `${id}.jsonl`);
  const written = readFileSync(file, "utf8");
  assert.match(written, /Wrote cache\.ts and used it in app\.ts\./);
  assert.doesNotMatch(written, /Thanks\./);
  const last = JSON.parse(written.trim().split("\n").filter((l) => JSON.parse(l).uuid).at(-1)!).uuid;
  const more = (parentUuid: string, uuid: string, type: "user" | "assistant", content: unknown) =>
    appendFileSync(file, JSON.stringify({ parentUuid, isSidechain: false, type, uuid, timestamp: "2026-11-14T10:00:00.000Z", cwd: repo, sessionId: id, version: "2.1.319", message: type === "user" ? { role: "user", content } : { id: "msg_f", type: "message", role: "assistant", model: "claude-sonnet-5-5", content, stop_reason: "end_turn" } }) + "\n");
  more(last, "f0000000-0000-4000-8000-000000000001", "user", "Use an LRU instead.");
  more("f0000000-0000-4000-8000-000000000001", "f0000000-0000-4000-8000-000000000002", "assistant", [{ type: "text", text: "Switched to an LRU." }]);
  stop(id, file);
  assert.deepEqual(braid(s.env, repo, ["log", id]).stdout.split("\n").filter(Boolean), [
    "5b0e2c1a.1    Plan the cache.",
    "5b0e2c1a.2    Write the cache.  (2 files edited, 2 tool calls)",
    `${id.slice(0, 8)}.3    Use an LRU instead.`,
  ]);
  // A turn before the fork is found in the session it forks from; a name you gave works as the session's.
  assert.match(braid(s.env, repo, ["fork", `${id.slice(0, 8)}.1`, "--session", ALICE, "--new"]).stdout, /up to 5b0e2c1a\.1 as a new/);
  t.raw({ type: "custom-title", customTitle: "cache-work", sessionId: ALICE });
  stop(ALICE, t.path);
  assert.match(braid(s.env, repo, ["fork", "cache-work.3", "--session", id]).stdout, /up to 5b0e2c1a\.3 as a new/);
  assert.match(braid(s.env, repo, ["fork", ".9", "--session", ALICE]).stderr, /5b0e2c1a has no turn 9; braid log lists its turns/);

  // braid edit lists records under their turns, and withholds a whole turn by its number.
  const listing = braid(s.env, repo, ["edit", "--session", ALICE]).stdout;
  assert.match(listing, /\n5b0e2c1a\.2\n +\d+ +you +Write the cache\./);
  assert.equal(braid(s.env, repo, ["edit", ".3", "--session", ALICE]).status, 0);
  const after = braid(s.env, repo, ["edit", "--session", ALICE]).stdout;
  assert.match(after, /✗ you +Thanks\. +\[withheld\]/);
  assert.match(after, /✗ agent +You're welcome\. +\[withheld\]/);
  assert.doesNotMatch(after, /✗ you +Write the cache/);
});
