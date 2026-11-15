# Design

braid is an efficient session manager: it saves every coding-agent session as it happens, in the project it runs in, and lets you go back to any turn, fork it into Claude Code or Codex, and merge branches back. This document describes its design; [Status of v0.2](#status-of-v02) lists what is built and what comes next. The [README](../README.md) covers installation and use.

Version 0.1 kept every conversation in a git repository of braid's own, `~/.braid`, and could publish sessions to a code repository's remote for teammates and pull request reviews. Version 0.2 keeps each project's sessions as plain files in the project, and leaves sharing out for now: that design is on the [`git-sharing`](https://github.com/dvnclabs/braid/tree/git-sharing) branch. `braid migrate` moves 0.1's conversations into their projects.

- [Model](#model)
- [Storage](#storage)
- [Status](#status)
- [Turns, forks and merges](#turns-forks-and-merges)
- [Format](#format)
- [Harnesses](#harnesses)
- [CLI](#cli)
- [Prior art](#prior-art)
- [Distribution](#distribution)
- [Status of v0.2](#status-of-v02)

## Model

A **conversation** is a tree of records written by people, agents and tools. Records are appended and never edited.

A **session** is what one agent writes under one session id: a Claude Code session, a Codex thread. Each session is a branch of the tree. Its records are the ones it wrote, and its **head** is the newest of them. braid names a session by its id, shortened as git shortens commit hashes (`5b0e2c1a`), or by the name you gave it with `/rename`.

The conversation is named after the session that started it. A session **forks** from another when its first record's parent is that session's head; a fork joins the other session's conversation. A rewind inside a session also forks, and both branches stay in the tree.

A **turn** is a prompt you typed and everything the agent did until it stopped, or a merge. Turns are named `<session>.<n>`.

Every record has an author: the **actor**, a person or account (`alice@example.com`), and the **user agent**, the software that wrote it (`claude-code/2.1`).

**Record ids** come from the agent where it assigns them; Claude Code gives every entry a uuid. Otherwise braid derives the id from the session id and the record's line in the native file, so reading the same file twice yields the same ids.

A **merge** brings one branch into another. The agent reads each branch since the newest record both share, then writes a summary that follows an instruction. braid records the summary with the base, the heads, the instruction and the model.

## Storage

Each project keeps its sessions in a `.braid` folder:

```
<project>/.braid/
  .gitignore                    *: git does not see the folder, and no file of the project changes
  sessions/<id>.jsonl           the session's records in ATXF, one per line, appended each turn; its subagents' too
  sessions/<id>.json            its state: where the last save stopped, its title and recap, its newest turn,
                                the checkout it ran in, a merge waiting to be written, the last braid verify
  cache/                        what the status line caches
```

A **project** is a git repository's main checkout, the one that holds the `.git` its worktrees share, so a session in any worktree is kept in the main checkout's folder, and deleting a worktree keeps its sessions. For worktrees of a bare repository, the folder is inside the bare repository. Outside any repository, the project is the folder a session started in. Every session of a conversation is kept where the conversation started: a fork opened in another folder is noted, in `~/.local/share/braid/sessions/<id>.json`, with the project that keeps it, and its hooks find it there.

The files are plain JSON lines, so anything can read them: `grep`, an editor, a web interface, a training pipeline. Nothing leaves the machine, and braid calls no model of its own.

### Saving

An agent's hook saves at the end of each turn. It converts only what the agent wrote since the previous save with [ATXF](https://github.com/leostera/atxf)'s converter, and appends those records to the session's file. braid keeps a cursor per session: the byte offset where the previous save stopped, the number of lines before it, and a hash of the line that ends there. Each save reads from the cursor, plus an overlap of at least 2 MB and the whole previous line, so that references across the boundary resolve; records without a uuid are named after their line in the whole file. Only the lines after the cursor are saved, so each line is saved once. Claude Code sometimes writes a line again under the uuid it already has, as it does for some results after a resume; that copy is saved as a second record with the same id, and a fork writes both lines, as the source has them. When the file is shorter than the cursor or its last line changed, braid reads it again from the start and keeps the records the session's file lacks. The first save of a large session reads it in windows of 16 MB.

Claude Code writes each subagent to its own file next to the transcript. braid saves new subagent records in the file of the session that spawned them, each marked with the subagent's id (`ext.braid.agent`), and adds an `agent_link` record below the tool call that spawned each one.

Each record keeps its native line in ATXF's `native` field, so braid can give back the agent's file byte for byte. A save appends, so it costs about the size of what the turn added. Agents delete old transcripts (Claude Code after 30 days by default), and the project's `.braid` folder keeps them.

## Status

The status line shows the session braid is saving, by the name of its newest turn, and what it is about:

```
braid · 5b0e2c1a.12 · Webhook retries · ↓ 3f2a91c0 +4 → /braid:merge
```

| Shown | Meaning |
|---|---|
| `5b0e2c1a.12` | this session, at its newest turn, by the name `braid fork` takes |
| `Webhook retries` | what the session is about: the name you gave it with `/rename`, else the agent's title for it, else its first prompt, with credentials hidden |
| `↓ 3f2a91c0 +4` | a branch of this conversation, such as one made with `/branch`, has 4 messages or merges that no merge in this session covers |
| `↓ 3 sessions +27` | the same, for several sessions |
| `⚠ braid verify` | the check braid ran when the session last ended found a problem |

braid computes the line from the session files, so it costs no tokens and stays out of the model's context. The `braid` label and the separators are dimmed, `↓` is magenta and `⚠` red; `NO_COLOR` turns colors off. braid runs the status line you had before, first.

When you resume a session, or open a fork of one, a hook shows what it is about: `braid · 5b0e2c1a.12 · Webhook retries`, and for a fork `, a fork of <session>`. braid keeps the title, and the latest recap Claude Code writes when you come back to a session, from the records it saves. Claude Code shows its own recap again when it resumes a session, so braid adds the recap only in Codex, which writes none. `braid status` shows both. Neither goes into the model's context. When a branch gets turns this session has not merged, a hook adds one line under the reply:

```
braid: 3f2a91c0 +4 waiting to be merged into this session. /braid:merge to merge.
```

## Turns, forks and merges

### Turns

A turn is a prompt you typed and everything the agent did until it stopped, or a merge. Its name is `<session>.<n>`: `5b0e2c1a.12`, or `.12` for the session you are in, and the session part can be any name braid finds the session by, such as the one you gave it with `/rename`. Turns are numbered from the conversation's first prompt along the session's line, so a fork continues the numbering of the session it forks from: forked after `5b0e2c1a.7`, its first turn is `.8` of its own, and `<fork>.5` names the source's fifth turn. Numbers never change, since braid only appends records.

braid tells a prompt from what an agent writes in the user's place by what the agent writes on the line, with no model: Claude Code marks tool results, notes, notices and summaries (`isMeta`, `origin`, `toolUseResult`, `isCompactSummary`), and what remains, such as command output, reminders and an interruption, opens with a tag of the agent's own. Codex's context and notes open with fixed tags too. A command you type, such as `/braid:init`, is a turn. `braid fork <session>.<n>` continues from the end of turn n, as `git checkout` gives a commit with its change: to do turn n again, fork from `.<n-1>`. `braid log` lists the turns along the line, with the files each edited and its tool calls; the status line and the line shown on resume name the newest.

### Fork

A session cannot open a terminal window, so `/braid:fork` prints the command that continues the fork in a new one, `cd <dir> && claude --resume <id>`.

- **This conversation.** `braid fork` prints `claude --resume <id> --fork-session`; Claude Code's `/branch` does the same in the current window. Both copy the transcript under a new session id, keeping each record's id. When a new session's first message belongs to a saved session, braid files it as a branch of that conversation and saves only the records it adds. The branch shows as `↓` in the original session until it is merged back or skipped. Forking another of your own sessions on this machine works the same way.
- **Another session, or a turn of one.** `braid fork <id|name|<session>.<n>|.<n>> [--cwd <path>]` writes the session as a Claude Code transcript under a new session id, where `claude --resume <id>` finds it. The fork is the lines Claude Code wrote, as it wrote them: everything the session wrote since its last compaction up to the fork point, in order and with the same links between lines, and the messages that compaction kept. Claude Code reads more than the chain of messages to resume a session: the rest of a parallel response and the results beside the chain, notes attached to results, messages typed while the agent worked, files the user named, how the tools it may call changed (also on branches left behind by a rewind), and the session's mode and permissions. A fork holds all of it, so Claude Code resumes the fork as it resumes the source. Only the source's request log, file history, input queue and last prompt stay behind. A fork rewrites the source checkout's path to this one when it is another checkout, outside reasoning blocks, whose signatures cover them. Each line takes a uuid derived from its record's id, and every mention of another line, outside the message, follows it, so the new session's first save recognizes the copied lines, keeps only what is added after them, and continues from the source's head.
- **Into another agent.** `braid fork [<target>] --to codex` writes the session, this one when no target is named, as a new Codex session: a rollout in `$CODEX_HOME/sessions/YYYY/MM/DD/`, which `codex resume <id>` finds by its id. It holds the conversation as the model read it, in the order the model took it: what the user and the agent said, each tool call with the arguments the model gave it and its id, and each result, a batch of parallel calls before its results and the results before the notes on them. A failed call's result is its text, as Codex keeps results. A message the user typed while the agent worked, which Claude Code attaches to the turn, is a user message. What Claude Code wrote into the conversation for its model and did not show, such as the text of a skill the agent loaded, where an image came from, a message from another session or a notice that a background task finished, is a developer message. After a compaction, the fork starts with Codex's own record of one, the summary, followed by the messages the compaction kept. What only Claude Code's model can use stays behind: reasoning, which its signature binds to the provider that wrote it, the model setting, the harness's own reminders, hook output and token counts, and the record of its slash commands. Codex adds its own instructions, tools and environment when it resumes, and shortens long results in what it sends. Paths move as in any fork. `npm run check:resume -- --to codex <transcript>` resumes the original in Claude Code and the fork in Codex, against local servers that record each request, and compares the conversation in the two, item by item, allowing for how each agent presents it: the notes each adds, results neither recorded, Codex's shortening, and the few ways Claude Code rewrites a call's arguments when it sends them.
- **From another agent.** A Codex session forks into Claude Code the same way, with `braid fork <target> --to claude-code` (a fork continues in the agent it is asked from, unless another is named): ATXF's converter writes the context path, each response as one message, a line per block under the response's id, as Claude Code writes a response, so a batch of parallel calls goes back as one message and its results after it. A record Claude Code takes nothing from, such as Codex's turn settings, token counts and events, passes its place in the chain to the next. What Codex gives its own model in the conversation stays behind, as Claude Code gives its own: its instructions (developer messages), the environment, and the AGENTS.md files it read, also from what a compaction kept. What Codex wrote for its model in the user's place, such as a skill's text or a note that the user interrupted a turn, is a note (`isMeta`). After a Codex compaction, the fork starts with what Codex put in place of the history: the user's messages it kept and its summary. Codex's reasoning stays with OpenAI. A custom tool's call, such as `apply_patch`, whose input is text, goes as `{"input": <text>}`. Given a Codex rollout, `npm run check:resume` resumes the original in Codex and the fork in Claude Code, and compares the conversation the same way.
- **The same fork twice.** A fork braid writes takes a session id derived from what it forks: the session, the point it forks from, the agent and the directory. Asked for again, braid gives back the session it wrote the first time, as it stands, continued or not, and writes nothing. A fork from a later point is another session, and `--new` writes another one from the same point.

A fork is kept with the session it forks, in that project's `.braid` folder, wherever it runs: braid notes the project for the new session, and its hooks find it there.

### Merge

`/braid:merge` merges from inside the session, using the model you are talking to. With no target it takes the session waiting in `↓`; with a target, any session of the project. braid gives the agent the other session's records since the newest record both share, or from its root when they share none, quoted with their authors. The agent writes the summary following the instruction in your message. braid records the result as a `branch_summary` that continues from that turn, and tags the turn's own records as `partOf` the merge so that projections show it once. The summary stays in the session's context, so the next turn builds on it.

When the branches reached incompatible decisions that the instruction does not settle, the agent lists the conflicts and asks you before it records the merge. braid writes the recorded merge into the session when the turn ends.

Model output varies between runs, so braid never recomputes a merge.

## Format

Native session files are the source of truth for what an agent wrote, and braid keeps their lines byte for byte. The tree is [ATXF](https://github.com/leostera/atxf) 0.1, which models branches, rewinds, compaction, subagents and verbatim native records. Everything braid adds is valid ATXF, under the `ext.braid` namespace, so any ATXF reader can open a braid session file, and a web interface or a training pipeline can read the files of a project's `.braid` folder as they are.

| braid | ATXF |
|---|---|
| conversation id | header `id`: the id of the first session |
| messages, reasoning, tool calls and results | `message` records and their content blocks |
| merge | `branch_summary`: `parentId` is the head being continued, `fromId` the head brought in |
| link to another session, subagent | `agent_link` |

| Where | `ext.braid` field | Meaning |
|---|---|---|
| header | `version` | version of these fields, `1` |
| any record | `actor.actorId`, `actor.userAgent` | who and what wrote it |
| any record | `session` | the session that wrote it |
| a subagent's records | `agent` | the subagent's id |
| records of a merge turn | `partOf` | the merge record that turn produced |
| merges | `merge.base`, `merge.heads`, `merge.instruction`, `merge.strategy`, `merge.model`, `merge.conflicts` | how the merge was made |

The ATXF 0.2 draft adds `actorId` and `userAgent` to every record envelope. braid will write them there once 0.2 is final, since 0.1 validators reject the new fields. [examples/pr-review](../examples/pr-review) is a complete conversation of braid 0.1's, with its review and merge, that validates against the 0.1 schema.

## Harnesses

A session is braid's own: its records, in ATXF, are the same whichever agent wrote them, and braid writes any session out for any agent it supports, as a new session of that agent's that continues it (`braid fork --to codex`). Each agent is an adapter: where its sessions live, how to read them, how to write a fork, and the command that resumes one.

| | Claude Code | Codex |
|---|---|---|
| sessions | `~/.claude/projects/<project>/<id>.jsonl`, subagents in `<id>/subagents/` | `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`, compressed or archived when old |
| saving | `Stop` hook, from the plugin | `Stop` hook, which `braid init` adds to `~/.codex/hooks.json` |
| the session a command runs in | `SessionStart` sets `BRAID_SESSION` through `CLAUDE_ENV_FILE`; Claude Code also gives commands `CLAUDE_CODE_SESSION_ID` | Codex gives the commands it runs `CODEX_THREAD_ID` |
| status | status line, after-turn line | after-turn line |
| commands | plugin skills: `/braid:fork`, `/braid:merge`, `/braid:status`, `/braid:init` | the `braid` command; skills for Codex are next |
| resume a fork | `claude --resume <id>` | `codex resume <id>` |
| headless | `claude -p` | `codex exec` |

**Saving a Codex session.** `braid init` adds three hooks to `~/.codex/hooks.json`, next to any others there, and `braid init --undo` takes them out. Codex runs a hook only once the user trusts it, in `/hooks`. `SessionStart` registers the session (Codex calls it before it writes the rollout, so the hook may name none yet), `Stop` saves each turn, and `SessionEnd` saves the rest and runs `braid verify`; Codex gives a `SessionEnd` hook three seconds at most, so the hook starts that work in the background and returns. A rollout is read like a Claude Code transcript, in bounded windows from a cursor, with ATXF's Codex converter. Its lines carry no ids, so each record is named after its line in the file and the session, `codex-<line>@<session>`, the same in any window; each record's parent is the record before it. As for Claude Code, each record keeps the line it was read from, Codex's bookkeeping too (turn settings, token counts, events, what Codex knew of the environment), and the first line, the session's metadata, is a record of its own, the root of the rest. A fork into Codex writes each line Codex wrote as it wrote it, the lines on the context path and those after the fork's head, with the newest session_meta under the new id, time and directory, and converts only the records of other agents, so Codex resumes a fork of a Codex session as it resumes the rollout itself. Codex appends to a rollout braid wrote when it resumes one, so the first lines of such a rollout are copies of the session it continues: braid notes how many, saves only what Codex adds after them, and links the first of those to the head of the session the rollout continues, so it joins that conversation. `braid verify` checks that a fork of a Codex session ends with the lines Codex wrote for it, as it wrote them, and that the history Codex rebuilds from the rollout, without the context Codex gives again when it resumes, is the history it rebuilds from the fork. `npm run check:resume -- --to codex <rollout>` resumes the rollout and a fork in Codex against a local server and compares the two requests byte for byte, but for the ids Codex derives from the session's id.

Harnesses name their tools differently: Claude Code edits with `Edit`, Codex with `apply_patch`, and Codex runs commands with `exec_command`. `braid log` counts the files a turn edited from both: Claude Code's edit tools name a path, and a Codex patch names each file in a header.

## CLI

The skills and the hooks call the CLI. You rarely need it yourself.

| Command | |
|---|---|
| `braid init [--undo]` | once per machine: a `braid` command in `~/.local/bin`, braid's part of the status line, and braid's hooks in `~/.codex/hooks.json` when Codex is installed; and the `.braid` folder of the project it runs in. It moves 0.1's conversations into their projects and saves the conversation it runs in. `--undo` puts back the previous status line and takes the hooks out of Codex |
| `braid status` | this session: its newest turn, what it is about, its latest recap, where it is kept and the worktree it ran in, and branches waiting to be merged |
| `braid sessions` | the sessions the project keeps, newest first, each with its newest turn, title, agent and worktree |
| `braid log [<session>] [--records]` | a session's turns along its line, each by name with what it did; `--records`: each record of the session under its turn |
| `braid fork [<session>\|<session>.<n>\|.<n>] [--cwd <path>] [--to claude-code\|codex] [--new]` | the command to continue a session, or one from the end of its turn n, in a new window, in Claude Code or Codex: the agent it runs in unless `--to` names the other; with no target, this one. The same fork asked for again is the same session; `--new` writes another |
| `braid merge [<session>]` | what another session has that this one lacks; `--record` and `--skip` write the merge |
| `braid verify [<session>\|--all]` | check that a session was saved as it happened and loads back the same |
| `braid save` | save this session now; the Stop hook does it after each turn |
| `braid migrate` | move conversations from 0.1's `~/.braid` into the projects they ran in, each conversation whole, to the project its first session ran in |

A session is addressed by its id or a unique prefix, or by the name you gave it with `/rename`. Inside an agent, commands act on the current session, which braid takes from `BRAID_SESSION`, else from Claude Code's `CLAUDE_CODE_SESSION_ID` or Codex's `CODEX_THREAD_ID`.

## Prior art

| Project | What it does | Relation to braid |
|---|---|---|
| [Entire](https://docs.entire.io/overview) | records sessions per commit in the repository, with an `Entire-Checkpoint` trailer | closest in storage; braid plans to import its checkpoints |
| [git-ai](https://github.com/acunniffe/git-ai) | line-level agent attribution in git notes | complementary |
| [Agent Trace](https://agent-trace.dev/) | draft spec linking code ranges to conversations | an Agent Trace record could point to a braid session |
| [Traces](https://www.traces.com/docs) | hosted sharing of sessions by link | braid keeps sessions in the project, on your machine |
| [casr](https://github.com/Dicklesworthstone/cross_agent_session_resumer) | converts sessions between harnesses | a possible backend for forking across harnesses |
| [Forky](https://github.com/ishandhanani/forky), [ContextBranch](https://arxiv.org/pdf/2512.13914) | branching and merging single-user chats | braid applies the idea to coding-agent sessions, across agents |

braid adds session ids and turn names as handles, forks between Claude Code and Codex, and merges with an instruction from inside a session.

## Distribution

braid ships as a Claude Code plugin served from this repository. The plugin carries the hooks, the skills and the CLI, which is one bundled file (`dist/braid.mjs`, built from `src/` with esbuild) that needs only Node 22. Installing the plugin is the whole install, and `/braid:init` adds the `braid` command and the status line. `claude plugin update` installs a new version when the version number changes. `braid init` adds braid's hooks to Codex, which reads the same skills and Claude-style plugin manifests, so the skills come to Codex next.

## Status of v0.2

Built, for Claude Code and Codex:

- **Saving:** each turn is appended to the session's file in the project's `.braid` folder, read incrementally in bounded windows; Claude Code's subagents are saved with their session. Codex sessions are saved through braid's hooks in Codex, and a session continued in the other agent joins its conversation. Worktrees share their main checkout's folder. `braid verify` checks that a session was saved as it happened, and that a fork written from its file holds the lines the agent reads to resume it; it runs when each session ends. `npm run check:resume` resumes a session and its fork against local servers and compares the requests, byte for byte within an agent and item by item across them.
- **Turns:** every turn has a name, `<session>.<n>`, numbered along the session's line. `braid log` lists them with what each did, and the status line names the newest.
- **Forks and merges:** `/braid:fork` prints the command that continues this session, another, or any turn of either, in a new window, in Claude Code or Codex; Claude Code's `/branch` is recorded as a branch; `/braid:merge` merges or skips a waiting or named session.
- **Titles and recaps:** the status line and `braid status` show what a session is about, and resuming a session shows it too.

`npm test` runs these flows through the CLI, with no mocks.

Next:

1. A web interface over a project's `.braid` folder, to read sessions and pick turns to train agents on, with redaction and edits before anything leaves the machine.
2. Codex: the skills, its subagents (each a rollout of its own), and its own forks (`codex fork`), which braid saves as sessions of their own for now.
3. Sharing again, on the `git-sharing` branch's design or through the web interface.

Open questions:

- **ATXF maturity.** ATXF is a v0.1 draft. Each record keeps its native line, so any conversation can be converted again into a successor format.
- **Counting.** `↓` counts messages and merges. Turns may read better.
- **OpenAI's compaction.** With OpenAI as its provider, Codex can compact on OpenAI's side, and the summary that comes back is for OpenAI's models alone. A fork into Claude Code would hold the messages that compaction kept, without the summary. braid has been checked against Codex's own compaction, not against a rollout compacted this way.
- **Long sessions** need range summaries for merges.
- **Name.** `braid` is taken on npm, so the package is `@gbarbalinardo/braid`.

braid started from a different idea: a chain of agents improving a numeric goal by a kind of gradient descent, with an LLM writing the gradients. The design keeps room for it without new primitives: an agent's parameters are a skill file, a step is a commit, the forward pass is linked sessions, a gradient is a critique passed back, the score is an evaluator's record, candidate steps are forks, and combining gradients is a merge with an instruction.
