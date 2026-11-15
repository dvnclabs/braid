---
name: status
description: Show where this agent session stands in braid: its newest turn, what it is about, and where it is kept. Use for /braid:status, or when the user asks about the braid status line.
---

# Session status

Run `braid status` and explain the result briefly:

- `braid · 5b0e2c1a.12 · <title>`: this session at its twelfth turn, by the name `braid fork` takes, and what it is about: the name the user gave it with /rename, else the agent's title, else its first prompt.
- `recap`: the agent's latest recap of the session.
- `kept in`: the file that holds the session, in the project's `.braid` folder; `ran in`: the worktree it ran in, when that is not the project's main checkout.
- `a fork of <session>.<n>`: the session and turn `braid fork` wrote this one from. Its file holds that history too.
- `⚠ braid verify`: the check braid ran when this session last ended found a problem. Run `braid verify` and report what it says.

`braid log` lists the session's turns, with what each did, and `braid sessions` every session the project keeps.

If `braid` is not on PATH, run `node "$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/braid/cli")"` in its place.
