# braid

Version control for agent conversations. braid saves every Claude Code and Codex session into your git repository, ties it to the commits it produced, and publishes it when you `git push`. Reviewers can question the session behind a pull request, and you can merge their review sessions back into yours.

> **Design draft.** braid is not built yet. This repository holds the [design](docs/design.md), a [worked example](examples/pr-review) and a working [status line prototype](prototype/statusline). Feedback is welcome in issues.

## Install

Once per machine:

```sh
npm install -g braid    # planned; the package name is not final
braid install           # adds braid's hooks, status line and skills to Claude Code and Codex
```

Once per repository:

```sh
braid init              # installs the git hooks and writes .braid/config.toml
git add .braid && git commit -m "Set up braid"
```

Teammates who have run `braid install` need nothing more. braid sets up their clone the first time their agent opens it.

## Use

Work with your agent and use git as usual:

```sh
git commit -m "Retry webhook deliveries on 5xx"   # links the session behind the commit
git push                                          # publishes it, with secrets redacted
```

The status line shows where your session stands:

```
5b0e2c1a · #128 · ↑4 · ↓ review/bob +5 → /braid:sync
```

| | |
|---|---|
| `5b0e2c1a` | this session |
| `#128` | the pull request of this branch |
| `↑4` | 4 records not published yet |
| `↓ review/bob +5` | a session built on yours has 5 records you have not merged |
| `✓` | everything published, nothing waiting |

**Review a pull request.** Check it out and open your agent. It knows which sessions are behind the branch:

```
$ gh pr checkout 128 && codex
> review this PR. why a fixed 3 retries instead of the 30s timeout?
```

Your review session is published when it ends.

**Merge a review.** When `↓` appears, tell your agent what to keep:

```
> /braid:sync keep my jitter, adopt the reviewer's time budget
```

`/braid:sync skip review/bob` marks a review as seen without adopting it.

**Commands.** Everything above works without them. They are `/braid:…` in Claude Code and `$braid:…` in Codex, and asking in plain language works too.

| Command | |
|---|---|
| `sync [instruction]` | merge the sessions waiting in `↓`, or `skip` them |
| `load <session> \| #<pr>` | bring another session into this one, or replay it in a new session |
| `status` | everything the status line abbreviates |
| `withhold <range>` | keep part of this session from being published |
| `review-pr <n>` | review a pull request with consistency checks |

**Privacy.** Secrets are redacted before anything leaves your machine, and public repositories publish nothing until you turn publishing on. Anyone who can read the repository can read its published sessions. See [Publishing](docs/design.md#publishing) and [Trust](docs/design.md#trust).

## Try the status line

The status line works today. It needs `git` and `jq`:

```sh
git clone https://github.com/gbarbalinardo/braid
braid/prototype/statusline/test.sh
```

[prototype/statusline](prototype/statusline) shows how to add it to Claude Code.

## How it works

Each session lives on its own git ref under `refs/braid/`, in [ATXF](https://github.com/leostera/atxf), an open format for agent transcripts, next to the harness's own session file kept byte for byte. Your unredacted copy stays in `.git/braid/`, where no push can reach it. [docs/design.md](docs/design.md) covers the model, storage, publishing, trust, merging and review.

## License

[MIT](LICENSE)
