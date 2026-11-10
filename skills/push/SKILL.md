---
name: push
description: Publish the committed part of the current agent session now, redacted, without waiting for a git push, or show what would be published. Use for /braid:push, or when the user asks to share or publish this session, or what publishing it would share.
---

# Publish this session

1. Run `braid push`. It publishes the session up to its last commit. If the user wants to see what would be published first, run `braid push --dry-run` and report it: the records, the redactions per rule, the records withheld per cause, the rule files used, and how many newer records are not committed. For the records themselves, use `/braid:review`.
2. Report what was published: the session id, the number of records, and how many were redacted. If nothing was committed yet, say so and offer `/braid:review` and then `/braid:commit`. If braid replaced records published before, say that anyone who fetched them keeps their copy. If the session is private, say so.

If `braid` is not on PATH, run `node "$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/braid/cli")"` in its place.
