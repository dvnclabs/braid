# Design

braid is a design draft. This document describes how it is meant to work. The [README](../README.md) covers installation and use.

- [Model](#model)
- [Storage](#storage)
- [Publishing](#publishing)
- [Trust](#trust)
- [Status](#status)
- [Merge, load and review](#merge-load-and-review)
- [Format](#format)
- [Harnesses](#harnesses)
- [CLI](#cli)
- [Prior art](#prior-art)
- [Roadmap](#roadmap)

## Model

A **conversation** is a tree of records written by people, agents and tools. Records are appended and never edited.

A **session** is what one harness writes under one session id: a Claude Code session, a Codex thread. Each session is a branch of the tree. Its records are the ones it wrote, and its **head** is the newest of them. braid names a session by its harness id, shortened as git shortens commit hashes: the shortest unique prefix, at least 8 characters (`5b0e2c1a`). A session can also have a name such as `review/bob`, stored as a label on its first record. Names can repeat; ids cannot.

The conversation is named after the session that started it. A session that loads another during its first turn forks from it, so its first record's parent is the head it loaded. A session that loads one later links to it with an `agent_link` record. A rewind inside a session also forks, and both branches stay in the tree.

Every record has an author: the **actor**, a person or account (`alice@example.com`), and the **user agent**, the software that wrote it (`claude-code/2.1`). braid matches participants on the actor and the product name, so upgrading Claude Code does not turn Alice into a new participant.

**Record ids** come from the harness where it assigns them; Claude Code gives every entry a uuid. Otherwise braid derives the id from the session id and the record's byte offset in the native file, so importing the same file twice yields the same ids.

A **merge** brings one branch into another. An LLM reads the merge base and each branch since the base, then writes a summary that follows an instruction. braid records the summary with the base, the heads, the instruction and the model. When two branches share no base, as with two independent sessions behind one pull request, the merge summarizes each branch from its root. **Reconcile** is the structural counterpart: it unions copies of the same records deterministically, with no LLM, following ATXF's reconciliation rules.

A **projection** renders a branch for one reader in one harness:

| Mode | Target | What the reader gets |
|---|---|---|
| replay | the harness that wrote the session | the native records, resumed as a session |
| briefing | any harness | a summary: goal, decisions and reasons, open questions, files, commands and results |

## Storage

### Where sessions live

| Location | Holds |
|---|---|
| `.git/braid/store`, a separate bare repository, ref `refs/sessions/<conversation>/<session>` | your sessions as written, unredacted |
| `refs/braid/sessions/<conversation>/<session>` on the remote | published sessions: redacted, with withheld records removed |
| `refs/braid/remotes/origin/sessions/<conversation>/<session>` in your clone | the last fetched copy of each published session |

The unredacted store sits outside the repository's refs, so no git command can push it by accident, `git push --mirror` included. The repository itself only ever holds copies that were already published.

A session ref holds only the records that session wrote. The conversation is the union of its sessions, and reading it reconciles them. Each person publishes only their own sessions, and continuing someone else's session always starts a new one, so every ref has a single writer. When one session is continued on two machines, its native file is stored in per-machine segments and published with `--force-with-lease`.

### Saving

A harness hook saves at the end of each turn. It reads the native file from the byte offset where the previous save stopped, converts the new lines with [ATXF](https://github.com/leostera/atxf)'s converters, and commits one chunk to the session's ref in the store:

```
records/000001.jsonl    ATXF records, in the order written
raw/000001              the native file, as a byte range
meta/000001.json        HEAD and the working tree's tree id at this save
records/000002.jsonl
raw/000002
meta/000002.json
```

Earlier chunks are kept as they are, so a save costs about the size of what the turn added, and concatenating the chunks gives back the records and the native file byte for byte. braid runs `git gc --auto` on the store after saving. Harnesses delete old transcripts (Claude Code after 30 days by default), and the store keeps them.

### Code commits

Code commits point to sessions with a trailer:

```
Braid-Session: 5b0e2c1a-7f3d-4c2e-9a61-0d8e4b2f6c13
```

| Git hook | What it does |
|---|---|
| `prepare-commit-msg` | adds the trailer, with `git interpret-trailers --if-exists addIfDifferent` |
| `post-commit` | saves the session and records the code commit's hash in that save, so the commit points to the exact state of the conversation behind it |
| `post-rewrite` | carries those links over after `git commit --amend` and `git rebase` |
| `pre-push` | publishes the sessions behind the commits being pushed |

How the hook knows which session made a commit:

- **The agent ran `git commit`.** At session start, braid puts `BRAID_SESSION=<id>` into the environment of the agent's shell commands. Claude Code's `SessionStart` hook does this through `CLAUDE_ENV_FILE`. The hook links that session.
- **You ran `git commit` yourself.** The hook links each session in this worktree whose edits since the previous commit touch the committed files. Sessions that did not edit those files stay unlinked.

Parallel agents usually run in separate worktrees, which keeps the second case unambiguous. braid chains with existing hooks, including hook managers that set `core.hooksPath`, such as husky and lefthook.

GitHub's default squash message lists the original commit messages, so the trailers survive as text unless the repository uses the pull request title as the squash message or the person merging edits it. braid also reads the trailers of the pull request's own commits.

### Fetching

braid fetches only the conversations behind the current branch's commits. It runs in the background, under a lock, at most every few minutes:

```sh
git fetch --no-write-fetch-head --no-auto-gc origin \
  '+refs/braid/sessions/<conversation>/*:refs/braid/remotes/origin/sessions/<conversation>/*'
```

braid adds nothing to `remote.origin.fetch`, so a plain `git fetch`, and an editor's background fetch, cost what they did before. `braid prune` drops fetched sessions of branches that were merged or closed.

## Publishing

`git push` publishes the sessions behind the pushed commits. The pre-push hook builds each published commit from the store and the rules below, then pushes it with `--no-verify` so the hook does not run itself again. It stays quiet unless something needs a decision, and in that case it stops the push and says why. It also refuses pushes that would delete session refs on the remote.

Sessions that make no commits, such as reviews, publish when they end. `/braid:push` publishes the current session at any time.

**Redaction.** Before publishing, braid scans records and native files with a secret scanner such as [gitleaks](https://github.com/gitleaks/gitleaks), plus rules in `.braid/redact.toml`. Matches become markers like `[REDACTED:aws-access-key]`, and each record lists what was removed in `ext.braid.redactions`. The scan covers what a record preview does not show: paths and user names in the native file, hook output, attached file contents. Images are dropped, because a text scanner cannot read them. Thinking blocks are published only unchanged, because editing them breaks the signatures some harnesses check on resume.

**Withholding.** Saying "don't publish the last hour" makes the agent mark those records withheld. braid keeps the list in `.git/braid/withheld/<session>`, applies it to every later publish, removes the matching native lines as well, and puts a placeholder record in each gap so the published tree stays connected. Withheld records do not count in `↑`.

**Public repositories** publish nothing until `.braid/config.toml` sets `publish = "always"`.

**Retraction.** A published record can be removed from the ref, but fetched copies keep it, and GitHub serves objects from any repository in a fork network to the others. Removing a leak means rewriting the ref and asking the host to purge the objects, as with any secret pushed to git.

**Model providers.** `/braid:sync` uses the session's own model. Digests, and merges run from a terminal, use the provider in your configuration, and only ever see redacted text.

## Trust

Other people's sessions are untrusted input. A record's author, model and tool results are whatever its publisher wrote, and the native file need not match the records.

- **Briefings quote other people's records as data.** Each passage is labeled with its author and presented as material to read. Nothing in a loaded session can trigger a braid command.
- **Replay hands someone else's turns to your agent as if they were yours.** braid offers it only for sessions published to the repository itself, where publishing needs write access, and asks before it starts.
- **Review checks test consistency only.** "Tests pass" with no passing test run in the session is worth flagging. A passing run in the session proves only that the publisher's records say so.
- **Settings come from you or the default branch.** braid reads strategies, redaction rules and providers from your own configuration and from `.braid/` on the default branch, never from the branch under review. It asks before using an endpoint it has not used before.
- **Rewritten refs are flagged.** Anyone with write access can rewrite custom refs, and branch protection does not cover them. braid warns when a fetched session loses records, and teams can require signed save commits.

## Status

The status line shows where the session stands. braid computes it from the refs and the agent never writes it, so it costs no tokens and stays out of the model's context.

```
5b0e2c1a · #128 · ↑4 · ↓ review/bob +5 → /braid:sync
```

| Shown | Meaning |
|---|---|
| `5b0e2c1a` | this session |
| `#128` | the pull request of the current branch |
| `local` | saved, never published, and no commit links it yet |
| `↑4` | 4 messages or merges of this session that are not published, withheld ones excluded |
| `↓ review/bob +5` | a session that forked from this one has 5 messages or merges that no merge in this session covers |
| `↓ 3 sessions +27` | the same, for several sessions |
| `⚠ merge pending` | a merge in this session is waiting for conflicts to be settled |
| `not saved` | braid is set up in this repository and has no record of this session |
| `✓` | everything is published and nothing is waiting |

A merge covers its heads and everything before them. `/braid:sync skip review/bob` writes a merge that adopts nothing, which clears `↓` and records the decision. Sessions linked to yours, or forked from someone else's, show in `/braid:status` and stay out of the line.

When something changes between turns, a hook adds one line under the reply:

```
braid: bob published 5 records to review/bob on #128. /braid:sync to merge them.
```

The line is cached until a ref of the conversation moves, and it redraws every 30 seconds so an idle session still sees a teammate's push. Codex has no custom status line, so there `$braid:status` and the after-turn line carry the same information. [prototype/statusline](../prototype/statusline) implements the line and tests it against the example.

## Merge, load and review

### Merge

`/braid:sync` merges from inside the session, using the model you are talking to. braid gives the agent the merge base and each branch since the base, quoted with their authors and summarized where long. The agent writes the summary following the instruction in your message. braid records the result as a `branch_summary` that continues from that turn, and tags the turn's own records as `partOf` the merge so that projections show it once. The summary stays in the session's context, so the next turn builds on it.

When the branches reached incompatible decisions that the instruction does not settle, the agent lists the conflicts and asks you, in the same session. braid keeps the pending merge in `.git/braid/merge/<session>`.

braid uses the `review` strategy for review sessions and `default` otherwise, and teams can add their own in `.braid/strategies/<name>.md`. From a terminal, `braid merge <into> <from> -p "<instruction>"` does the same with a configured provider. Model output varies between runs, so braid never recomputes a merge: `--redo` writes a new one.

### Load

- **Briefing, in the current session.** Works across harnesses.
- **Replay, in a new session.** braid writes the native file under a new id it chooses (`claude --session-id <uuid>` accepts one), rewrites absolute paths outside thinking blocks, and places the file where the harness keeps sessions, so it shows up in Claude Code's `/resume` and in `codex resume`. ATXF's converters write native files in both directions, so replay can cross harnesses where a converter exists. Native formats are internal to each harness and change between versions, so replay depends on the converters keeping up.

`5b0e2c1a@e9` loads from a given record. Every save records HEAD and the working tree, so a load can tell the agent what changed in the checkout since the point where it resumes.

At session start, a hook gives the agent an index of the sessions behind the current branch: id, author, harness and size. The index holds no session text, so a hostile session cannot inject instructions through it. The agent loads a session when asked.

### Review

When a branch with sessions has a pull request, braid posts a digest as a comment and updates it on later pushes: the request, quoted; decisions and their reasons; rejected approaches; assumptions nobody checked; commands and their results; files touched. A GitHub Action posts it using a provider key from the repository's secrets. Without the Action, the author's pre-push hook posts it in the background.

Asking for a review ("review this PR", `/braid:review-pr 128` in Claude Code, `$braid:review-pr 128` in Codex) runs consistency checks before the reviewer's own questions:

- claims that the session's records do not back
- files in the diff that no session touched
- decisions with no discussion behind them
- approaches already tried and dropped
- commits added after the session's last record

The reviewer's session forks from the newest session behind the pull request and links to the others. It records the pull request number in `ext.braid.pr` and is named `review/<reviewer>`. It publishes when it ends, and the author's status line shows it.

**CI and forks.** `actions/checkout` fetches no custom refs, so `braid check` fetches the sessions itself and fails when a commit's sessions are not published. A contributor without write access publishes to their own fork, and braid fetches from the pull request's head repository. On pull requests from forks, CI posts only a digest built without a model, covering the request, files, and commands with their results, because running a model on untrusted text next to repository secrets is unsafe.

## Format

Native session files are the source of truth for what a harness wrote, and braid keeps them byte for byte. The tree is [ATXF](https://github.com/leostera/atxf) 0.1, which models branches, rewinds, compaction, subagents and verbatim native records. Everything braid adds is valid ATXF, under the `ext.braid` namespace, so any ATXF reader can open a braid conversation. `braid save` writes a folder, and `braid export --atif` writes an [ATIF](https://docs.harborframework.com/agents/atif) trajectory for Harbor and NVIDIA NeMo.

```
pr-128/
  conversation.atxf.jsonl
  raw/claude-code/<session-id>.jsonl
  raw/codex/rollout-<time>-<session-id>.jsonl
```

| braid | ATXF |
|---|---|
| conversation id | header `id`: the id of the first session |
| messages, reasoning, tool calls and results | `message` records and their content blocks |
| merge | `branch_summary`: `parentId` is the head being continued, `fromId` the head brought in |
| session name | `label` on the session's first record |
| link to another session, subagent | `agent_link` |
| withheld record | a `custom` placeholder record |

| Where | `ext.braid` field | Meaning |
|---|---|---|
| header | `version` | version of these fields, `1` |
| any record | `actor.actorId`, `actor.userAgent` | who and what wrote it |
| any record | `session` | the session that wrote it |
| imported records | `raw.file`, `raw.line` | its line in the native file |
| records of a merge turn | `partOf` | the merge record that turn produced |
| merges | `merge.base`, `merge.heads`, `merge.instruction`, `merge.strategy`, `merge.model`, `merge.conflicts` | how the merge was made |
| first record of a review session | `pr` | the pull request number |
| published records | `redactions` | what was removed |

The ATXF 0.2 draft adds `actorId` and `userAgent` to every record envelope. braid will write them there once 0.2 is final, since 0.1 validators reject the new fields. [examples/pr-review](../examples/pr-review) is a complete conversation that validates against the 0.1 schema.

## Harnesses

| | Claude Code | Codex |
|---|---|---|
| sessions | `~/.claude/projects/<project>/<id>.jsonl`, subagents in `<id>/subagents/` | `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`, compressed or archived when old |
| saving | `Stop` hook | `Stop` hook |
| session behind a commit | `SessionStart` sets `BRAID_SESSION` through `CLAUDE_ENV_FILE` | the worktree rule |
| status | status line, after-turn line | `$braid:status`, after-turn line |
| commands | plugin skills: `/braid:sync` | the same skills: `$braid:sync` |
| replay | `/resume`, `claude --resume <id>` | `codex resume <id>` |
| headless | `claude -p` | `codex exec` |

Gemini CLI, OpenCode and Pi can be imported through ATXF's converters. Any harness that supports MCP can use `braid mcp`, which offers the commands as tools and sessions as resources (`@braid:session://5b0e2c1a`). It offers no prompts, because the skills already provide the commands.

Harnesses name their tools differently: Claude Code edits with `Edit`, Codex with `apply_patch`, and Codex runs commands with `exec_command`. Each adapter maps tool names to a few kinds (read, edit, write, shell, search, web, subagent), and digests, checks and the commit rule work from the kinds.

braid's own model calls, for digests and terminal merges, go through `provider:model` names: Anthropic, OpenAI, any OpenAI-compatible or [Open Responses](https://openresponses.org/) endpoint, or a headless harness such as `claude-code:default`.

## CLI

The skills, the MCP server and the CLI call the same library. The CLI is for setup, CI and scripts.

| Command | |
|---|---|
| `braid install` | once per machine: hooks, status line and skills for Claude Code and Codex, in user settings |
| `braid init` | once per repository: git hooks and `.braid/config.toml` |
| `braid status [<session>]` | everything the status line abbreviates |
| `braid log <session> [--graph]` | records, branches, and merges with their instructions |
| `braid load <session>[@<record>] [--replay]` | brief or replay a session |
| `braid merge <into> <from> -p "<instruction>"` | merge from a terminal |
| `braid push [<session>]` | publish the current session, or the one given |
| `braid save <session> <dir>` | write a conversation folder |
| `braid export --atif <session>` | an ATIF trajectory of one branch |
| `braid check` | for CI: fail when a commit's sessions are not published |
| `braid prune` | drop fetched sessions of merged or closed branches |
| `braid mcp` | the MCP server |

A session is addressed by its id or a unique prefix, by its name, or as `<id>@<record>`. `pr:128` means the sessions behind pull request 128 (`#128` inside an agent, where `#` does not start a comment). When several sessions are live, terminal commands ask for one.

## Prior art

| Project | What it does | Relation to braid |
|---|---|---|
| [Entire](https://docs.entire.io/overview) | records sessions per commit in the repository, with an `Entire-Checkpoint` trailer | closest in storage; braid plans to import its checkpoints |
| [git-ai](https://github.com/acunniffe/git-ai) | line-level agent attribution in git notes | complementary |
| [Agent Trace](https://agent-trace.dev/) | draft spec linking code ranges to conversations | an Agent Trace record could point to a braid session |
| [Traces](https://www.traces.com/docs) | hosted sharing of sessions by link | braid shares through the repository instead |
| [casr](https://github.com/Dicklesworthstone/cross_agent_session_resumer) | converts sessions between harnesses | a possible replay backend |
| [Forky](https://github.com/ishandhanani/forky), [ContextBranch](https://arxiv.org/pdf/2512.13914) | branching and merging single-user chats | braid applies the idea to team sessions |

braid adds session ids as the handle, a status line with ahead and behind counts against teammates' sessions, merges with an instruction from inside a session, and the review loop.

## Roadmap

1. **Capture and status:** saving hooks, the store, commit trailers, the status line, `braid save`.
2. **Publishing:** pre-push publishing, redaction, withholding, fetching.
3. **Load and merge:** briefings, replay, `/braid:sync`, conflicts, strategies.
4. **Review:** digests, review checks, `braid check`, forks, the MCP server.
5. **More harnesses** and the Entire importer.

Open questions:

- **Language.** TypeScript can use ATXF's npm package and the agent SDKs; Rust gives a single binary. TypeScript is the current preference.
- **Name.** `braid` is taken on npm and PyPI.
- **ATXF maturity.** ATXF is a v0.1 draft. Keeping native files means any conversation can be regenerated into a successor format.
- **Counting.** `↑` and `↓` count messages and merges. People may expect turns, a prompt and its answer.
- **The commit rule for Codex.** Codex hooks have no documented way to set the environment of the agent's commands, so Codex commits rely on the worktree rule.
- **Long sessions** need range summaries for briefings and merges.

braid started from a different idea: a chain of agents improving a numeric goal by a kind of gradient descent, with an LLM writing the gradients. The design keeps room for it without new primitives: an agent's parameters are a skill file, a step is a commit, the forward pass is linked sessions, a gradient is a critique passed back, the score is an evaluator's record, candidate steps are forks, and combining gradients is a merge with an instruction.
