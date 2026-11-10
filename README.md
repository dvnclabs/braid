# braid

Version control for agent conversations. braid saves every Claude Code session into your git repository and ties it to the commits it produced. You review a session, commit it, and `git push` publishes it up to that commit. Reviewers can question the session behind a pull request, and you can merge their review sessions back into yours.

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
git add .braid .braidignore && git commit -m "Set up braid"
```

`braid init` installs git hooks that keep any you have, and writes two settings to `.braid/config.toml`:

| Setting | Default | |
|---|---|---|
| `autocommit` | `false` | each commit the agent makes commits its conversation too; off, you commit it with `/braid:commit` after `/braid:review` |
| `autopush` | `true` in private repositories, `false` in public ones | `git push` publishes the committed part of the sessions behind the pushed commits; off, `/braid:push` publishes |

Change them with `braid init --autocommit`, `braid init --no-autopush` and so on, or set them for yourself in every repository in `~/.config/braid/config.toml`, which wins over the repository's. `braid init --no-git-hooks` leaves git alone. Teammates who have the plugin need nothing more: braid sets up their clone the first time their agent opens it.

## Use

Work with Claude Code and use git as usual. braid saves each turn on your machine. When you want to share the conversation, review it, commit it, and push:

```
> /braid:review                        # the session as it would be published; remove or rewrite parts
> /braid:commit Retry webhook deliveries
$ git push                             # publishes the conversation up to that commit, redacted
```

The status line shows where your session stands:

```
5b0e2c1a · #128 · ↑4 · ↓ review/bob +5 → /braid:merge
```

| | |
|---|---|
| `5b0e2c1a` | this session |
| `#128` | the pull request of this branch |
| `↑4` | 4 committed records not published yet |
| `*3` | 3 records since the last commit, which are not published |
| `↓ review/bob +5` | a session built on yours, such as a review or a branch, has 5 records you have not merged |
| `local` | saved here only, nothing committed |
| `✓` | everything published, nothing waiting |

**Review your session before sharing it.** `braid review`, in a terminal or through `/braid:review`, lists the session as it would be published, one numbered line per record, after redaction:

```
$ braid review
braid review 5b0e2c1a (5b0e2c1a): 9 records, nothing committed yet, 0 withheld, 1 redacted
git push publishes up to the last commit. ↑ committed, not published yet · ✗ withheld · ✎ edited

 1   you     Why is the Acme import failing? My key is [REDACTED:aws-access-key].
 2   agent   → Read customers/acme.csv
 3   tool    name,revenue Acme,1200000
 4   agent   The CSV has no header row for region.
```

Then remove or rewrite what should stay private:

```sh
braid review 2-3                 # withhold records; a tool call takes its result along
braid review --edit 4            # rewrite a record in your editor; empty it to withhold it
braid review --text "Acme"       # hide a word in every record
braid review --all               # keep the whole session back
braid review --undo 2            # put any of it back
```

Records that were already published are replaced by the next push.

**Review a pull request.** Check it out and start Claude Code. It knows which sessions are behind the branch, and `/braid:review-pr 128` reviews the change together with them. Commit the review, and it is published when the session ends.

**Merge a review.** When `↓` appears, tell Claude what to keep:

```
> /braid:merge keep my jitter, adopt the reviewer's time budget
```

`/braid:merge skip review/bob` marks a review as seen without adopting it.

**Fork.** `/braid:fork` gives you the command to branch this conversation into a new terminal window, and `/braid:fork review/bob` or `/braid:fork pr:128` the command to continue someone else's session there, with its whole history. Claude Code's `/branch` branches in the same window. braid records each branch by itself, and back in the original session it waits in `↓` until you merge it or skip it.

| Command | |
|---|---|
| `/braid:review` | the session as it would be published; remove, rewrite or hide parts of it |
| `/braid:commit [message]` | commit the conversation; publishing goes up to the last commit |
| `/braid:fork [id \| name \| pr:N]` | the command to continue this session, or another one, in a new window |
| `/braid:merge [id \| name] [instruction]` | merge the session waiting in `↓`, or any session, or `skip` it |
| `/braid:review-pr <n>` | review a pull request with the sessions behind it |
| `/braid:status` | everything the status line abbreviates |
| `/braid:push` | publish the committed part of this session now; `git push` does this with autopush |
| `/braid:setup` | set up the status line and the `braid` command |

Asking in plain language works too: "pull in Bob's review but keep my jitter".

**Privacy.** Published copies hold the conversation's messages and tool calls only. Reasoning, images and the harness's raw files stay on your machine, and common credentials are redacted before anything leaves it. Tool calls on the paths in `.braidignore` (same syntax as `.gitignore`; `braid init` starts it with `.env` files and keys) are never published. Teams add terms and patterns to redact in `.braid/redact.toml`. Nothing is published until you commit it, and `braid review` shows exactly what would go. Anyone who can read the repository can read its published sessions. See [Publishing](docs/design.md#publishing) and [Trust](docs/design.md#trust).

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
