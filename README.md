# braid

Version control for agent conversations. braid saves every Claude Code session into your git repository, ties it to the commits it produced, and publishes it when you `git push`. Reviewers can question the session behind a pull request, and you can merge their review sessions back into yours.

> **v0.1, for Claude Code.** Codex support is next. See [Status of v0.1](docs/design.md#status-of-v01) for what is built and what is planned.

## Install

You need Node 22 or later and git. `gh` is optional: it adds pull request numbers to the status line.

In Claude Code, once per machine:

```
/plugin marketplace add gbarbalinardo/braid
/plugin install braid@braid
/braid:setup
```

Then, once per repository, run `braid init` (or ask Claude to set up braid here) and commit what it writes:

```sh
braid init
git add .braid && git commit -m "Set up braid"
```

`braid init` turns publishing on for private repositories and leaves it off for public ones, and installs git hooks so that git does the work: each commit the agent makes commits its conversation, and `git push` publishes it. `braid init --no-git-hooks` leaves git alone; you then use `/braid:commit` and `/braid:push`. Teammates who have the plugin need nothing more: braid sets up their clone the first time their agent opens it.

## Use

Work with Claude Code and use git as usual:

```sh
git commit -m "Retry webhook deliveries on 5xx"   # made by the agent: commits its conversation too
git push                                          # publishes that conversation, redacted
```

The status line shows where your session stands:

```
5b0e2c1a · #128 · ↑4 · ↓ review/bob +5 → /braid:merge
```

| | |
|---|---|
| `5b0e2c1a` | this session |
| `#128` | the pull request of this branch |
| `↑4` | 4 records not published yet |
| `↓ review/bob +5` | a session built on yours, such as a review or a branch, has 5 records you have not merged |
| `local` | saved here only, never committed |
| `✓` | everything published, nothing waiting |

**Review a pull request.** Check it out and start Claude Code. It knows which sessions are behind the branch, and `/braid:review-pr 128` reviews the change together with them. Your review session is published when it ends.

**Merge a review.** When `↓` appears, tell Claude what to keep:

```
> /braid:merge keep my jitter, adopt the reviewer's time budget
```

`/braid:merge skip review/bob` marks a review as seen without adopting it.

**Branch.** Claude Code's `/branch` branches the conversation, and braid records the branch by itself. Back in the original session, the branch waits in `↓` until you merge it or skip it.

| Command | |
|---|---|
| `/braid:commit [message]` | commit the conversation; git commits do this when the git hooks are on |
| `/braid:fork [id \| name \| pr:N]` | continue a new session from another one, such as a teammate's |
| `/braid:merge [id \| name] [instruction]` | merge the session waiting in `↓`, or any session, or `skip` it |
| `/braid:review-pr <n>` | review a pull request with the sessions behind it |
| `/braid:status` | everything the status line abbreviates |
| `/braid:push` | publish this session; `git push` does this when the git hooks are on |
| `/braid:withhold` | keep part of this session, or all of it, from being published |
| `/braid:setup` | set up the status line and the `braid` command |

Asking in plain language works too: "pull in Bob's review but keep my jitter".

**Privacy.** Published copies hold the conversation's messages and tool calls only. Reasoning, images and the harness's raw files stay on your machine, and common credentials are redacted before anything leaves it. Anyone who can read the repository can read its published sessions. See [Publishing](docs/design.md#publishing) and [Trust](docs/design.md#trust).

## How it works

Each session lives on its own git ref under `refs/braid/`, in [ATXF](https://github.com/leostera/atxf), an open format for agent transcripts. Your unredacted copy stays in `.git/braid/`, where no push can reach it. No server or GitHub App is involved. [docs/design.md](docs/design.md) covers the model, storage, publishing, trust, merging and review, and [examples/pr-review](examples/pr-review) is a complete conversation between an author and a reviewer.

## Development

```sh
npm install
npm run check    # typecheck, tests, and the bundle in dist/
```

`dist/braid.mjs` is committed, because the plugin runs it straight from the repository. `npm run check` rebuilds it, so commit it together with the change to `src/`.

## License

[MIT](LICENSE)
