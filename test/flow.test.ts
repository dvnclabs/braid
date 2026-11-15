// End to end: braid's hooks save Claude Code and Codex sessions in the project's .braid folder, and the
// CLI forks, merges, logs and checks them. Every step goes through the CLI.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { braid, clone, must, Rollout, run, sandbox, saved, Transcript } from "./helpers.ts";

const ALICE = "5b0e2c1a-7f3d-4c2e-9a61-0d8e4b2f6c13";
const BOB = "01a1bc3e-e950-7c4b-9e7a-62f0e9a7c418";

test("a branch of a conversation waits in ↓ until it is merged back", () => {
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
  const status = (session: string) => braid(s.env, repo, ["status", "--session", session]).stdout;
  assert.match(status(ALICE), /^braid · 5b0e2c1a\.1 · Plan the cache\.\n/);

  // Claude Code's /branch copies the transcript under a new id; braid files the copy as a branch of the same conversation.
  const BRANCH = "7c1d2e3f-0000-4000-8000-0000000000aa";
  const tb = t.fork(s.root, BRANCH);
  tb.user("Try a TTL cache instead.");
  const ttl = tb.assistant("A TTL of 60 s fits.");
  braid(s.env, repo, ["hook", "stop"], hookIn(BRANCH, tb));
  const branch = saved(repo, BRANCH).filter((r) => r.type === "message");
  assert.deepEqual(branch.map((r) => r.id).at(-1), ttl);
  assert.equal(branch.length, 2, "the copied records are not saved twice");
  assert.equal(branch[0].parentId, lru, "the branch continues from where it was made");

  // braid fork prints how to branch in a new window; your own session forks with Claude Code itself.
  assert.match(braid(s.env, repo, ["fork", "--session", ALICE]).stdout, new RegExp(`\\n  cd /work && claude --resume ${ALICE} --fork-session\\n`));
  assert.match(braid(s.env, repo, ["fork", "7c1d2e3f", "--session", ALICE]).stdout, new RegExp(`\\n  cd /work && claude --resume ${BRANCH} --fork-session`));

  // Back in the first session, the branch waits in ↓ and merges like a review.
  assert.match(status(ALICE), /↓ 7c1d2e3f \(7c1d2e3f\) has 2 records this session has not merged/);
  const line = braid(s.env, repo, ["statusline"], JSON.stringify({ session_id: ALICE, workspace: { current_dir: repo } }), { NO_COLOR: "1" }).stdout.trim();
  assert.equal(line, "braid · 5b0e2c1a.1 · Plan the cache. · ↓ 7c1d2e3f +2 → /braid:merge");
  assert.match(braid(s.env, repo, ["merge", "--session", ALICE]).stdout, /TTL of 60 s/);
  const rec = braid(s.env, repo, ["merge", "--session", ALICE, "--record", "7c1d2e3f", "--instruction", "keep the LRU"], "Keep the LRU; the TTL idea is noted.");
  assert.equal(rec.status, 0, rec.stderr);
  t.user("/braid:merge keep the LRU");
  t.assistant("Kept the LRU.");
  braid(s.env, repo, ["hook", "stop"], hookIn(ALICE, t));
  assert.doesNotMatch(status(ALICE), /↓/);
  const merge = saved(repo, ALICE).find((r) => r.type === "branch_summary");
  assert.equal(merge.ext.braid.merge.heads[1], ttl);
});

test("subagents are saved with their session, in the same file", () => {
  const s = sandbox();
  const repo = clone(s, "fay", "fay@example.com");
  must(s.env, repo, "git", ["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  braid(s.env, repo, ["init"]);
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
  sub.add("assistant", { id: "m1", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: "Callers: billing, alerts, sync." }] }, { isSidechain: true, agentId: "a36fc26663a698234" });
  writeFileSync(join(dir, "agent-a36fc26663a698234.meta.json"), JSON.stringify({ agentType: "Explore", description: "Find webhook callers", toolUseId: "toolu_agent1" }));
  braid(s.env, repo, ["hook", "stop"], hookIn);

  const mine = saved(repo, ALICE);
  const link = mine.find((r) => r.type === "agent_link");
  assert.equal(link?.transcriptId, "a36fc26663a698234");
  assert.equal(link.toolCallId, "toolu_agent1");
  assert.equal(mine.find((r) => r.id === link.parentId)?.content?.[0]?.type, "tool_call", "linked from the call that spawned it");
  const agent = () => saved(repo, ALICE, "a36fc26663a698234");
  assert.deepEqual(agent().map((r) => r.role), ["user", "assistant"], "the subagent's records, in the session's file, marked with its id");

  // A later save adds only what the subagent wrote since, and links it once.
  sub.add("assistant", { id: "m2", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: "Also: retries." }] }, { isSidechain: true, agentId: "a36fc26663a698234" });
  braid(s.env, repo, ["hook", "stop"], hookIn);
  assert.equal(agent().length, 3);
  assert.equal(saved(repo, ALICE).filter((r) => r.type === "agent_link").length, 1, "linked once");
  assert.equal(braid(s.env, repo, ["verify", "--session", ALICE]).status, 0);
});

test("each project keeps its sessions in .braid, which git does not see; its worktrees share it; outside a repository, the folder's own", () => {
  const s = sandbox();
  const repo = clone(s, "ivy", "ivy@example.com");
  must(s.env, repo, "git", ["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  const init = braid(s.env, repo, ["init"]);
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /made \S+\/ivy\/\.braid: this project's conversations, one file each, which git does not see/);
  assert.equal(readFileSync(join(repo, ".braid", ".gitignore"), "utf8"), "# braid: conversations stay out of git.\n*\n");

  // A session in the main checkout: one file of records, one of state, and git sees nothing.
  const t = new Transcript(s.root, ALICE);
  const hookIn = (session: string, tr: Transcript, cwd: string) => JSON.stringify({ session_id: session, transcript_path: tr.path, cwd });
  braid(s.env, repo, ["hook", "session-start"], hookIn(ALICE, t, repo));
  t.user("Plan the cache.");
  t.assistant("An LRU.");
  braid(s.env, repo, ["hook", "stop"], hookIn(ALICE, t, repo));
  assert.deepEqual(readdirSync(join(repo, ".braid", "sessions")).filter((f) => f.startsWith(ALICE)).sort(), [`${ALICE}.json`, `${ALICE}.jsonl`]);
  assert.equal(must(s.env, repo, "git", ["status", "--porcelain"]), "", "git does not see the folder, and no file of the project changed");

  // A session in a worktree is kept in the main checkout's folder, with the worktree it ran in.
  const feature = join(s.root, "ivy-feature");
  must(s.env, repo, "git", ["worktree", "add", "--quiet", "-b", "feature", feature]);
  const tb = new Transcript(s.root, BOB);
  braid(s.env, feature, ["hook", "session-start"], hookIn(BOB, tb, feature));
  tb.user("Write the tests.");
  tb.assistant("Wrote them.");
  braid(s.env, feature, ["hook", "stop"], hookIn(BOB, tb, feature));
  assert.ok(existsSync(join(repo, ".braid", "sessions", `${BOB}.jsonl`)));
  assert.equal(existsSync(join(feature, ".braid")), false, "nothing in the worktree, which can go away");
  const sessions = braid(s.env, feature, ["sessions"]).stdout;
  assert.match(sessions, /^01a1bc3e\.1 +Write the tests\. +claude-code +just now, in ivy-feature$/m);
  assert.match(sessions, /^5b0e2c1a\.1 +Plan the cache\. +claude-code +just now$/m);
  assert.match(braid(s.env, feature, ["status", "--session", BOB]).stdout, /\n {2}ran in \S+\/ivy-feature\n/);
  assert.match(braid(s.env, feature, ["log", "5b0e2c1a"]).stdout, /^5b0e2c1a\.1 +Plan the cache\.$/m, "a worktree reads the project's sessions");

  // Outside any repository, a session is kept in the .braid folder of the folder it started in.
  const loose = join(s.root, "notes");
  mkdirSync(loose);
  const CAROL = "c0c0c0c0-0000-4000-8000-000000000001";
  const tc = new Transcript(s.root, CAROL);
  tc.user("Summarize my notes.");
  tc.assistant("Done.");
  braid(s.env, loose, ["hook", "stop"], hookIn(CAROL, tc, loose));
  assert.ok(existsSync(join(loose, ".braid", "sessions", `${CAROL}.jsonl`)));
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
  assert.match(init.stdout, /saved this conversation \(5b0e2c1a\.1\), 3 records, in \S+\/fay\/\.braid\/sessions\/5b0e2c1a-[0-9a-f-]+\.jsonl/);
  t.user("Thanks.");
  t.assistant("You're welcome.");
  assert.match(braid(s.env, repo, ["save"], undefined, claude).stdout, /saved 2 records/);
  // BRAID_SESSION set empty names no session, whatever Claude Code names.
  assert.match(braid(s.env, repo, ["save"], undefined, { ...claude, BRAID_SESSION: "" }).stderr, /no session/);
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
  assert.match(ok.stdout, /braid verify 5b0e2c1a\.12: ok\n {2}✓ saved: 25 records of the transcript\n {2}✓ loads: 25 lines, the same in a fork as in the transcript/);
  assert.equal(saved(repo, ALICE).filter((r) => r.id === early.uuid).length, 2, "each line is saved once");

  // A /branch copy whose first save spans several windows saves each record once.
  const BRANCH = "7c1d2e3f-0000-4000-8000-0000000000bb";
  const tb = t.fork(s.root, BRANCH);
  for (let i = 1; i <= 12; i++) {
    tb.user(`Branch step ${i}: ${"try ".repeat(60)}`);
    tb.assistant(`Branch step ${i} done.`);
  }
  braid(s.env, repo, ["hook", "stop"], hookIn(BRANCH, tb), small);
  const ids = saved(repo, BRANCH).map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, "no record saved twice");
  const branch = braid(s.env, repo, ["verify", "--session", BRANCH], undefined, small);
  assert.equal(branch.status, 0, branch.stdout);

  // A turn written since the last save, as in a session still running, is noted and is no problem: the next save takes it in.
  t.user("One more thing.");
  t.assistant("Noted.");
  const behind = braid(s.env, repo, ["verify", "--session", ALICE]);
  assert.equal(behind.status, 0, behind.stdout);
  assert.match(behind.stdout, /^braid verify 5b0e2c1a\.12: ok\n[\s\S]*\n {2}· 2 records written since the last save, which the next save takes in$/m);
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
  assert.match(r.stdout, /^braid: wrote 5b0e2c1a\.\d+ as a new Codex session\. To continue it in a new window, run in a terminal:\n {2}cd \S+\/elsewhere && CODEX_HOME=\S+\/codex codex resume [0-9a-f-]{36}\n$/, "a CODEX_HOME other than ~/.codex goes in the command");
  // The same fork asked for again is the same session; --new writes another.
  const twice = braid(s.env, repo, ["fork", "5b0e2c1a", "--to", "codex", "--cwd", elsewhere], undefined, { CODEX_HOME: codexHome });
  assert.match(twice.stdout, new RegExp(`^braid: 5b0e2c1a\\.\\d+ is already a Codex session, from an earlier fork\\. To continue it in a new window, run in a terminal:\\n {2}cd \\S+ && CODEX_HOME=\\S+ codex resume ${id}\\nbraid fork --new writes another\\.\\n$`));
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
  const added = saved(repo, id).filter((x) => x.type !== "transcript");
  assert.deepEqual(added.map((x) => x.content), ["Next."], "the copied lines are not saved again");
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
  assert.equal(braid(inCodex, repo, ["save"]).stdout, "braid: saved 3 records, up to 01a1d58a.3\n");
  assert.match(braid(env, repo, ["log", ID, "--records"]).stdout, /user {6}Thanks\.\n$/);
  // A fork asked for from inside Codex continues in Codex, as a branch of this conversation.
  const branch = braid(inCodex, repo, ["fork"]);
  assert.match(branch.stdout, /^braid: wrote this conversation as a new Codex session\. To continue it in a new window, run in a terminal:\n {2}cd \S+ && CODEX_HOME=\S+ codex resume [0-9a-f-]{36}\n$/);

  // In Claude Code, as Claude Code writes a conversation: each response one message, results after it, Codex's own
  // context left behind, and what Codex wrote in the user's place a note. Codex's reasoning stays with OpenAI.
  const there = join(s.root, "there");
  mkdirSync(there);
  const claude = join(s.env.HOME!, ".claude");
  const f = braid(env, repo, ["fork", "01a1d58a", "--cwd", there]);
  assert.equal(f.status, 0, f.stderr);
  const fork = /claude --resume (\S+)$/m.exec(f.stdout)![1]!;
  assert.match(f.stdout, /^braid: wrote 01a1d58a\.3 as a new Claude Code session\./);
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
  const stateFile = join(repo, ".braid", "sessions", `${ID}.json`);
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
  assert.match(sessions, new RegExp(`^${id.slice(0, 8)}\\.2 .* codex +just now, in 5b0e2c1a's conversation$`, "m"));
  assert.deepEqual(
    braid(env, repo, ["log", id, "--records"]).stdout.split("\n").filter(Boolean).map((l) => l.replace(/^\S+\s+/, "")),
    ["user      Then what?", "assistant Then write the notes."],
  );
  const state = JSON.parse(readFileSync(join(repo, ".braid", "sessions", `${id}.json`), "utf8"));
  assert.deepEqual([state.harness, state.copied], ["codex", copied]);
  const kept = saved(repo, id);
  assert.equal(kept.find((x) => x.type === "message")?.parentId === undefined, false);
  assert.equal(kept[0].parentId, head);
  assert.equal(kept[0].ext.braid.actor.userAgent, "codex");
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
  assert.equal(plain(statusline()), "braid · 5b0e2c1a.2 · Add retries to the webhook sender", "the newest turn by name: a command you typed is a turn too");

  // Claude Code's own title, then the recap it writes when you come back to the session.
  t.raw({ type: "ai-title", aiTitle: "Webhook retries with backoff", sessionId: ALICE });
  t.system("away_summary", "You're adding retries to the webhook sender; backoff is in, next is a time budget.");
  braid(s.env, repo, ["hook", "stop"], hookIn());
  assert.equal(statusline({ NO_COLOR: "1" }), "braid · 5b0e2c1a.2 · Webhook retries with backoff", "a title and a recap start no turn");
  assert.equal(statusline(), "\x1b[2mbraid\x1b[22m\x1b[2m · \x1b[22m5b0e2c1a.2\x1b[2m · \x1b[22mWebhook retries with backoff", "the label and separators dimmed");
  const status = braid(s.env, repo, ["status", "--session", ALICE]).stdout;
  assert.match(status, /^braid · 5b0e2c1a\.2 · Webhook retries with backoff\n {2}recap, [^:]+: You're adding retries to the webhook sender; backoff is in, next is a time budget\.\n/);

  // Resuming shows what the session is about. Claude Code shows its own recap again, so braid adds none there.
  assert.equal(started(braid(s.env, repo, ["hook", "session-start"], hookIn("resume")).stdout).systemMessage, "braid · 5b0e2c1a.2 · Webhook retries with backoff");
  assert.equal(started(braid(s.env, repo, ["hook", "session-start"], hookIn("startup")).stdout).systemMessage, undefined, "a new session has nothing to recap");

  // A name you give with /rename wins over Claude Code's titles, also newer ones.
  t.raw({ type: "custom-title", customTitle: "retries-v2", sessionId: ALICE });
  t.raw({ type: "ai-title", aiTitle: "A newer title", sessionId: ALICE });
  braid(s.env, repo, ["hook", "stop"], hookIn());
  assert.equal(statusline({ NO_COLOR: "1" }), "braid · 5b0e2c1a.2 · retries-v2");

  // A session saved before braid kept titles gets its own back from the store, the name you gave included.
  const statePath = join(repo, ".braid", "sessions", `${ALICE}.json`);
  const { title: _title, recap: _recap, ...older } = JSON.parse(readFileSync(statePath, "utf8"));
  writeFileSync(statePath, JSON.stringify(older));
  t.raw({ type: "ai-title", aiTitle: "Yet another title", sessionId: ALICE });
  braid(s.env, repo, ["hook", "stop"], hookIn());
  assert.equal(statusline({ NO_COLOR: "1" }), "braid · 5b0e2c1a.2 · retries-v2");

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
  const previousFile = join(s.env.XDG_CONFIG_HOME!, "braid", "statusline.json");
  assert.equal(JSON.parse(readFileSync(previousFile, "utf8")).previous, "echo mine");

  // A braid set up under another home left its own status line here: init keeps "echo mine" as the one before braid.
  writeFileSync(settings, JSON.stringify({ statusLine: { type: "command", command: "/tmp/elsewhere/.local/bin/braid statusline" } }));
  braid(s.env, repo, ["init"]);
  assert.equal(JSON.parse(readFileSync(previousFile, "utf8")).previous, "echo mine");
  const line = (env: NodeJS.ProcessEnv = {}) => braid(s.env, repo, ["statusline"], JSON.stringify({ session_id: ALICE, workspace: { current_dir: repo } }), { NO_COLOR: "1", ...env }).stdout.trim();
  assert.match(line(), /^mine · braid · 5b0e2c1a/);

  // And a previous line that is braid's own is never run before braid's.
  writeFileSync(previousFile, JSON.stringify({ previous: "/tmp/elsewhere/.local/bin/braid statusline" }));
  assert.match(line(), /^braid · 5b0e2c1a/);
});

test("every turn has a name, <session>.<n>: braid log lists them, and braid fork takes them", () => {
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
  assert.match(line, /^braid · 5b0e2c1a\.3 · Plan the cache\.$/m);

  // A fork from the end of turn 2 holds turns 1 and 2, and continues as turn 3 of its own.
  const fork = braid(s.env, repo, ["fork", ".2", "--session", ALICE]);
  assert.equal(fork.status, 0, fork.stderr);
  assert.match(fork.stdout, /^braid: wrote the conversation up to 5b0e2c1a\.2 as a new Claude Code session\./);
  assert.match(fork.stdout, /&& claude --resume /, "Claude Code's own home needs no setting");
  // A CLAUDE_CONFIG_DIR other than ~/.claude, as a profile of Orca's sets, goes in the command, so any terminal finds the session.
  const profile = join(s.root, "profile with space");
  const elsewhere = braid(s.env, repo, ["fork", ".2", "--session", ALICE], undefined, { CLAUDE_CONFIG_DIR: profile });
  assert.match(elsewhere.stdout, new RegExp(`&& CLAUDE_CONFIG_DIR='${profile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}' claude --resume [0-9a-f-]{36}`));
  assert.equal(readdirSync(join(profile, "projects")).length, 1, "and the fork is written there");
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

});
test("braid migrate moves conversations from braid 0.1's ~/.braid into the projects they ran in", () => {
  const s = sandbox();
  const repo = clone(s, "max", "max@example.com");
  must(s.env, repo, "git", ["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  // braid 0.1's layout: a git store in ~/.braid, each session a ref whose tree holds its records in chunks, and its state beside it.
  const home = join(s.env.HOME!, ".braid");
  const store = join(home, ".git", "braid", "store");
  must(s.env, s.root, "git", ["init", "--quiet", home]);
  must(s.env, s.root, "git", ["init", "--quiet", "--bare", store]);
  const g = (args: string[], input?: string) => must(s.env, s.root, "git", ["--git-dir", store, ...args], input).trim();
  const rec = (id: string, parentId: string | null, role: string, content: string) => JSON.stringify({ type: "message", id, parentId, role, content, ext: { braid: { session: ALICE } } });
  const blob = (text: string) => g(["hash-object", "-w", "--stdin"], text);
  const chunk1 = blob(`${rec("u1", null, "user", "Plan the cache.")}\n${rec("a1", "u1", "assistant", "An LRU.")}\n`);
  const chunk2 = blob(`${rec("u2", "a1", "user", "Thanks.")}\n`);
  const agent = blob(`${JSON.stringify({ type: "message", id: "s1", parentId: null, role: "user", content: "List callers", ext: { braid: { agent: "a36f" } } })}\n`);
  const records = g(["mktree"], `100644 blob ${chunk1}\t000001.jsonl\n100644 blob ${chunk2}\t000002.jsonl\n`);
  const agentDir = g(["mktree"], `100644 blob ${agent}\t000001.jsonl\n`);
  const agents = g(["mktree"], `040000 tree ${agentDir}\ta36f\n`);
  const root = g(["mktree"], `040000 tree ${records}\trecords\n040000 tree ${agents}\tagents\n`);
  const commit = g(["commit-tree", root, "-m", "save 2"]);
  g(["update-ref", `refs/sessions/${ALICE}/${ALICE}`, commit]);
  mkdirSync(join(home, ".git", "braid", "sessions"), { recursive: true });
  writeFileSync(join(home, ".git", "braid", "sessions", `${ALICE}.json`), JSON.stringify({ session: ALICE, conv: ALICE, harness: "claude-code", chunks: 2, code: repo, published: {}, title: { text: "cache-work", by: "user" } }));

  const moved = braid(s.env, s.root, ["migrate"]);
  assert.equal(moved.status, 0, moved.stderr);
  assert.match(moved.stdout, /^braid: moved 1 session into \S+\/max\/\.braid$/m);
  assert.deepEqual(saved(repo, ALICE).map((r) => r.content), ["Plan the cache.", "An LRU.", "Thanks."]);
  assert.deepEqual(saved(repo, ALICE, "a36f").map((r) => r.content), ["List callers"]);
  const state = JSON.parse(readFileSync(join(repo, ".braid", "sessions", `${ALICE}.json`), "utf8"));
  assert.equal(state.published, undefined, "what braid 0.1 kept for publishing stays behind");
  assert.equal(state.title.text, "cache-work");
  assert.match(braid(s.env, repo, ["log", "cache-work"]).stdout, /^5b0e2c1a\.1 +Plan the cache\.\n5b0e2c1a\.2 +Thanks\.\n$/);
  // Run again, it moves nothing twice.
  assert.match(braid(s.env, s.root, ["migrate"]).stdout, /left 1 session already moved as it is/);
  assert.equal(saved(repo, ALICE).length, 3);
});
