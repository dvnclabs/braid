// End to end: two people, one remote. Alice works and pushes, Bob reviews,
// Alice merges the review. Every step goes through the CLI and real git.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

  // Bob forks Alice's session: he reads it as quoted material and his session continues from it.
  const load = braid(s.env, bob, ["fork", "5b0e2c1a"], undefined, { BRAID_SESSION: BOB });
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
  const commitLabel = mine.find((r) => r.type === "label" && r.ext?.braid?.commit);
  assert.equal(commitLabel?.label, "Retry webhooks", "the agent's git commit committed the conversation too");
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
  braid(s.env, repo, ["init"]);
  writeFileSync(join(repo, ".braid", "config.toml"), 'publish = "on-push"\n');
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

  // Published with the session, redacted.
  must(s.env, repo, "git", ["push", "--quiet", "origin", "HEAD:main"]);
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
    writeFileSync(join(dir, ".braid", "config.toml"), 'publish = "on-push"\n');
    must(s.env, dir, "git", ["add", ".braid"]);
    must(s.env, dir, "git", ["commit", "--quiet", "-m", "Set up braid"]);
    must(s.env, dir, "git", ["push", "--quiet", "origin", "HEAD:main"]);
  };
  bare("b");
  bare("c");
  const a = clone(s, "a", "gus@example.com");
  must(s.env, a, "git", ["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  braid(s.env, a, ["init"]);
  writeFileSync(join(a, ".braid", "config.toml"), 'publish = "on-push"\n');
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

  // Pushing B and C publishes the session to each; the Stop hook kept their copies current.
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
  writeFileSync(join(alice, ".braid", "config.toml"), 'publish = "on-push"\nlink = "store"\n');
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

  // git push publishes the session, found through the commit, not a trailer.
  const push = run(s.env, alice, "git", ["push", "origin", "retries"]);
  assert.match(push.stderr, /braid: published 5b0e2c1a/);
  const published = records(s.env, s.root, join(s.root, "remote.git"), `refs/braid/sessions/${ALICE}/${ALICE}`);
  assert.deepEqual(
    published.filter((r) => r.type === "label").map((r) => r.ext.braid.commit.sha).sort(),
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
  braid(s.env, repo, ["init", "--publish", "on-push"]);
  writeFileSync(join(repo, ".braid", "redact.toml"), 'terms = ["Acme Corp"]\nwithhold = ["customers/**"]\n');
  must(s.env, repo, "git", ["add", ".braid"]);
  must(s.env, repo, "git", ["commit", "--quiet", "-m", "Set up braid"]);
  must(s.env, repo, "git", ["push", "--quiet", "origin", "HEAD:main"]);
  must(s.env, repo, "git", ["fetch", "--quiet", "origin"]);

  // Rules on a feature branch do not count: they come from the default branch.
  must(s.env, repo, "git", ["checkout", "--quiet", "-b", "feature"]);
  writeFileSync(join(repo, ".braid", "redact.toml"), "terms = []\n");
  must(s.env, repo, "git", ["commit", "--quiet", "-am", "Drop the rules"]);

  const t = new Transcript(s.root, ALICE);
  const hookIn = JSON.stringify({ session_id: ALICE, transcript_path: t.path, cwd: repo });
  braid(s.env, repo, ["hook", "session-start"], hookIn);
  t.user("Summarize the Acme Corp contract.");
  t.toolCall("Read", { file_path: join(repo, "customers", "x.md") }, "toolu_read1", "Contract terms: pays 1M a year.");
  t.assistant("Acme Corp pays 1M a year.");
  braid(s.env, repo, ["hook", "stop"], hookIn);

  const dry = braid(s.env, repo, ["push", "--dry-run", "--session", ALICE]);
  assert.match(dry.stdout, /would publish 2 records/);
  assert.match(dry.stdout, /redacted: term 2/);
  assert.match(dry.stdout, /withheld: customers\/\*\* 1/);
  assert.match(dry.stdout, /rules: built in, \.braid\/redact\.toml on origin\/main/);
  const remote = join(s.root, "remote.git");
  assert.equal(must(s.env, s.root, "git", ["--git-dir", remote, "for-each-ref", "refs/braid/"]).trim(), "", "a dry run pushes nothing");

  assert.match(braid(s.env, repo, ["push", "--session", ALICE]).stdout, /published 5b0e2c1a/);
  const text = JSON.stringify(records(s.env, s.root, remote, `refs/braid/sessions/${ALICE}/${ALICE}`));
  assert.doesNotMatch(text, /Contract terms|Acme Corp|customers\/x\.md/);
  assert.match(text, /\[REDACTED:term\] pays 1M a year/);

  // Your own default wins: publish = "off" in ~/.config/braid/config.toml.
  mkdirSync(join(s.env.XDG_CONFIG_HOME!, "braid"), { recursive: true });
  writeFileSync(join(s.env.XDG_CONFIG_HOME!, "braid", "config.toml"), 'publish = "off"\n');
  t.user("more");
  braid(s.env, repo, ["hook", "stop"], hookIn);
  assert.match(braid(s.env, repo, ["push", "--session", ALICE]).stdout, /not published: publishing is off in ~\/\.config\/braid\/config\.toml/);
});
