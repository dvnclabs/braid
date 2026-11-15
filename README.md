<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo-light.svg" alt="3raid" height="72">
  </picture>
</p>
<p align="center"><a href="https://dvnclabs.github.io/braid/">dvnclabs.github.io/braid</a></p>

**Efficient session manager.** braid saves every Claude Code and Codex session as it happens, in the project it runs in, as plain files you can read and search. You can go back to any turn and continue it in a new window, in either agent.

> **v0.3, for Claude Code and Codex.** Sessions are kept in each project's `.braid` folder, one self-contained file each, and nothing leaves your machine. Version 0.1 kept them in a git repository of braid's own and could share them through a code repository's remote; that design is on the [`git-sharing`](https://github.com/dvnclabs/braid/tree/git-sharing) branch. See [Status of v0.3](docs/design.md#status-of-v03).

## Install

You need Node 22 or later and git. In Claude Code:

```
/plugin marketplace add dvnclabs/braid
/plugin install braid@braid
/braid:init
```

`/braid:init` installs the `braid` command and braid's part of the status line, and saves the conversation you run it in, from its first turn. From then on braid saves every session after each turn. It also moves conversations braid 0.1 kept in `~/.braid` into the projects they ran in.

When Codex is on the machine, `braid init` also adds braid's hooks to `~/.codex/hooks.json`, so braid saves Codex sessions the same way. Codex runs a new hook only once you trust it: open `/hooks` in Codex once and trust braid's three. Without Claude Code, clone this repository and run `node dist/braid.mjs init` in a terminal.

## Where sessions are kept

```
<project>/.braid/
  .gitignore              *   (git does not see the folder; no file of your project changes)
  sessions/<id>.jsonl     the session in ATXF, one record per line, appended after each turn
  sessions/<id>.json      its state: where saving stopped, its title, its newest turn, the worktree it ran in, what it was forked from
```

A project is a git repository's main checkout, so every worktree of it saves into the same folder, and deleting a worktree keeps its sessions. Outside any repository, a session is kept in the `.braid` folder of the folder it started in. Each file holds a whole session: a fork, or a copy made with `/branch`, is saved as a session of its own, with the history it was made from. The files are [ATXF](https://github.com/leostera/atxf), an open format for agent transcripts, and every line keeps what the agent wrote, byte for byte.

## Use

Work with Claude Code or Codex as usual. The status line shows the session braid is saving and what it is about:

```
braid · 5b0e2c1a.12 · Webhook retries
```

| | |
|---|---|
| `5b0e2c1a.12` | this session, at its twelfth turn |
| `Webhook retries` | what it is about: the name you gave it with `/rename`, else Claude Code's title for it, else its first prompt |
| `⚠ braid verify` | the last check of this session found a problem: run `braid verify` |

**Go back.** Every turn has a name, `<session>.<n>`: a prompt you typed and everything the agent did until it stopped is one turn. `braid log` lists them, with what each did:

```
$ braid log
5b0e2c1a.1    Plan the cache.
5b0e2c1a.2    Write the cache.  (2 files edited, 2 tool calls)
5b0e2c1a.3    Thanks.
```

`/braid:fork 5b0e2c1a.2`, or `.2` for the session you are in, gives you the command to continue the conversation from the end of that turn, in a new window. The fork's file holds turns 1 and 2 too, so it continues the numbering: its first new turn is `.3`. In place of the id, the name you gave a session with `/rename` works too, as in `cache-work.2`. `/braid:fork` alone branches the conversation as it is now, and `braid log --records` lists every record under its turn.

**Claude Code and Codex.** A session is braid's own, whichever agent wrote it, and it continues in either. `braid fork --to codex` writes this conversation, or `braid fork <session> --to codex` another, as a new Codex session, and gives you `cd <dir> && codex resume <id>`. `braid fork <session> --to claude-code` writes a Codex session as a new Claude Code session; a fork continues in the agent you ask from, unless you name another. Asking for the same fork again gives back the session it wrote, and `--new` writes another. Each agent gets the conversation as the other's model read it: messages, tool calls and their results. Reasoning stays behind, since only the provider that wrote it can read it back, and so does each agent's own bookkeeping, so a session that goes to the other agent and back keeps the conversation without those.

**Come back.** When you resume a session, or open a fork of one, braid shows what it is about: `braid · 5b0e2c1a.12 · Webhook retries`. In Codex, which writes no recaps, it adds Claude Code's latest recap of the session too. `braid status` shows both, where the session is kept, the worktree it ran in and what it was forked from, and `braid sessions` lists every session of the project.

| Command | |
|---|---|
| `/braid:init` | set up braid on this machine and in this project, and save this conversation |
| `/braid:status` | this session's newest turn, what it is about, and where it is kept |
| `/braid:fork [session \| session.N \| .N] [--to codex]` | the command to continue this session, another one, or one from the end of its turn N, in a new window, in Claude Code or Codex |

Asking in plain language works too: "fork this from turn 4 into Codex".

## Saved correctly

`braid verify` checks a session the way `git fsck` checks a repository, and braid runs it by itself when each session ends:

- **saved**: every record of the transcript, and of each subagent's, up to where the last save stopped, is in the session's file with the same content and in the same order. Lines written since, as in a session still running, are noted for the next save.
- **loads**: a fork written from the session's file holds, line for line, what Claude Code reads to resume the transcript: the messages and tool calls, the results of parallel calls, notes and files attached to them, messages typed while the agent worked, what a compaction kept, and the session's settings. For a Codex session, the history Codex rebuilds is the same from the fork as from the rollout.
- **file**: the file reads back, and every record's parent is saved

```
$ braid verify --all
braid verify 9e36aa15.41: ok
  ✓ saved: 1211 records of the transcript
  ✓ loads: 53 lines since the last compaction, the same in a fork as in the transcript
  ✓ file: 1211 records, each with its parent
```

`npm run check:resume -- <transcript.jsonl>...` goes one step further: Claude Code resumes the session and a fork braid writes from its file, against a local server that records the request Claude Code would send to the model, and the two requests are compared byte for byte. With `--to codex`, Codex resumes the fork instead, and the conversation in its request is compared with Claude Code's, item by item. Given a Codex rollout, Codex resumes the original and Claude Code the fork. No model is called and nothing leaves the machine.

## How it works

braid's hooks in Claude Code and Codex save each turn when it ends: they read only what the agent wrote since the last save, convert it with ATXF's converters, and append it to the session's file. A fork writes the conversation as the target agent writes its own sessions, so the agent resumes it as it resumes its own. braid calls no model of its own. [docs/design.md](docs/design.md) covers the model, storage, turns, forks and the format.

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
