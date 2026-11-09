---
name: withhold
description: Keep part or all of this agent session from being published by braid. Use for /braid:withhold, or when the user says not to share or publish something from this session.
---

# Withhold records

- For a time range, run `braid withhold --last <duration>`, such as `--last 30m` or `--last 2h`.
- For the whole session, run `braid withhold --all`.

Withheld records are never published, including by later pushes. Confirm what was withheld.

If `braid` is not on PATH, run `node "$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/braid/cli")"` in its place.
