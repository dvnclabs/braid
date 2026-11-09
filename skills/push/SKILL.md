---
name: push
description: Publish the current agent session now, redacted, without waiting for a git push, or show what would be published. Use for /braid:push, or when the user asks to share or publish this session, or what publishing it would share.
---

# Publish this session

1. Run `braid push`. If the user wants to see what would be published first, or asks what would be shared, run `braid push --dry-run` instead and report it: the records, the redactions per rule, the records withheld per cause, and the rule files used.
2. Report what was published: the session id, the number of records, and how many secrets were redacted. If it was not published, give the reason, for example that publishing is off in `.braid/config.toml` or that the session is private.

If `braid` is not on PATH, run `node "$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/braid/cli")"` in its place.
