---
name: push
description: Publish the committed part of the current agent session now, redacted, to the remote of the repository that keeps its conversations, or show what would be published. Use for /braid:push, or when the user asks to share or publish this session, or what publishing it would share.
---

# Publish this session

1. Run `braid push`. It publishes the session up to its last commit. If the user wants to see what would be published first, run `braid push --dry-run` and report it: the records, the redactions per rule, the records withheld per cause, the rule files used, and how many newer records are not committed. For the records themselves, use `/braid:edit`.
2. Report what was published: the session id, the number of records, and how many were redacted. If nothing was committed yet, say so and offer `/braid:edit` and then `/braid:commit`. If braid replaced records published before, say that anyone who fetched them keeps their copy. If the session is private, say so. If braid says autopilot is on, nothing leaves the machine: tell the user that `braid init --no-autopilot` lets braid push and fetch sessions in this repository. If the repository that keeps the conversations has no remote, give the user the `git remote add` command braid prints.

If `braid` is not on PATH, run `node "$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/braid/cli")"` in its place.
