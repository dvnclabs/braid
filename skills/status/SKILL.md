---
name: status
description: Show where this agent session stands in braid, what is published, and which teammates' sessions wait to be merged. Use for /braid:status, or when the user asks about the braid status line.
---

# Session status

Run `braid status` and explain the result briefly:

- `local`: saved on this machine, nothing committed or published. `/braid:review`, then `/braid:commit`, prepares it to be shared.
- `↑N`: N committed records are not published yet. They go out with the next `git push` of a commit made in this session (with autopush), or with `/braid:push`.
- `*N`: N records since the last commit. Publishing stops at the last commit; `/braid:review` and `/braid:commit` take them in.
- `↓ name +N`: a session built on this one, such as a review or a branch, has N records that are not merged. `/braid:merge` merges them.
- `private`: the user withheld the whole session.
- `✓`: everything is published and nothing is waiting.

If `braid` is not on PATH, run `node "$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/braid/cli")"` in its place.
