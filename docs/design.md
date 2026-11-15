# Design

braid is an efficient session manager: it saves every coding-agent session as it happens, in the project it runs in, and lets you go back to any turn and continue it in Claude Code or Codex. This document describes its design; [Status of v0.4](#status-of-v04) lists what is built and what comes next. The [README](../README.md) covers installation and use.

Version 0.1 kept every conversation in a git repository of braid's own, `~/.braid`, and could publish sessions to a code repository's remote for teammates and pull request reviews. Version 0.2 kept each project's sessions as plain files in the project, and left sharing out for now; version 0.3 made each file a whole session, and left out merging and the links between sessions that came with it; version 0.4 compresses the files. Sharing's design is that design is on the [`git-sharing`](https://github.com/dvnclabs/braid/tree/git-sharing) branch. `braid migrate` moves 0.1's conversations into their projects.

- [Model](#model)
- [Storage](#storage)
- [Status](#status)
- [Turns and forks](#turns-and-forks)
- [Format](#format)
- [Harnesses](#harnesses)
- [CLI](#cli)
- [Prior art](#prior-art)
- [Distribution](#distribution)
- [Status of v0.4](#status-of-v04)

## Model

A **session** is what one agent writes under one session id: a Claude Code session, a Codex thread. Its records are appended and never edited, and its **head** is the newest of them. braid names a session by its id, shortened as git shortens commit hashes (`5b0e2c1a`), or by the name you gave it with `/rename`. A session's file holds the whole conversation the agent resumes from, so every file reads on its own.

A **turn** is a prompt you typed and everything the agent did until it stopped. Turns are named `<session>.<n>`.

A **fork** is a new session written from another, at its end or at the end of any turn, for Claude Code or Codex. Its file holds the history it was written from, then what it adds; its state notes where it came from (`a fork of 5b0e2c1a.7`). A copy Claude Code makes with `/branch` is a fork too.

Every record has an author: the **actor**, a person or account (`alice@example.com`), and the **user agent**, the software that wrote it (`claude-code/2.1`).

**Record ids** come from the agent where it assigns them; Claude Code gives every entry a uuid. Otherwise braid derives the id from the session id and the record's line in the native file, so reading the same file twice yields the same ids.

## Storage

Each project keeps its sessions in a `.braid` folder:

```
<project>/.braid/
  .gitignore                    *: git does not see the folder, and no file of the project changes
  sessions/<id>.jsonl.gz        the session's records in ATXF, one per line, gzip-compressed, appended each turn; its subagents' too
  sessions/<id>.json            its state: where the last save stopped, its title and recap, its newest turn,
                                the checkout it ran in, what it was forked from, the last braid verify
  cache/                        what the status line caches
```

A **project** is a git repository's main checkout, the one that holds the `.git` its worktrees share, so a session in any worktree is kept in the main checkout's folder, and deleting a worktree keeps its sessions. For worktrees of a bare repository, the folder is inside the bare repository. Outside any repository, the project is the folder a session started in. A session stays in the project where it was first saved, which braid notes in `~/.local/share/braid/sessions/<id>.json`; commands that name a session another project keeps find it there.

The files are JSON lines in gzip, so anything can read them: `zcat`, `zgrep`, Python's `gzip`, a browser's `DecompressionStream`, a web interface, a training pipeline. Each save appends one gzip member, which compresses on its own, so nothing written is ever rewritten, and a gzip reader reads the members as one stream. A session takes about a third of its transcript's size (each record keeps the agent's line and its ATXF form, about one and a half times the transcript, which gzip shrinks about 3.4 times), and a 100 MB session reads back in about a tenth of a second. A save cut short, as by a crash while it wrote, leaves a last member that does not decode whole: braid reads what decodes, and `braid verify` reports it. A session braid 0.2 kept uncompressed, `<id>.jsonl`, reads as it is, and is compressed whole on its next save. Nothing leaves the machine, and braid calls no model of its own.

### Saving

An agent's hook saves at the end of each turn, and during a turn: after a tool call, when the agent wrote lines since the last save and no save started in the last ten seconds, the PostToolUse hook starts one in the background and returns, so the hook costs a tool call about 30 ms. An agent that crashes, or is force-quit, runs neither its Stop nor its SessionEnd hook, but what it wrote is in its transcript: whenever a session starts on the machine, its SessionStart hook runs `braid save --pending` in the background, which saves every session braid knows whose transcript, or a subagent's, has lines past its last save. A session counts once it ran: saved before, registered by its agent's hook, or, for a fork braid wrote, grown past the size braid wrote, as one continued where braid's hooks do not run. A fork nobody opened stays unsaved. braid reads a transcript up to its last whole line, so a line the agent was writing when it stopped is read once it is whole. What is lost is only what the agent never wrote: a response it was still streaming.

Each save converts only what the agent wrote since the previous save with [ATXF](https://github.com/leostera/atxf)'s converter, and appends those records to the session's file. braid keeps a cursor per session: the byte offset where the previous save stopped, the number of lines before it, and a hash of the line that ends there. Each save reads from the cursor, plus an overlap of at least 2 MB and the whole previous line, so that references across the boundary resolve; records without a uuid are named after their line in the whole file. Only the lines after the cursor are saved, so each line is saved once. Claude Code sometimes writes a line again under the uuid it already has, as it does for some results after a resume; that copy is saved as a second record with the same id, and a fork writes both lines, as the source has them. When the file is shorter than the cursor or its last line changed, braid reads it again from the start and keeps the records the session's file lacks. The first save of a large session reads it in windows of 16 MB.

Claude Code writes each subagent to its own file next to the transcript. braid saves new subagent records in the file of the session that spawned them, each marked with the subagent's id (`ext.braid.agent`), and adds an `agent_link` record below the tool call that spawned each one.

Each record keeps its native line in ATXF's `native` field, so braid can give back the agent's file byte for byte. A save appends, so it costs about the size of what the turn added. Agents delete old transcripts (Claude Code after 30 days by default), and the project's `.braid` folder keeps them.

Sessions from before braid was installed are saved when asked: `braid save --all` finds every Claude Code transcript under `projects/` and every Codex rollout under `sessions/`, reads the folder each session started in from the start of its file, and saves those whose folder is in this project, in any of its worktrees. A session saved already gets only what it wrote since. A session whose folder is gone, as a removed worktree's, cannot be told apart from another project's and is left out. `braid init` says how many are waiting.

## Status

The status line shows the session braid is saving, by the name of its newest turn, and what it is about:

```
braid · 5b0e2c1a.12 · Webhook retries
```

| Shown | Meaning |
|---|---|
| `5b0e2c1a.12` | this session, at its newest turn, by the name `braid fork` takes |
| `Webhook retries` | what the session is about: the name you gave it with `/rename`, else the agent's title for it, else its first prompt, with credentials hidden |
| `⚠ braid verify` | the check braid ran when the session last ended found a problem |

braid computes the line from the session files, so it costs no tokens and stays out of the model's context. The `braid` label and the separators are dimmed and `⚠` is red; `NO_COLOR` turns colors off. braid runs the status line you had before, first.

When you resume a session, or open a fork of one, a hook shows what it is about: `braid · 5b0e2c1a.12 · Webhook retries`, and for a fork `, a fork of <session>`. braid keeps the title, and the latest recap Claude Code writes when you come back to a session, from the records it saves. Claude Code shows its own recap again when it resumes a session, so braid adds the recap only in Codex, which writes none. `braid status` shows both. Neither goes into the model's context.

## Turns and forks

### Turns

A turn is a prompt you typed and everything the agent did until it stopped. Its name is `<session>.<n>`: `5b0e2c1a.12`, or `.12` for the session you are in, and the session part can be any name braid finds the session by, such as the one you gave it with `/rename`. Turns are numbered in the order of the session's file, and a fork's file holds the history it was written from, so a fork continues the numbering: forked after `5b0e2c1a.7`, its first new turn is `.8`, and `<fork>.5` is its copy of the fifth. Numbers never change, since braid only appends records.

braid tells a prompt from what an agent writes in the user's place by what the agent writes on the line, with no model: Claude Code marks tool results, notes, notices and summaries (`isMeta`, `origin`, `toolUseResult`, `isCompactSummary`), and what remains, such as command output, reminders and an interruption, opens with a tag of the agent's own. Codex's context and notes open with fixed tags too. A command you type, such as `/braid:init`, is a turn. `braid fork <session>.<n>` continues from the end of turn n, as `git checkout` gives a commit with its change: to do turn n again, fork from `.<n-1>`. A turn ends with the agent's last answer: a compaction after it, which Claude Code runs as the next prompt goes out, starts the next turn, so a fork from turn n holds turn n as it was, and one from turn n+1 holds the compaction's summary, what it kept, and turn n+1. A compaction in the middle of a turn, during a long run of tool calls, is that turn's. `braid log` lists the turns along the line, with the files each edited and its tool calls; the status line and the line shown on resume name the newest.

### Fork

A session cannot open a terminal window, so `/braid:fork` prints the command that continues the fork in a new one, `cd <dir> && claude --resume <id>`.

- **This conversation.** `braid fork` prints `claude --resume <id> --fork-session`; Claude Code's `/branch` does the same in the current window. Both copy the transcript under a new session id, and braid saves the copy like any session, whole. Forking another of your Claude Code sessions on this machine works the same way.
- **Another session, or a turn of one.** `braid fork <id|name|<session>.<n>|.<n>> [--cwd <path>]` writes the session as a Claude Code transcript under a new session id, where `claude --resume <id>` finds it. The fork is the lines Claude Code wrote, as it wrote them: everything the session wrote since its last compaction up to the fork point, in order and with the same links between lines, and the messages that compaction kept. Claude Code reads more than the chain of messages to resume a session: the rest of a parallel response and the results beside the chain, notes attached to results, messages typed while the agent worked, files the user named, how the tools it may call changed (also on branches left behind by a rewind), and the session's mode and permissions. A fork holds all of it, so Claude Code resumes the fork as it resumes the source. Only the source's request log, file history, input queue and last prompt stay behind. A fork rewrites the source checkout's path to this one when it is another checkout, outside reasoning blocks, whose signatures cover them. Each line takes a uuid derived from its record's id, and every mention of another line, outside the message, follows it. The new session's saves keep the whole file, the copied history included.
- **With a prompt.** What follows the session or turn is the prompt the fork starts with, as `claude --resume <id> <prompt>` and `codex resume <id> <prompt>` take one: `braid fork .5 "try the other approach"`. It comes last so that a long prompt, over several lines, does not hide what is forked; braid quotes it whole in the command it prints. With no session named, a first argument with a space in it that names no session is the prompt, for this session. A fork asked for again is the same session, but a prompt starts a new direction: when that fork was continued already, braid writes another.
- **Into another agent.** `braid fork [<target>] --to codex` writes the session, this one when no target is named, as a new Codex session: a rollout in `$CODEX_HOME/sessions/YYYY/MM/DD/`, which `codex resume <id>` finds by its id. It holds the conversation as the model read it, in the order the model took it: what the user and the agent said, each tool call with the arguments the model gave it and its id, and each result, a batch of parallel calls before its results and the results before the notes on them. A failed call's result is its text, as Codex keeps results. A message the user typed while the agent worked, which Claude Code attaches to the turn, is a user message. What Claude Code wrote into the conversation for its model and did not show, such as the text of a skill the agent loaded, where an image came from, a message from another session or a notice that a background task finished, is a developer message. After a compaction, the fork starts with Codex's own record of one, the summary, followed by the messages the compaction kept. What only Claude Code's model can use stays behind: reasoning, which its signature binds to the provider that wrote it, the model setting, the harness's own reminders, hook output and token counts, and the record of its slash commands. Codex adds its own instructions, tools and environment when it resumes, and shortens long results in what it sends. Paths move as in any fork. `npm run check:resume -- --to codex <transcript>` resumes the original in Claude Code and the fork in Codex, against local servers that record each request, and compares the conversation in the two, item by item, allowing for how each agent presents it: the notes each adds, results neither recorded, Codex's shortening, and the few ways Claude Code rewrites a call's arguments when it sends them.
- **From another agent.** A Codex session forks into Claude Code the same way, with `braid fork <target> --to claude-code` (a fork continues in the agent it is asked from, unless another is named): ATXF's converter writes the context path, each response as one message, a line per block under the response's id, as Claude Code writes a response, so a batch of parallel calls goes back as one message and its results after it. A record Claude Code takes nothing from, such as Codex's turn settings, token counts and events, passes its place in the chain to the next. What Codex gives its own model in the conversation stays behind, as Claude Code gives its own: its instructions (developer messages), the environment, and the AGENTS.md files it read, also from what a compaction kept. What Codex wrote for its model in the user's place, such as a skill's text or a note that the user interrupted a turn, is a note (`isMeta`). After a Codex compaction, the fork starts with what Codex put in place of the history: the user's messages it kept and its summary. Codex's reasoning stays with OpenAI. A custom tool's call, such as `apply_patch`, whose input is text, goes as `{"input": <text>}`. Given a Codex rollout, `npm run check:resume` resumes the original in Codex and the fork in Claude Code, and compares the conversation the same way.
- **The same fork twice.** A fork braid writes takes a session id derived from what it forks: the session, the point it forks from, the agent and the directory. Asked for again, braid gives back the session it wrote the first time, as it stands, continued or not, and writes nothing. A fork from a later point is another session, and `--new` writes another one from the same point.

A fork is saved in the project it runs in, as any session is. Since its file holds converted copies of the history, a session that goes to the other agent and back keeps the conversation, its messages, tool calls and results, without what only one agent keeps: Claude's signed reasoning, Codex's events and token counts.

## Format

Native session files are the source of truth for what an agent wrote, and braid keeps their lines byte for byte. The tree is [ATXF](https://github.com/leostera/atxf) 0.1, which models branches, rewinds, compaction, subagents and verbatim native records. Everything braid adds is valid ATXF, under the `ext.braid` namespace, so any ATXF reader can open a braid session file, and a web interface or a training pipeline can read the files of a project's `.braid` folder as they are.

| braid | ATXF |
|---|---|
| session id | header `id` |
| messages, reasoning, tool calls and results | `message` records and their content blocks |
| link to another session, subagent | `agent_link` |

| Where | `ext.braid` field | Meaning |
|---|---|---|
| header | `version` | version of these fields, `1` |
| any record | `actor.actorId`, `actor.userAgent` | who and what wrote it |
| any record | `session` | the session that wrote it |
| a subagent's records | `agent` | the subagent's id |

The ATXF 0.2 draft adds `actorId` and `userAgent` to every record envelope. braid will write them there once 0.2 is final, since 0.1 validators reject the new fields. [examples/pr-review](../examples/pr-review) is a complete conversation of braid 0.1's, with its review and merge, that validates against the 0.1 schema.

## Harnesses

A session is braid's own: its records, in ATXF, are the same whichever agent wrote them, and braid writes any session out for any agent it supports, as a new session of that agent's that continues it (`braid fork --to codex`). Each agent is an adapter: where its sessions live, how to read them, how to write a fork, and the command that resumes one.

| | Claude Code | Codex |
|---|---|---|
| sessions | `~/.claude/projects/<project>/<id>.jsonl`, subagents in `<id>/subagents/` | `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`, compressed or archived when old |
| saving | `Stop` hook, from the plugin | `Stop` hook, which `braid init` adds to `~/.codex/hooks.json` |
| the session a command runs in | `SessionStart` sets `BRAID_SESSION` through `CLAUDE_ENV_FILE`; Claude Code also gives commands `CLAUDE_CODE_SESSION_ID` | Codex gives the commands it runs `CODEX_THREAD_ID` |
| status | status line, after-turn line | after-turn line |
| commands | plugin skills: `/braid:fork`, `/braid:status`, `/braid:init` | the `braid` command; skills for Codex are next |
| resume a fork | `claude --resume <id>` | `codex resume <id>` |
| headless | `claude -p` | `codex exec` |

**Saving a Codex session.** `braid init` adds four hooks to `~/.codex/hooks.json`, next to any others there, and `braid init --undo` takes them out. Codex runs a hook only once the user trusts it, in `/hooks`. `SessionStart` registers the session (Codex calls it before it writes the rollout, so the hook may name none yet) and saves what crashed sessions left, `PostToolUse` saves a turn as it goes, `Stop` saves each turn, and `SessionEnd` saves the rest and runs `braid verify`; Codex gives a `SessionEnd` hook three seconds at most, so the hook starts that work in the background and returns. A rollout is read like a Claude Code transcript, in bounded windows from a cursor, with ATXF's Codex converter. Its lines carry no ids, so each record is named after its line in the file and the session, `codex-<line>@<session>`, the same in any window; each record's parent is the record before it. As for Claude Code, each record keeps the line it was read from, Codex's bookkeeping too (turn settings, token counts, events, what Codex knew of the environment), and the first line, the session's metadata, is a record of its own, the root of the rest. A fork into Codex writes each line Codex wrote as it wrote it, the lines on the context path and those after the fork's head, with the newest session_meta under the new id, time and directory, and converts only the records of other agents, so Codex resumes a fork of a Codex session as it resumes the rollout itself. Codex appends to a rollout braid wrote when it resumes one, and braid saves the rollout whole, the history braid wrote included. `braid verify` checks that a fork written from a Codex session's file holds the rollout's lines as Codex wrote them, and that the history Codex rebuilds from the rollout, without the context Codex gives again when it resumes, is the history it rebuilds from the fork. `npm run check:resume -- --to codex <rollout>` resumes the rollout and a fork in Codex against a local server and compares the two requests byte for byte, but for the ids Codex derives from the session's id.

Harnesses name their tools differently: Claude Code edits with `Edit`, Codex with `apply_patch`, and Codex runs commands with `exec_command`. `braid log` counts the files a turn edited from both: Claude Code's edit tools name a path, and a Codex patch names each file in a header.

## CLI

The skills and the hooks call the CLI. You rarely need it yourself.

| Command | |
|---|---|
| `braid init [--undo]` | once per machine: a `braid` command in `~/.local/bin`, braid's part of the status line, and braid's hooks in `~/.codex/hooks.json` when Codex is installed; and the `.braid` folder of the project it runs in. It moves 0.1's conversations into their projects and saves the conversation it runs in. `--undo` puts back the previous status line and takes the hooks out of Codex |
| `braid status` | this session: its newest turn, what it is about, its latest recap, where it is kept, the worktree it ran in, and what it was forked from |
| `braid sessions` | the sessions the project keeps, newest first, each with its newest turn, title, agent, worktree and what it was forked from |
| `braid log [<session>] [--records]` | a session's turns, each by name with what it did; `--records`: each record under its turn |
| `braid fork [<session>\|<session>.<n>\|.<n>] [<prompt>] [--cwd <path>] [--to claude-code\|codex] [--new]` | the command to continue a session, or one from the end of its turn n, in a new window, in Claude Code or Codex: the agent it runs in unless `--to` names the other; with no target, this one. A prompt, last, is the fork's first message. The same fork asked for again is the same session, unless it was continued and a prompt starts it in a new direction; `--new` writes another |
| `braid verify [<session>\|--all]` | check that a session was saved as it happened and loads back the same |
| `braid save [--all\|--pending]` | save this session now; the Stop hook does it after each turn. `--all`: every Claude Code and Codex session on the machine that ran in this project, in any of its worktrees, as those from before braid was installed. `--pending`: every session on the machine its agent wrote more of since braid last saved it, as one that crashed; each session's start runs it |
| `braid migrate` | move conversations from 0.1's `~/.braid` into the projects they ran in, each conversation whole, to the project its first session ran in |

A session is addressed by its id or a unique prefix, or by the name you gave it with `/rename`; an id finds a session another project keeps too. Inside an agent, commands act on the current session, which braid takes from `BRAID_SESSION`, else from Claude Code's `CLAUDE_CODE_SESSION_ID` or Codex's `CODEX_THREAD_ID`.

## Prior art

| Project | What it does | Relation to braid |
|---|---|---|
| [Entire](https://docs.entire.io/overview) | records sessions per commit in the repository, with an `Entire-Checkpoint` trailer | closest in storage; braid plans to import its checkpoints |
| [git-ai](https://github.com/acunniffe/git-ai) | line-level agent attribution in git notes | complementary |
| [Agent Trace](https://agent-trace.dev/) | draft spec linking code ranges to conversations | an Agent Trace record could point to a braid session |
| [Traces](https://www.traces.com/docs) | hosted sharing of sessions by link | braid keeps sessions in the project, on your machine |
| [casr](https://github.com/Dicklesworthstone/cross_agent_session_resumer) | converts sessions between harnesses | a possible backend for forking across harnesses |
| [Forky](https://github.com/ishandhanani/forky), [ContextBranch](https://arxiv.org/pdf/2512.13914) | branching and merging single-user chats | braid branches coding-agent sessions, across agents |

braid adds session ids and turn names as handles, and forks between Claude Code and Codex.

## Distribution

braid ships as a Claude Code plugin served from this repository. The plugin carries the hooks, the skills and the CLI, which is one bundled file (`dist/braid.mjs`, built from `src/` with esbuild) that needs only Node 22. Installing the plugin is the whole install, and `/braid:init` adds the `braid` command and the status line. `claude plugin update` installs a new version when the version number changes. `braid init` adds braid's hooks to Codex, which reads the same skills and Claude-style plugin manifests, so the skills come to Codex next.

## Status of v0.4

Built, for Claude Code and Codex:

- **Saving:** each turn is appended to the session's file in the project's `.braid` folder, as a gzip member, read incrementally in bounded windows; Claude Code's subagents are saved with their session. Codex sessions are saved through braid's hooks in Codex. Every file holds a whole session. Worktrees share their main checkout's folder. `braid verify` checks that a session was saved as it happened, and that a fork written from its file holds the lines the agent reads to resume it; it runs when each session ends. `npm run check:resume` resumes a session and its fork against local servers and compares the requests, byte for byte within an agent and item by item across them.
- **Turns:** every turn has a name, `<session>.<n>`, numbered in the session's file. `braid log` lists them with what each did, and the status line names the newest.
- **Forks:** `/braid:fork` prints the command that continues this session, another, or any turn of either, in a new window, in Claude Code or Codex; a fork, and a copy made with `/branch`, is saved as a session of its own.
- **Titles and recaps:** the status line and `braid status` show what a session is about, and resuming a session shows it too.

`npm test` runs these flows through the CLI, with no mocks.

Next:

1. A web interface over a project's `.braid` folder, to read sessions and pick turns to train agents on, with redaction and edits before anything leaves the machine.
2. Codex: the skills, its subagents (each a rollout of its own), and its own forks (`codex fork`), which braid saves as sessions of their own for now.
3. Sharing again, on the `git-sharing` branch's design or through the web interface.

Open questions:

- **ATXF maturity.** ATXF is a v0.1 draft. Each record keeps its native line, so any conversation can be converted again into a successor format.
- **OpenAI's compaction.** With OpenAI as its provider, Codex can compact on OpenAI's side, and the summary that comes back is for OpenAI's models alone. A fork into Claude Code would hold the messages that compaction kept, without the summary. braid has been checked against Codex's own compaction, not against a rollout compacted this way.
- **Name.** `braid` is taken on npm, so the package is `@gbarbalinardo/braid`.

braid started from a different idea: a chain of agents improving a numeric goal by a kind of gradient descent, with an LLM writing the gradients. The design keeps room for it without new primitives: an agent's parameters are a skill file, a step is a commit, the forward pass is linked sessions, a gradient is a critique passed back, the score is an evaluator's record, candidate steps are forks, and combining gradients is a summary written with an instruction.
