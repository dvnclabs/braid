---
name: status
description: Show where this agent session stands in braid, what is published, and which teammates' sessions wait to be merged. Use for /braid:status, or when the user asks about the braid status line.
---

# Session status

Run `braid status` and explain the result briefly:

- `local`: saved on this machine, never committed. `/braid:commit` commits it, and so does any git commit made in this session when git-hooks is on.
- `↑N`: N records of this session are not published yet. They go out with the next `git push` of a commit made in this session, or with `/braid:push`.
- `↓ name +N`: a session built on this one, such as a review or a branch, has N records that are not merged. `/braid:merge` merges them.
- `private`: the user withheld the whole session.
- `✓`: everything is published and nothing is waiting.

If `braid` is not on PATH, run `node "$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/braid/cli")"` in its place.
