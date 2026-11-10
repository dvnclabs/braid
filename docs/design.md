# Design

braid is an efficient session manager: it saves every coding-agent session as it happens, in git, and lets you go back, fork, edit, merge and share it. This document describes its design. Version 0.1 implements its core for Claude Code; [Status of v0.1](#status-of-v01) lists what is built and what comes next, and parts that are not built yet are marked *planned*. The [README](../README.md) covers installation and use.

- [Model](#model)
- [Storage](#storage)
- [Publishing](#publishing)
- [Trust](#trust)
- [Status](#status)
- [Commit, fork, merge and review](#commit-fork-merge-and-review)
- [Format](#format)
- [Harnesses](#harnesses)
- [CLI](#cli)
- [Prior art](#prior-art)
- [Distribution](#distribution)
- [Status of v0.1](#status-of-v01)

## Model

A **conversation** is a tree of records written by people, agents and tools. Records are appended and never edited.

A **session** is what one harness writes under one session id: a Claude Code session, a Codex thread. Each session is a branch of the tree. Its records are the ones it wrote, and its **head** is the newest of them. braid names a session by its harness id, shortened as git shortens commit hashes: the shortest unique prefix, at least 8 characters (`5b0e2c1a`). A session can also have a name such as `review/bob`, stored as a label on its first record. Names can repeat; ids cannot.

The conversation is named after the session that started it. A session **forks** from another when its first record's parent is that session's head; a fork joins the other session's conversation. A rewind inside a session also forks, and both branches stay in the tree.

A **commit** marks a point in a session with a message: a label on its newest turn. Publishing goes up to the last commit. `/braid:commit` writes one. Each code commit the agent makes is noted with a label too, with the commit's subject and sha; with `autocommit` on, that label commits the conversation as well.

Every record has an author: the **actor**, a person or account (`alice@example.com`), and the **user agent**, the software that wrote it (`claude-code/2.1`). braid matches participants on the actor and the product name, so upgrading Claude Code does not turn Alice into a new participant.

**Record ids** come from the harness where it assigns them; Claude Code gives every entry a uuid. Otherwise braid derives the id from the session id and the record's byte offset in the native file, so importing the same file twice yields the same ids.

A **merge** brings one branch into another. An LLM reads the merge base and each branch since the base, then writes a summary that follows an instruction. braid records the summary with the base, the heads, the instruction and the model. When two branches share no base, as with two independent sessions behind one pull request, the merge summarizes each branch from its root. **Reconcile** is the structural counterpart: it unions copies of the same records deterministically, with no LLM, following ATXF's reconciliation rules.

A **projection** renders a branch for one reader in one harness:

| Mode | Target | What the reader gets |
|---|---|---|
| resume | the harness that wrote the session | the native records, resumed as a new session |
| briefing | any harness | a summary: goal, decisions and reasons, open questions, files, commands and results |

## Storage

### Where sessions live

| Location | Holds |
|---|---|
| `.git/braid/store`, a separate bare repository, ref `refs/sessions/<conversation>/<session>` | your sessions as written, unredacted |
| `refs/braid/sessions/<conversation>/<session>` on the remote | published sessions: redacted, with withheld records removed |
| `refs/braid/remotes/origin/sessions/<conversation>/<session>` in your clone | the last fetched copy of each published session |
| `.git/braid/sessions/<session>.json` | the session's state: where the last save stopped, what `braid edit` withheld, rewrote or hid, a merge waiting to be written, the last `braid verify` |
| `refs/tags/points/<session>/<n>` in the store | fork points: with autofork, the session as it stood before a turn that changed a lot |

On autopilot, the default, braid keeps conversations in the repository the session runs in, inside its `.git`, even where braid was never set up there, and in `~/.braid` outside any repository. It writes no files into the working tree and installs no hooks unless `braid init` ran in that repository, and it never pushes, fetches or calls `gh`. The `repo` setting can name a separate git repository instead, such as `~/convos`: braid then keeps the conversations of that repository there, with no store, hooks, autocommit or autopush in the code repository, and `/braid:push` pushes to the separate repository's `origin`. The code repository's `.braidignore` and `redact.toml` still apply to its sessions.

The unredacted store sits outside the repository's refs, so no git command can push it by accident, `git push --mirror` included. The repository itself only ever holds copies that were already published.

A session ref holds only the records that session wrote. The conversation is the union of its sessions, and reading it reconciles them. Each person publishes only their own sessions, and continuing someone else's session always starts a new one, so every ref has a single writer. Publishing pushes with `--force-with-lease`. When the same session is saved on two machines, as when a transcript is copied by hand, each publish keeps the records the remote copy has and this machine lacks, and after a lease failure braid fetches the remote copy and tries once more. A record both copies hold with different content is reported, and the publishing machine's version wins.

### Saving

A harness hook saves at the end of each turn. It converts only what the harness wrote since the previous save with [ATXF](https://github.com/leostera/atxf)'s converter, and commits those records as one chunk to the session's ref in the store. braid keeps a cursor per session: the byte offset where the previous save stopped, the number of lines before it, and a hash of the line that ends there. Each save reads from the cursor, plus an overlap of at least 2 MB and the whole previous line, so that references across the boundary resolve; records without a uuid are named after their line in the whole file. When the file is shorter than the cursor or its last line changed, braid reads it again from the start and keeps the records the store lacks. The first save of a large session reads it in windows of 16 MB, one chunk each. A one-turn save of a 600 MB transcript takes about 150 ms, and the first save of it about 9 s.

```
records/000001.jsonl          ATXF records, in the order written
meta/000001.json              HEAD, and the code commits made since the previous save
records/000002.jsonl
meta/000002.json
agents/<id>/000001.jsonl      a subagent's records
```

Claude Code writes each subagent to its own file next to the transcript. braid saves new subagent records with the session that spawned them, under `agents/<id>/`, and adds an `agent_link` record below the tool call that spawned each one. Subagents are published, redacted and withheld with their session, `braid sessions` lists them under it, and a briefing includes each subagent's last answer.

Each record keeps its native line in ATXF's `native` field, so the store can give back the harness's file byte for byte. Earlier chunks are kept as they are, so a save costs about the size of what the turn added. braid runs `git gc --auto` on the store every 50 saves. Harnesses delete old transcripts (Claude Code after 30 days by default), and the store keeps them.

### Code commits

Code commits point to sessions with a trailer:

```
Braid-Session: 5b0e2c1a-7f3d-4c2e-9a61-0d8e4b2f6c13
```

| Git hook | What it does |
|---|---|
| `prepare-commit-msg` | adds the trailer, with `git interpret-trailers --if-exists addIfDifferent` |
| `post-commit` | notes the code commit; the next save labels the conversation with it, and with `autocommit` that label commits the conversation, so the commit points to the state of the conversation behind it |
| `post-rewrite` | links the sessions behind the old commits to the new ones after `git commit --amend` and `git rebase` |
| `pre-push` | with `autopush`, publishes the committed part of the sessions behind the commits being pushed |

How the hook knows which session made a commit:

- **The agent ran `git commit`.** At session start, braid puts `BRAID_SESSION=<id>` into the environment of the agent's shell commands. Claude Code's `SessionStart` hook does this through `CLAUDE_ENV_FILE`. The hook links that session.
- **The agent committed in another repository.** Agents often start in one repository and commit in another: a nested repository, or a worktree. braid keeps a list of the sessions running on the machine, with their transcripts, in `~/.local/share/braid/sessions/`. The first time a session commits in another repository where braid is set up, the hooks there register it, and from then on each turn is saved there too, and that repository's `git push` publishes it. Each repository's `.braid/config.toml` still decides whether it publishes.
- **You ran `git commit` yourself.** *Planned*; in v0.1 these commits get no trailer. The hook will link each session in this worktree whose edits since the previous commit touch the committed files. Sessions that did not edit those files stay unlinked.

Parallel agents usually run in separate worktrees, which keeps the second case unambiguous.

These settings in `.braid/config.toml` decide what braid does by itself, and your own `~/.config/braid/config.toml` can set any of them over the repository's:

| Setting | Default | |
|---|---|---|
| `autopilot` | `true` | braid works on this machine only: no pushing, fetching or `gh`, so no autopush, and no trailers (as with `link = "store"`). Off, the settings below decide how sessions are shared. |
| `autofork` | `true` | before a turn that edits 5 files or makes 30 tool calls, braid tags the session as it stood, a fork point that `braid fork @N` continues from in a new window |
| `repo` | `auto` | `auto` keeps conversations in the repository; a path keeps them in that separate git repository, with autocommit and autopush off |
| `autocommit` | `false` | each code commit the agent makes commits its conversation too; off, you commit it with `/braid:commit` after `/braid:edit` |
| `autopush` | `true`; `braid init` writes `false` in public repositories, and on autopilot | off autopilot, `git push` publishes the committed part of the sessions behind the pushed commits; off, `/braid:push` publishes |

`braid init --autocommit`, `--no-autopilot` and the like change them; outside a repository they go to your own config. The git hooks themselves are on by default. `git-hooks = false`, or `braid init --no-git-hooks`, turns them off: braid then leaves git alone, and `/braid:commit` and `/braid:push` do the work. Without trailers, `pr:N` cannot find the sessions behind a pull request. braid keeps an existing hook as `<name>.local` and runs it first. When a hook manager such as husky or lefthook sets `core.hooksPath`, `braid init` prints the lines to add to it instead.

Some teams forbid trailers in commit messages, and a trailer puts the session id into history even when the session is never published. With `link = "store"` in `.braid/config.toml`, commits carry no trailer. Each save already writes a label into the session for every code commit made during it, with the commit's SHA, and the label travels with the published session once it is committed. braid reads both sources wherever it needs the sessions behind commits: `git push`, the index at session start, and `pr:N`. Without trailers braid cannot tell which conversations are behind a branch before fetching them, so it fetches every published session.

GitHub's default squash message lists the original commit messages, so the trailers survive as text unless the repository uses the pull request title as the squash message or the person merging edits it. `pr:N` reads the pull request's own commits, as they were pushed, so it finds their sessions after a squash merge in either mode.

### Fetching

braid fetches only the conversations behind the current branch's commits. It runs in the background, under a lock, at most every few minutes:

```sh
git fetch --no-write-fetch-head --no-auto-gc origin \
  '+refs/braid/sessions/<conversation>/*:refs/braid/remotes/origin/sessions/<conversation>/*'
```

braid adds nothing to `remote.origin.fetch`, so a plain `git fetch`, and an editor's background fetch, cost what they did before. `braid prune`, *planned*, will drop fetched sessions of branches that were merged or closed.

## Publishing

A session is published up to its last commit, so nothing leaves the machine before you commit it. With `autopush`, `git push` publishes the sessions behind the pushed commits: the pre-push hook builds each published commit from the store and the rules below, then pushes it with `--no-verify` so the hook does not run itself again. It prints one line per session it publishes, or why it did not, and refuses pushes that would delete session refs on the remote.

A session built on someone else's, such as a review, makes no code commits, so with `autopush` its committed part is published when it ends. `/braid:push` publishes the committed part of the current session at any time.

**What leaves the machine.** Published copies hold ATXF records only. Native lines, reasoning, images, system messages and harness metadata stay in the store. braid redacts every remaining string with built-in rules for common credentials (cloud, GitHub, Anthropic, OpenAI, Slack, Stripe and npm keys, private keys, JWTs, passwords in URLs, and secret-looking assignments), and replaces home directories, of any user and machine (`/Users/<name>`, `/home/<name>`), with `~`. Matches become markers like `[REDACTED:aws-access-key]`, and each record lists what was removed in `ext.braid.redactions`.

**`.braidignore`** lists paths whose tool calls, and their results, are never published, in the syntax of `.gitignore`:

```
# .braidignore
.env
.env.*
!.env.example
*.pem
customers/
```

`braid init` writes one that covers `.env` files and keys. braid applies the working tree's `.braidignore`, the default branch's, and your own `~/.config/braid/ignore`, each on its own: a path any of them ignores is withheld, so a `!` line on a branch cannot re-include what the default branch ignores. A tool call names its paths through its path arguments and the path-like words of a shell command.

Teams add terms and patterns to redact in `.braid/redact.toml`, which braid reads from the default branch only, and anyone can add personal ones in `~/.config/braid/redact.toml`:

```toml
terms = ["Acme Corp", "Project Falcon"]   # replaced in any case, as [REDACTED:term]
patterns = ['CUST-\d{6}']                  # regular expressions, as [REDACTED:pattern]
withhold-session = false                  # true: a call on an ignored path withholds the whole session
```

`braid push --dry-run` shows the totals: the records, the redactions per rule, the records withheld per cause, where the rules came from, and how many newer records are not committed. Running [gitleaks](https://github.com/gitleaks/gitleaks) is *planned*.

**Edit.** `braid edit` lists the session as it would be published, one numbered line per record after redaction, with subagent records numbered under the line that spawned them (`4.1`). It then edits what goes out:

| Command | Effect |
|---|---|
| `braid edit 4 7-9 12.3` | withholds records; a tool call takes its results along, and a subagent all its records |
| `braid edit --rewrite 5` | publishes new text in place of a record's own: in `$VISUAL` or `$EDITOR` on a terminal, from stdin otherwise; emptying it withholds the record |
| `braid edit --hide "Acme"` | hides a word or phrase in every record of the session, as `[REDACTED:term]` |
| `braid edit --last 1h`, `--all` | withholds recent records, or keeps the whole session private |
| `--undo` with any of these | puts it back |

The edits live in the session's state and apply to every later publish; the store keeps the records as written. Withheld records' children attach to their nearest published ancestor, so the published tree stays connected, and withheld records do not count in `↑`. Saying "don't publish the last hour" to the agent runs the same commands through `/braid:edit`.

**Replacing what was published.** When `braid edit` changes records that were already published, the next push replaces the published copy with one that has no history, so the old content is no longer reachable from the ref. Copies fetched before keep it, and the host may serve the old objects by their hash until it collects them; GitHub also shares objects across a fork network. Rotate any secret that was published, as with any secret pushed to git.

**Model providers.** `/braid:merge` uses the session's own model. Digests, and merges run from a terminal, use the provider in your configuration, and only ever see redacted text.

## Trust

Other people's sessions are untrusted input. A record's author, model and tool results are whatever its publisher wrote, and the native file need not match the records.

- **Briefings quote other people's records as data.** Each passage is labeled with its author and presented as material to read. Nothing in a loaded session can trigger a braid command.
- **Forking someone else's session into a new window hands their turns to your agent as if they were yours.** braid only prints the command to start it, and the sessions come from the repository itself, where publishing needs write access. `braid fork --here` and `braid show` quote them instead.
- **Review checks test consistency only.** "Tests pass" with no passing test run in the session is worth flagging. A passing run in the session proves only that the publisher's records say so.
- **Settings come from you or the default branch.** braid reads strategies, redaction rules and providers from your own configuration and from `.braid/` on the default branch, never from the branch under review. It asks before using an endpoint it has not used before.
- **Rewritten refs are flagged.** Anyone with write access can rewrite custom refs, and branch protection does not cover them. braid warns when a fetched session loses records, and teams can require signed save commits.

## Status

The status line shows where the session stands. braid computes it from the refs and the agent never writes it, so it costs no tokens and stays out of the model's context.

```
5b0e2c1a · #128 · ↑4 · ↓ review/bob +5 → /braid:merge
```

| Shown | Meaning |
|---|---|
| `5b0e2c1a` | this session |
| `#128` | the pull request of the current branch |
| `local` | saved, nothing committed and nothing published |
| `↑4` | 4 committed messages or merges that are not published, withheld ones excluded |
| `*3` | 3 messages or merges since the last commit, which publishing leaves out |
| `↓ review/bob +5` | a session that forked from this one, such as a review or your own branch, has 5 messages or merges that no merge in this session covers |
| `↓ 3 sessions +27` | the same, for several sessions |
| `private` | the whole session is withheld |
| `not saved` | braid is set up in this repository and has no record of this session |
| `✓` | everything is published and nothing is waiting |

A merge covers its heads and everything before them. `/braid:merge skip review/bob` writes a merge that adopts nothing, which clears `↓` and records the decision. The session this one forked from shows in `/braid:status` and stays out of the line.

When something changes between turns, a hook adds one line under the reply:

```
braid: review/bob +5 waiting to be merged into this session. /braid:merge to merge.
```

The line is cached until a ref of the conversation moves, and it redraws every 30 seconds so an idle session still sees a teammate's push. Codex has no custom status line, so there `$braid:status` and the after-turn line carry the same information. `src/status.ts` computes the line and `src/statusline.ts` draws it, after any status line you already had.

## Commit, fork, merge and review

### Commit

Each turn is saved when it ends, as a working copy is, and stays on your machine. A commit marks the point up to which the conversation may be published: you go through the session with `/braid:edit`, remove or rewrite what should stay private, and commit with `/braid:commit <message>`. With `autopush`, the next `git push` of the session's code commits publishes it. With `autocommit`, every code commit the agent makes commits the conversation as well, so a team that does not review sessions needs no commands of its own. A committed session leaves `local` in the status line, and turns after the last commit show as `*`.

### Fork

A session cannot open a terminal window, so `/braid:fork` prints the command that continues the fork in a new one, `cd <dir> && claude --resume <id>`.

- **This conversation.** `braid fork` prints `claude --resume <id> --fork-session`; Claude Code's `/branch` does the same in the current window. Both copy the transcript under a new session id, keeping each record's id. When a new session's first message belongs to a saved session, braid files it as a branch of that conversation and saves only the records it adds. The branch shows as `↓` in the original session until it is merged back or skipped. Forking another of your own sessions on this machine works the same way.
- **Another session, such as a teammate's, yours from another machine, or a fork point.** `braid fork <id|name|pr:N|@N> [--cwd <path>]` writes the session as a Claude Code transcript under a new session id, where `claude --resume <id>` finds it. From your own store, the fork is the lines Claude Code wrote, as it wrote them: everything the session wrote since its last compaction up to the fork point, in order and with the same links between lines, and the messages that compaction kept. Claude Code reads more than the chain of messages to resume a session: the rest of a parallel response and the results beside the chain, notes attached to results, messages typed while the agent worked, files the user named, how the tools it may call changed (also on branches left behind by a rewind), and the session's mode and permissions. A fork holds all of it, so Claude Code resumes the fork as it resumes the source. Only the source's request log, file history, input queue and last prompt stay behind. From a published copy, which keeps messages and tool calls only, ATXF's converter writes the context path. A fork rewrites the source checkout's path to this one when it is another checkout, and any prefixes under `[paths]` in `~/.config/braid/config.toml`, outside reasoning blocks, whose signatures cover them. Each line takes a uuid derived from its record's id, and every mention of another line, outside the message, follows it, so the new session's first save recognizes the copied lines, keeps only what is added after them, and continues from the source's head. For `pr:N` with several sessions, braid forks the newest and names the others.
- **Into this session.** `braid fork <target> --here`, run before the session's first turn is saved, reads the other session as a quoted briefing and makes this session continue from its head, as `/braid:review` does. When the other session is someone else's, this one is named `review/<you>`. A session that already has saved turns cannot fork this way; `/braid:merge` brings the other session in instead.

`braid show <id>` reads a session as a briefing without forking. At session start, a hook gives the agent an index of the sessions behind the current branch: id, author, harness and size. The index holds no session text, so a hostile session cannot inject instructions through it.

### Merge

`/braid:merge` merges from inside the session, using the model you are talking to. With no target it takes the session waiting in `↓`; with a target, any session. braid gives the agent the other session's records since the newest record both share, or from its root when they share none, quoted with their authors. The agent writes the summary following the instruction in your message. braid records the result as a `branch_summary` that continues from that turn, and tags the turn's own records as `partOf` the merge so that projections show it once. The summary stays in the session's context, so the next turn builds on it.

When the branches reached incompatible decisions that the instruction does not settle, the agent lists the conflicts and asks you before it records the merge. braid writes the recorded merge into the session when the turn ends.

braid uses the `review` strategy for review sessions and `default` otherwise, and teams can add their own in `.braid/strategies/<name>.md`. Merging from a terminal with a configured provider is *planned*. Model output varies between runs, so braid never recomputes a merge: `--redo` writes a new one.

### Review

When a branch with sessions has a pull request, braid posts a digest as a comment and updates it on later pushes: the request, quoted; decisions and their reasons; rejected approaches; assumptions nobody checked; commands and their results; files touched. A GitHub Action posts it using a provider key from the repository's secrets. Without the Action, the author's pre-push hook posts it in the background.

Asking for a review ("review this PR", `/braid:review 128` in Claude Code, `$braid:review 128` in Codex) runs consistency checks before the reviewer's own questions:

- claims that the session's records do not back
- files in the diff that no session touched
- decisions with no discussion behind them
- approaches already tried and dropped
- commits added after the session's last record

The reviewer's session forks from the newest session behind the pull request and reads the others. It records the pull request number in `ext.braid.pr` and is named `review/<reviewer>`. Once the reviewer commits it, it publishes when it ends, and the author's status line shows it.

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
| withheld record | left out of the published copy; its children attach to its nearest published ancestor |

| Where | `ext.braid` field | Meaning |
|---|---|---|
| header | `version` | version of these fields, `1` |
| any record | `actor.actorId`, `actor.userAgent` | who and what wrote it |
| any record | `session` | the session that wrote it |
| imported records | `raw.file`, `raw.line` | its line in the native file |
| records of a merge turn | `partOf` | the merge record that turn produced |
| merges | `merge.base`, `merge.heads`, `merge.instruction`, `merge.strategy`, `merge.model`, `merge.conflicts` | how the merge was made |
| first record of a review session | `pr` | the pull request number |
| labels | `commit.sha` | a commit of the conversation, with the code commit behind it when there is one |
| labels | `code.sha` | a code commit made during the session, which did not commit the conversation |
| published records | `redactions` | what was removed |

The ATXF 0.2 draft adds `actorId` and `userAgent` to every record envelope. braid will write them there once 0.2 is final, since 0.1 validators reject the new fields. [examples/pr-review](../examples/pr-review) is a complete conversation that validates against the 0.1 schema.

## Harnesses

| | Claude Code | Codex |
|---|---|---|
| sessions | `~/.claude/projects/<project>/<id>.jsonl`, subagents in `<id>/subagents/` | `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`, compressed or archived when old |
| saving | `Stop` hook | `Stop` hook |
| session behind a commit | `SessionStart` sets `BRAID_SESSION` through `CLAUDE_ENV_FILE` | the worktree rule |
| status | status line, after-turn line | `$braid:status`, after-turn line |
| commands | plugin skills: `/braid:merge` | the same skills: `$braid:merge` |
| resume a fork | `claude --resume <id>` | `codex resume <id>` |
| headless | `claude -p` | `codex exec` |

`braid import openclaw` imports OpenClaw sessions: it opens each agent's SQLite store read-only, decompresses the events, which are in pi's session format, converts them with ATXF's pi converter in batches of at most 16 MB, and picks up after the last event it imported. A spawned session joins its parent's conversation. ATXF also has converters for Gemini CLI, OpenCode and Pi, so importing those would follow the same path. Any harness that supports MCP can use `braid mcp`, which offers the commands as tools and sessions as resources (`@braid:session://5b0e2c1a`). It offers no prompts, because the skills already provide the commands.

Harnesses name their tools differently: Claude Code edits with `Edit`, Codex with `apply_patch`, and Codex runs commands with `exec_command`. Each adapter maps tool names to a few kinds (read, edit, write, shell, search, web, subagent), and digests, checks and the commit rule work from the kinds.

braid's own model calls, for digests and terminal merges, go through `provider:model` names: Anthropic, OpenAI, any OpenAI-compatible or [Open Responses](https://openresponses.org/) endpoint, or a headless harness such as `claude-code:default`.

## CLI

The skills and the hooks call the CLI. You rarely need it yourself.

| Command | |
|---|---|
| `braid init [--[no-]autopilot] [--[no-]autofork] [--repo <path>\|auto] [--no-git-hooks] [--[no-]autocommit] [--[no-]autopush] [--undo]` | once per machine: a `braid` command in `~/.local/bin`, braid's part of the status line, and `~/.braid`; inside a repository, `.braid/config.toml`, `.braidignore`, the store, and git hooks unless turned off; later, change the settings. It saves the conversation it runs in. |
| `braid status` | where this session stands, and the sessions of its conversation |
| `braid edit [<n>…] [--rewrite <n>] [--hide <s>] [--last 30m] [--all] [--undo]` | the session as it would be published, and what to withhold, rewrite or hide |
| `braid commit -m "<message>"` | commit the conversation up to here |
| `braid push [--dry-run]` | publish the committed part of this session now |
| `braid fork [<id\|name\|pr:N\|@N>] [--cwd <path>] [--here]` | the command to continue a session, or a fork point (`@2`, `<id>@2`), in a new window; with no target, this one |
| `braid review <N>` | continue from the sessions behind pull request N in this session, to review it |
| `braid verify [<id>\|--all]` | check that a session was saved as it happened and loads back the same |
| `braid merge [<id\|name\|pr:N>]` | show what another session has that this one lacks; `--record` and `--skip` write the merge |
| `braid show <id\|name\|pr:N>` | read a session as a briefing |
| `braid import openclaw` | import OpenClaw sessions |
| `braid sessions`, `braid log <id>` | list sessions, and the turns and commits of one |
| `braid fetch [--all]` | fetch published sessions now |

*Planned:* merging from a terminal with a configured provider, `braid save <dir>`, `braid export --atif`, `braid check` for CI (built on `braid verify`), `braid prune`, and `braid mcp`.

A session is addressed by its id or a unique prefix, by its name, or as `pr:128` for the sessions behind pull request 128. Inside an agent, commands act on the current session, which braid takes from `BRAID_SESSION`.

## Prior art

| Project | What it does | Relation to braid |
|---|---|---|
| [Entire](https://docs.entire.io/overview) | records sessions per commit in the repository, with an `Entire-Checkpoint` trailer | closest in storage; braid plans to import its checkpoints |
| [git-ai](https://github.com/acunniffe/git-ai) | line-level agent attribution in git notes | complementary |
| [Agent Trace](https://agent-trace.dev/) | draft spec linking code ranges to conversations | an Agent Trace record could point to a braid session |
| [Traces](https://www.traces.com/docs) | hosted sharing of sessions by link | braid shares through the repository instead |
| [casr](https://github.com/Dicklesworthstone/cross_agent_session_resumer) | converts sessions between harnesses | a possible backend for forking across harnesses |
| [Forky](https://github.com/ishandhanani/forky), [ContextBranch](https://arxiv.org/pdf/2512.13914) | branching and merging single-user chats | braid applies the idea to team sessions |

braid adds session ids as the handle, a status line with ahead and behind counts against teammates' sessions, merges with an instruction from inside a session, and the review loop.

## Distribution

braid ships as a Claude Code plugin served from this repository. The plugin carries the hooks, the skills and the CLI, which is one bundled file (`dist/braid.mjs`, built from `src/` with esbuild) that needs only Node 22. Installing the plugin is the whole install, and `/braid:init` adds the `braid` command and the status line. braid needs no server and no GitHub App: sessions travel in git refs, which GitHub stores like any other ref. Codex reads the same skills and Claude-style plugin manifests, so it is the next harness, and an npm package for CI follows.

## Status of v0.1

Built, for Claude Code:
- **Saving:** each turn is saved into the store, read incrementally in bounded windows, and subagents are saved with their session. On autopilot, the default, every session on the machine is saved and nothing leaves it. `braid verify` checks that a session was saved as it happened, and that a fork written from the store holds the lines Claude Code reads to resume the transcript; it runs when each session ends. `npm run check:resume -- <transcript>` resumes a session and its fork in Claude Code against a local server and compares the requests Claude Code would send, byte for byte. Autofork marks fork points before big turns.
- **Git:** `/braid:commit` commits the conversation, and publishing goes up to the last commit. The agent's code commits get trailers and labels in the conversation, or with `link = "store"` labels only; `autocommit` makes them commit the conversation too. `post-rewrite` carries those links across amends and rebases. The git hooks are on by default; `git-hooks = false` turns them off.
- **Repositories:** a session is saved and published in every repository it commits in.
- **Publishing:** `git push` publishes with `autopush`, with built-in and team redaction rules, `.braidignore`, and `--dry-run`. `braid edit` withholds, rewrites and hides parts of a session, and the next push replaces what was already published. The status line and the after-turn line show where each session stands, and `braid fetch` gets teammates' sessions.
- **Forks and merges:** `/braid:fork` prints the command that continues this session, or another, in a new window, Claude Code's `/branch` is recorded as a branch, and `/braid:merge` merges or skips waiting or named sessions.
- **Machines:** `braid fork` continues a session here or on another machine, and two machines can publish the same session.
- **Imports and reviews:** `braid import openclaw` imports OpenClaw sessions, and committed review sessions publish when they end. All of it is reachable through the skills.

`npm test` runs these flows through git, with no mocks.

Next:

1. Codex, through its hooks, skills and ATXF's converter.
2. Commits you make yourself, and `braid prune`.
3. Review: digests on pull requests, `braid check` for CI (built on `braid verify`), and contributors on forks.
4. gitleaks, and the MCP server.

Open questions:

- **ATXF maturity.** ATXF is a v0.1 draft. The store keeps native lines, so any conversation can be converted again into a successor format.
- **Counting.** `↑` and `↓` count messages and merges. People may expect turns, a prompt and its answer.
- **The commit rule for Codex.** Codex hooks have no documented way to set the environment of the agent's commands, so Codex commits will rely on the worktree rule.
- **Long sessions** need range summaries for briefings and merges.
- **Name.** `braid` is taken on npm, so the package is `@gbarbalinardo/braid`.

braid started from a different idea: a chain of agents improving a numeric goal by a kind of gradient descent, with an LLM writing the gradients. The design keeps room for it without new primitives: an agent's parameters are a skill file, a step is a commit, the forward pass is linked sessions, a gradient is a critique passed back, the score is an evaluator's record, candidate steps are forks, and combining gradients is a merge with an instruction.
