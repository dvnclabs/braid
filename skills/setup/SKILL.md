---
name: setup
description: Set up braid on this machine (the braid command and the status line) and in the current repository (.braid/config.toml and git hooks). Use for /braid:setup, or when the user asks to install or enable braid.
---

# Set up braid

1. Run `braid setup`. It installs a `braid` command in `~/.local/bin` and adds braid's part to the Claude Code status line, running any existing status line first.
2. If the user wants braid in the current repository, run `braid init`. It writes `.braid/config.toml`, with publishing on for private repositories and off for public ones, and installs git hooks that keep any existing hooks.
3. Suggest committing `.braid/config.toml`, so teammates with the plugin get braid in this repository too.
4. A new session picks up the hooks and the status line.

If `braid` is not on PATH, run `node "$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/braid/cli")"` in its place.
