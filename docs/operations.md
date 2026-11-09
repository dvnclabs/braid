# Operations and CLI

This is the planned command-line interface. Every command maps to a library call, so agents, skills and scripts can do everything the CLI does.

## Addressing

| Form | Meaning |
|---|---|
| `conv-01JC8Q4W5T` | a conversation, at its active leaf |
| `conv-01JC8Q4W5T:review/bob` | a named branch, at its head |
| `conv-01JC8Q4W5T@r4` | a single record |
| `./conversations/pr-128` | a conversation folder on disk |
| `pr:128` | the conversations attached to pull request 128 |

Inside a repository with one active conversation, the conversation id can be left out: `braid merge review/bob`.

## Commands

### Setup and capture

| Command | What it does |
|---|---|
| `braid init` | Configures the repository: fetch refspec for `refs/braid/*`, a `prepare-commit-msg` hook for the trailer, and a `.braid/` folder for strategies and settings |
| `braid import <harness> [<session-id> \| --latest]` | Reads a native session and creates a conversation. `--into <conv>` appends to an existing one |
| `braid list` | Lists conversations in the repository and in `.braid/` |
| `braid log <conv> [--graph]` | Shows records and branches; merges show their instruction |

### Branching and combining

| Command | What it does |
|---|---|
| `braid fork <conv> [--at <record>] --name <branch>` | Starts a named branch |
| `braid reconcile <a> <b>` | Unions two copies of the same conversation, deterministic and without an LLM |
| `braid merge <into> <from>... [options]` | Writes a merge record that brings `<from>` into `<into>` |

### Loading and sharing

| Command | What it does |
|---|---|
| `braid load <source> [--harness <h>] [--mode replay\|briefing]` | Opens a conversation in a harness, on a new branch |
| `braid save <conv> <dir> [--embed-native]` | Writes the conversation folder |
| `braid push [<conv>]` / `braid pull` | Syncs `refs/braid/*` with the remote, redacting on push |
| `braid digest <conv>` | Writes a reviewer-oriented summary in Markdown |
| `braid export --atif <conv>[:<branch>]` | Writes an ATIF `trajectory.json` |
| `braid pr open \| review \| load \| sync` | The pull request workflow; see [pr-review.md](pr-review.md) |

## Merge

```
braid merge <into> <from>...
    -p, --prompt "<text>"       instruction, inline
    -F, --prompt-file <path>    instruction from a file; "-" reads stdin
    -s, --strategy <name>       named strategy; -p text is appended to it
    --model <provider:model>    model that writes the merge
    --dry-run                   print the merge record, write nothing
    --continue [-p "<text>"]    resolve conflicts from a pending merge
    --abort                     discard a pending merge
```

### Inputs to the model

1. **The merge base**, the newest record that every head descends from. braid summarizes the path from the root to the base once and caches it as shared context.
2. **Each branch since the base**, projected with speaker labels, so the model knows who said what and in which harness.
3. **The instruction.**

Only the divergent parts of each branch go to the model in full. That keeps merges cheap on long conversations and focuses the model on what changed.

### Writing the instruction

With `-p`, `-F` or `-s`, the instruction comes from the flag. With none of them, braid opens `$EDITOR` on a template, the way `git commit` does:

```
# Merge review/bob into alice/jitter
# Base: e8 "sendWebhook now retries 5xx responses up to 3 times..."
#
# alice/jitter: 4 records since the base (alice@example.com via claude-code)
#   - added full jitter to the backoff in src/webhooks/retry.ts
#
# review/bob: 5 records since the base (bob@example.com via codex)
#   - questioned the fixed count of 3 retries
#   - found WEBHOOK_TIMEOUT_MS = 30000 in src/config.ts
#   - recommends retrying until that deadline
#
# Write the merge instruction below. Lines starting with # are ignored.
# An empty instruction uses the default strategy.
```

### Output and conflicts

The model returns a summary and a list of conflicts: points where the branches reached incompatible decisions that the instruction does not settle.

- **No conflicts:** braid appends a `branch_summary` record to `<into>` and moves the active leaf to it.
- **Conflicts:** braid stores a pending merge in `.braid/MERGE_STATE` and prints each conflict with the position of each branch. Resolve them with another instruction, as many times as needed:

```sh
braid merge --continue -p "go with the reviewer on retries, keep the author's naming"
```

### Strategies

A strategy is a reusable instruction, kept in `.braid/strategies/<name>.md` and versioned with the repository so the whole team shares it:

```markdown
---
name: review
description: Bring review findings into the author's branch
---
You are merging a code review into the author's working conversation.
For each finding, state the decision taken, who proposed it, and the evidence
the reviewer cited. List questions the review left open. Mark a conflict
wherever the reviewer and the author reached incompatible decisions.
```

Built-in strategies: `default` (combine what each branch learned and list contradictions), `review` (above), `prefer-into` and `prefer-from` (on a conflict, keep the decision of one side and record the other as a rejected alternative).

Strategies use the same Markdown-with-frontmatter layout as agent skills, so a strategy that grows scripts can become a skill without conversion.

### Provenance

Every merge record stores its base, heads, instruction, strategy and model ([format.md](format.md#the-extbraid-fields)), and `braid log` prints them. Model output varies between runs, so braid keeps the merge it wrote and never recomputes it. `braid merge --redo <record>` writes a new merge from the same inputs on a new branch.

## Load

`braid load` always works on a new branch named after the viewer, such as `bob/1`, so loading never changes what the author wrote.

**Replay** (same harness). The adapter rebuilds the native session file from `raw/`, rewrites absolute paths to the local checkout, places the file where the harness looks for sessions, and starts the harness's resume command.

**Briefing** (any harness). braid projects the branch for the viewer and writes a briefing: the goal, decisions with their reasons, open questions, files touched, commands run and their results, and where the conversation stopped. It starts the harness with the briefing as the first message, or prints it with `--print`.

**Repository drift.** The conversation records the commit it started from. When the local checkout has moved on, braid adds a summary of `git diff <commit>..HEAD` to the briefing, or as a user message in a replay, so the agent knows which files changed under it.

**Bringing new work back.** Records the harness writes after a load are imported into the viewer's branch, either by a harness hook at the end of the session (Claude Code's `SessionEnd`, for example) or with `braid import --into`.
