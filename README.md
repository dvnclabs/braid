<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo-light.svg" alt="3raid" height="72">
  </picture>
</p>
<p align="center"><a href="https://dvnclabs.github.io/braid/">dvnclabs.github.io/braid</a></p>

**Efficient session manager.** braid saves every coding-agent session as it happens, in git, on your machine. You can go back to any point of a conversation, fork it into a new window, edit it before anyone else sees it, and, when you choose, share it with your team next to the code it produced.

> **v0.1, for Claude Code and Codex.** braid saves the sessions of both, and any saved session continues in either. See [Status of v0.1](docs/design.md#status-of-v01) for what is built and what is planned.

## Install

You need Node 22 or later and git. In Claude Code:

```
/plugin marketplace add dvnclabs/braid
/plugin install braid@braid
/braid:init
```

`/braid:init` installs the `braid` command and braid's part of the status line, creates `~/.braid`, the braid repository where every conversation is kept, and saves the conversation you run it in, from its first turn. From then on braid saves every session on the machine, after each turn. Inside a git repository it also writes `.braid/config.toml` and `.braidignore` there, for the settings below.

When Codex is on the machine, `braid init` also adds braid's hooks to `~/.codex/hooks.json`, so braid saves Codex sessions the same way. Codex runs a new hook only once you trust it: open `/hooks` in Codex once and trust braid's three. Without Claude Code, clone this repository and run `node dist/braid.mjs init` in a terminal.

## Settings

braid starts on autopilot: it does everything by itself and nothing leaves your machine. Each setting is a line in `.braid/config.toml`, or in `~/.config/braid/config.toml` for every repository (yours wins), and `braid init --<setting>` or `--no-<setting>` changes it.

| Setting | Default | What it does |
|---|---|---|
| `autopilot` | on | braid keeps conversations on this machine, in the braid repository, and never pushes, fetches or asks GitHub anything. Off, it can share them through the code repository's remote. |
| `autofork` | on | before a turn that changes a lot (5 files edited, or 30 tool calls), braid marks the conversation as it stood (`braid fork @1`). Every turn has a name to fork from too, below. |
| `repo` | `auto` | the braid repository, which keeps every conversation apart from the code: `auto` is `~/.braid`; a path such as `~/work-convos` names another. |
| `autocommit` | off | each commit the agent makes commits the conversation too. Off, you commit it with `/braid:commit` after `/braid:edit`. |
| `autopush` | on in private repositories, off in public ones | off autopilot, `git push` publishes the committed part of the sessions behind the pushed commits. Off, `/braid:push` publishes. |

`braid init --no-git-hooks` leaves git alone.

## Use

Work with Claude Code as usual. The status line shows what your session is about and where it stands:

```
5b0e2c1a.12 Webhook retries · local
```

| | |
|---|---|
| `5b0e2c1a.12` | this session, at its twelfth turn |
| `Webhook retries` | what it is about: the name you gave it with `/rename`, else Claude Code's title for it, else its first prompt |
| `local` | saved on this machine only |
| `↑4` | 4 committed records not published yet |
| `*3` | 3 records since the last commit |
| `↓ review/bob +5` | a session built on yours, such as a review or a branch, has 5 records you have not merged |
| `⚠ braid verify` | the last check of this session found a problem: run `braid verify` |
| `✓` | everything published, nothing waiting |

Marks are in color: amber for work not yet published, magenta for a session waiting to be merged, red for a failed check, green when everything is published. `NO_COLOR` turns colors off.

**Come back.** When you resume a session, or open a fork of one, braid shows what it is about: `braid · 5b0e2c1a · Webhook retries`. In Codex, which writes no recaps, it adds Claude Code's latest recap of the session too. `braid status` shows the title and the latest recap.

**Go back.** Every turn has a name, `<session>.<n>`: a prompt you typed and everything the agent did until it stopped is one turn, and a merge is one too. `braid log` lists them, with what each did:

```
$ braid log
5b0e2c1a.1    Plan the cache.
5b0e2c1a.2    Write the cache.  (2 files edited, 2 tool calls)
              commit    Add the cache (3f9c2e1)
5b0e2c1a.3    Thanks.
```

`/braid:fork 5b0e2c1a.2`, or `.2` for the session you are in, gives you the command to continue the conversation from the end of that turn, in a new window. A fork continues the numbering: its first turn here is `.3` of its own. In place of the id, the name you gave a session with `/rename` works too, as in `cache-work.2`. `/braid:fork` alone branches the conversation as it is now, and `braid log --records` lists every record under its turn.

**Claude Code and Codex.** A session is braid's own, whichever agent wrote it, and it continues in either. `braid fork --to codex` writes this conversation, or `braid fork <session> --to codex` another, as a new Codex session, and gives you `cd <dir> && codex resume <id>`. `braid fork <session> --to claude-code` writes a Codex session as a new Claude Code session, and gives you `cd <dir> && claude --resume <id>`; a fork continues in the agent you ask from, unless you name another. Asking for the same fork again gives back the session it wrote, and `--new` writes another. Each agent gets the conversation as the other's model read it: messages, tool calls and their results. Reasoning stays behind, since only the provider that wrote it can read it back, and so do the instructions and environment each agent gives its own model. A session continued in the other agent is saved as part of the same conversation.

**Edit before sharing.** `braid edit`, in a terminal or through `/braid:edit`, lists the session as it would be published, one numbered line per record, after redaction:

```
$ braid edit
braid edit 5b0e2c1a: 9 records, nothing committed yet, 0 withheld, 1 redacted
Publishing goes up to the last commit. ↑ committed, not published yet · ✗ withheld · ✎ rewritten

 1   you     Why is the Acme import failing? My key is [REDACTED:aws-access-key].
 2   agent   → Read customers/acme.csv
 3   tool    name,revenue Acme,1200000
 4   agent   The CSV has no header row for region.
```

```sh
braid edit 2-3                 # withhold records; a tool call takes its result along
braid edit --rewrite 4         # rewrite a record in your editor; empty it to withhold it
braid edit --hide "Acme"       # hide a word in every record
braid edit --all               # keep the whole session back
braid edit .3                  # withhold a whole turn
braid edit --undo 2            # put any of it back
```

**Share with your team.** Turn autopilot off in the repository (`braid init --no-autopilot`), then edit, commit and push:

```
> /braid:edit
> /braid:commit Retry webhook deliveries
$ git push                             # with autopush, publishes the conversation up to that commit, redacted
```

**Review a pull request.** `/braid:review 128` reviews the change together with the sessions behind it. Commit the review, and it is published when the session ends.

**Merge.** A merge always goes into the conversation you are in. Name the other one by session id (or its first characters), by name such as `review/bob`, by `pr:128`, or leave it out to take the one waiting in `↓`:

```
> /braid:merge keep my jitter, adopt the reviewer's time budget
> /braid:merge review/bob take the naming fixes only
> /braid:merge skip review/bob
```

| Command | |
|---|---|
| `/braid:init` | set up braid on this machine and in this repository, change settings, and save this conversation |
| `/braid:status` | everything the status line abbreviates |
| `/braid:edit` | the session as it would be published; remove, rewrite or hide parts of it |
| `/braid:commit [message]` | commit the conversation; publishing goes up to the last commit |
| `/braid:push` | publish the committed part of this session now |
| `/braid:fork [session \| session.N \| .N] [--to codex]` | the command to continue this session, another one, or one from the end of its turn N, in a new window, in Claude Code or Codex |
| `/braid:merge [session] [instruction]` | merge another conversation into this one, or `skip` it |
| `/braid:review <N>` | review pull request N with the sessions behind it |

Asking in plain language works too: "pull in Bob's review but keep my jitter".

## Saved correctly

`braid verify` checks a session the way `git fsck` checks a repository, and braid runs it by itself when each session ends:

- **saved**: every record of the transcript, and of each subagent's, up to where the last save stopped, is in the store with the same content and in the same order. Lines written since, as in a session still running, are noted for the next save.
- **loads**: a fork written from the store holds, line for line, what Claude Code reads to resume the transcript: the messages and tool calls, the results of parallel calls, notes and files attached to them, messages typed while the agent worked, what a compaction kept, and the session's settings
- **store**: `git fsck` finds nothing wrong, and every record's parent is saved

```
$ braid verify --all
braid verify 9e36aa15: ok
  ✓ saved: 1211 records of the transcript
  ✓ loads: 53 lines since the last compaction, the same in a fork as in the transcript
  ✓ store: 1 chunks, git fsck
```

`npm run check:resume -- <transcript.jsonl>...` goes one step further: Claude Code resumes the session and a fork braid writes from its store, against a local server that records the request Claude Code would send to the model, and the two requests are compared byte for byte. With `--to codex`, Codex resumes the fork instead, and the conversation in its request is compared with Claude Code's, item by item. Given a Codex rollout, Codex resumes the original and Claude Code the fork. No model is called and nothing leaves the machine.

## Privacy

On autopilot nothing leaves your machine. Off autopilot, nothing is published until you commit it, and `braid edit` shows exactly what would go. Published copies hold the conversation's messages and tool calls only: reasoning, images and the harness's raw files stay on your machine, and common credentials are redacted before anything leaves it. Tool calls on the paths in `.braidignore` (same syntax as `.gitignore`; `braid init` starts it with `.env` files and keys) are never published. Teams add terms and patterns to redact in `.braid/redact.toml`. Anyone who can read the repository can read its published sessions. See [Publishing](docs/design.md#publishing) and [Trust](docs/design.md#trust).

## How it works

A conversation belongs to no code repository: a session can start in one repository, commit in two others, or run outside any. braid keeps every conversation in one git repository of its own, the braid repository (`~/.braid`), each session on its own git ref, in [ATXF](https://github.com/leostera/atxf), an open format for agent transcripts. Your unredacted copy stays there, where no push of the code can reach it; published copies go under `refs/braid/` on the remote of the code repository being pushed. No server or GitHub App is involved. [docs/design.md](docs/design.md) covers the model, storage, publishing, trust, merging and review, and [examples/pr-review](examples/pr-review) is a complete conversation between an author and a reviewer.

## Development

```sh
npm install
npm run check                                  # typecheck, tests, and the bundle in dist/
npm run check:resume -- ~/.claude/projects/*/*.jsonl   # forks resume in Claude Code as the originals do
npm run check:resume -- --to codex ~/.claude/projects/*/*.jsonl   # and Codex gets the conversation Claude's model read
npm run check:resume -- ~/.codex/sessions/*/*/*/rollout-*.jsonl     # and Claude Code the one Codex's model read
```

`dist/braid.mjs` is committed, because the plugin runs it straight from the repository. `npm run check` rebuilds it, so commit it together with the change to `src/`.

## License

[MIT](LICENSE)
