// End to end: two people, one remote. Alice works and pushes, Bob reviews,
// Alice merges the review. Every step goes through the CLI and real git.
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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

  // braid init: config, store, hooks. No gh here, so git push does not publish; turn it on.
  const init = braid(s.env, alice, ["init"]);
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /autocommit = false, autopush = false: visibility unknown/);
  writeFileSync(join(alice, ".braid", "config.toml"), 'autopush = true\nremote = "origin"\n');
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
  const review = braid(s.env, alice, ["review", "--session", ALICE]);
  assert.equal(review.status, 0, review.stderr);
  assert.match(review.stdout, /3 records, nothing committed yet, 0 withheld, 1 redacted/);
  assert.match(review.stdout, /\n 1 +you +Add retries to sendWebhook\. My key is \[REDACTED:aws-access-key\]\.\n 2 +agent +Added 3 retries[^\n]*\n 3 +code +Retry webhooks \([0-9a-f]{7}\)\n/);
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

test("braid review withholds and hides parts of a session, also after they are published", () => {
  const s = sandbox();
  const repo = clone(s, "carol", "carol@example.com");
  must(s.env, repo, "git", ["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  braid(s.env, repo, ["init", "--autopush"]);
  const t = new Transcript(s.root, ALICE);
  const hookIn = JSON.stringify({ session_id: ALICE, transcript_path: t.path, cwd: repo });
  braid(s.env, repo, ["hook", "session-start"], hookIn);
  t.user("Fix the Acme Corp import.");
  t.toolCall("Read", { file_path: "notes.txt" }, "toolu_n1", "login: carol / hunter2");
  t.assistant("Fixed the import.");
  braid(s.env, repo, ["hook", "stop"], hookIn);

  const list = braid(s.env, repo, ["review", "--session", ALICE]).stdout;
  assert.match(list, /\n 1 +you +Fix the Acme Corp import\.\n 2 +agent +→ Read notes\.txt\n 3 +tool +login: carol \/ hunter2\n 4 +agent +Fixed the import\.\n/);
  braid(s.env, repo, ["commit", "-m", "Import fix", "--session", ALICE]);
  assert.match(braid(s.env, repo, ["push", "--session", ALICE]).stdout, /published 5b0e2c1a, 4 records/);
  const remote = join(s.root, "remote.git");
  const ref = `refs/braid/sessions/${ALICE}/${ALICE}`;
  assert.match(JSON.stringify(records(s.env, s.root, remote, ref)), /hunter2/);

  // Edits name the session: outside an agent session, braid review only reads.
  assert.match(braid(s.env, repo, ["review", "2"]).stderr, /name the session to edit/);

  // Withholding the call takes its result along; the text is hidden everywhere. Both were published.
  const w = braid(s.env, repo, ["review", "2", "--session", ALICE]);
  assert.equal(w.status, 0, w.stderr);
  assert.match(w.stdout, /2 records withheld:\n +2 agent +→ Read notes\.txt\n +3 tool +login/);
  assert.match(w.stdout, /2 of them are already published: the next push replaces the published copy/);
  assert.match(braid(s.env, repo, ["review", "--text", "acme corp", "--session", ALICE]).stdout, /"acme corp" hidden in 1 records/);
  const after = braid(s.env, repo, ["review", "--session", ALICE]).stdout;
  assert.match(after, /Hidden text: "acme corp"/);
  assert.match(after, /\n 2 ✗ agent +→ Read notes\.txt {2}\[withheld\]\n/);
  assert.match(after, /\n 1 +you +Fix the \[REDACTED:term\] import\.\n/);

  // A record's text can be rewritten: from stdin here, in an editor on a terminal. A tool call has no text to rewrite.
  const edited = braid(s.env, repo, ["review", "--edit", "4", "--session", ALICE], "Fixed the import for the client.\n");
  assert.match(edited.stdout, /4 edited; it is already published/, edited.stderr);
  assert.match(braid(s.env, repo, ["review", "--edit", "2", "--session", ALICE], "x").stderr, /2 is a tool call/);
  assert.match(braid(s.env, repo, ["review", "--session", ALICE]).stdout, /\n 4 ✎ agent +Fixed the import for the client\.\n/);

  // The next push replaces the published copy, without the history that held the old one.
  const push = braid(s.env, repo, ["push", "--session", ALICE]).stdout;
  assert.match(push, /replaced 4 records published before/);
  const text = JSON.stringify(records(s.env, s.root, remote, ref));
  assert.doesNotMatch(text, /hunter2|Acme Corp|notes\.txt/);
  assert.match(text, /Fixed the import for the client\./);
  assert.equal(must(s.env, s.root, "git", ["--git-dir", remote, "rev-list", "--count", ref]).trim(), "1");

  // Putting back the result puts back its call too.
  assert.match(braid(s.env, repo, ["review", "--undo", "3", "--session", ALICE]).stdout, /2 records put back/);
  assert.doesNotMatch(braid(s.env, repo, ["review", "--session", ALICE]).stdout, /\n *\d+ ✗/);

  // --last withholds by time, and --undo --last puts the same records back.
  assert.match(braid(s.env, repo, ["review", "--last", "3650d", "--session", ALICE]).stdout, /\d+ records withheld/);
  const back = braid(s.env, repo, ["review", "--undo", "--last", "3650d", "--session", ALICE]).stdout;
  assert.match(back, /\d+ records put back/);
  assert.doesNotMatch(braid(s.env, repo, ["review", "--session", ALICE]).stdout, /\n *\d+ ✗/);

  // --all keeps the whole session back.
  assert.match(braid(s.env, repo, ["review", "--all", "--session", ALICE]).stdout, /will not be published/);
  assert.match(braid(s.env, repo, ["push", "--session", ALICE]).stdout, /not published: private/);
  braid(s.env, repo, ["review", "--undo", "--all", "--session", ALICE]);
  assert.match(braid(s.env, repo, ["push", "--session", ALICE]).stdout, /published 5b0e2c1a/);
});

test("commit, branch, and merge the branch back", () => {
  const s = sandbox();
  const repo = clone(s, "dana", "dana@example.com");
  must(s.env, repo, "git", ["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  braid(s.env, repo, ["init"]);
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
  const store = join(repo, ".git", "braid", "store");
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
  assert.equal(braid(s.env, repo, ["init", "--no-git-hooks"]).status, 0);
  assert.match(readFileSync(join(repo, ".braid", "config.toml"), "utf8"), /^git-hooks = false$/m);
  const t = new Transcript(s.root, ALICE);
  const hookIn = JSON.stringify({ session_id: ALICE, transcript_path: t.path, cwd: repo });
  braid(s.env, repo, ["hook", "session-start"], hookIn);
  assert.equal(existsSync(join(repo, ".git", "hooks", "pre-push")), false);
  t.user("hi");
  t.assistant("hello");
  braid(s.env, repo, ["hook", "stop"], hookIn);

  // Turned on later, the hooks link the agent's commits again.
  braid(s.env, repo, ["init", "--git-hooks"]);
  assert.match(readFileSync(join(repo, ".git", "hooks", "pre-push"), "utf8"), /braid hook/);
  must({ ...s.env, BRAID_SESSION: ALICE }, repo, "git", ["commit", "--quiet", "--allow-empty", "-m", "linked"]);
  assert.match(must(s.env, repo, "git", ["log", "-1", "--format=%B"]), new RegExp(`Braid-Session: ${ALICE}`));
  braid(s.env, repo, ["init", "--no-git-hooks"]);
  assert.equal(existsSync(join(repo, ".git", "hooks", "pre-push")), false);
});

test("subagents are saved, published and briefed with their session", () => {
  const s = sandbox();
  const repo = clone(s, "fay", "fay@example.com");
  must(s.env, repo, "git", ["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  braid(s.env, repo, ["init", "--autopush"]);
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

  const store = join(repo, ".git", "braid", "store");
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
  assert.match(braid(s.env, repo, ["review", "--session", ALICE]).stdout, /\n +4 +spawn +→ subagent a36fc26663a698234 \(Explore\): Find webhook callers\n4\.1 +prompt +List callers\n/);
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
});

test("a session publishes to each repository it commits in", () => {
  const s = sandbox();
  const bare = (name: string) => must(s.env, s.root, "git", ["init", "--quiet", "--bare", "--initial-branch=main", `${name}.git`]);
  const setUp = (dir: string, remote: string) => {
    must(s.env, s.root, "git", ["clone", "--quiet", join(s.root, `${remote}.git`), dir]);
    must(s.env, dir, "git", ["config", "user.email", "gus@example.com"]);
    must(s.env, dir, "git", ["commit", "--quiet", "--allow-empty", "-m", "initial"]);
    braid(s.env, dir, ["init"]);
    writeFileSync(join(dir, ".braid", "config.toml"), "autopush = true\nautocommit = true\n");
    must(s.env, dir, "git", ["add", ".braid"]);
    must(s.env, dir, "git", ["commit", "--quiet", "-m", "Set up braid"]);
    must(s.env, dir, "git", ["push", "--quiet", "origin", "HEAD:main"]);
  };
  bare("b");
  bare("c");
  const a = clone(s, "a", "gus@example.com");
  must(s.env, a, "git", ["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  braid(s.env, a, ["init"]);
  writeFileSync(join(a, ".braid", "config.toml"), "autopush = true\nautocommit = true\n");
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

  // A has no commit from the session, so pushing A publishes nothing.
  must(s.env, a, "git", ["push", "--quiet", "origin", "HEAD:main"]);
  assert.equal(published("remote"), "");
});

test("with link = store, commits carry no trailer and still lead to their sessions", () => {
  const s = sandbox();
  const alice = clone(s, "alice", "alice@example.com");
  must(s.env, alice, "git", ["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  braid(s.env, alice, ["init"]);
  writeFileSync(join(alice, ".braid", "config.toml"), 'autopush = true\nlink = "store"\n');
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
  const bob = clone(s, "bob", "bob@example.com");
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
  braid(s.env, repo, ["init", "--autopush"]);
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
  braid(s.env, a, ["init", "--autopush"]);
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
  const store = join(b, ".git", "braid", "store");
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
  braid(s.env, repo, ["init"]);
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
  const store = join(repo, ".git", "braid", "store");
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
  braid(s.env, repo, ["init", "--autopush"]);
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
  assert.match(braid(s.env, repo, ["review", "--session", ALICE]).stdout, /✗ agent +→ Read \S*\/\.env {2}\[\.braidignore \.env\]/);

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
