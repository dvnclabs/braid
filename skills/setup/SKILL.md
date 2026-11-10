---
name: setup
description: Set up braid on this machine (the braid command and the status line) and in the current repository (.braid/config.toml and git hooks). Use for /braid:setup, or when the user asks to install or enable braid.
---

# Set up braid

1. Run `braid setup`. It installs a `braid` command in `~/.local/bin` and adds braid's part to the Claude Code status line, running any existing status line first.
2. If the user wants braid in the current repository, run `braid init`. It writes `.braid/config.toml` and installs git hooks that keep any existing hooks. Two settings decide what happens with git, and the user can change them later with the same command:
   - `autocommit` (off by default): each commit the agent makes commits its conversation too. Off, the user commits the conversation with `/braid:commit`, after `/braid:review`. `braid init --autocommit` turns it on.
   - `autopush` (on for private repositories, off for public ones): `git push` publishes the committed part of the sessions behind the pushed commits. Off, `/braid:push` publishes. `braid init --no-autopush` turns it off.
   The user's own `~/.config/braid/config.toml` can set either for them in every repository. If the user wants braid to leave git alone, run `braid init --no-git-hooks`.
3. `braid init` also writes `.braidignore`, in `.gitignore` syntax: tool calls on those paths, and their results, are never published. It starts with `.env` files and keys; ask whether there are other paths to add, such as client data. Suggest committing `.braid/` and `.braidignore`, so teammates with the plugin get braid in this repository too.
4. A new session picks up the hooks and the status line.

If `braid` is not on PATH, run `node "$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/braid/cli")"` in its place.
