---
name: init
description: Set up braid, the efficient session manager, on this machine (the braid command, the status line, and ~/.braid) and in the current repository (.braid/config.toml, .braidignore and git hooks), or change its settings. Use for /braid:init, or when the user asks to install, enable or configure braid.
---

# Set up braid

1. If the current directory is inside a git repository, ask whether its conversations should stay next to the code (the default) or in a separate git repository, unless the user already said. Next to the code, `git push` can publish them to the same remote, so teammates who review the code read the sessions behind it. A separate repository keeps them apart, and the user pushes them there.
2. Run `braid init`, with `--repo <path>` for a separate repository. braid:
   - installs a `braid` command in `~/.local/bin` and adds braid's part to the Claude Code status line, running any existing status line first
   - creates `~/.braid`, a git repository for conversations outside repositories with braid
   - inside a git repository, writes `.braid/config.toml` and `.braidignore`, and installs git hooks that keep any existing hooks
3. Tell the user which steps run by themselves. They can change each one later with the same command:
   - `repo`: `auto` keeps conversations in the repository itself; a path, such as `~/.braid`, keeps them in that separate repository. With a separate repository, autocommit and autopush are off.
   - `autocommit` (off by default): each code commit the agent makes commits its conversation too. Off, the user runs `/braid:edit`, then `/braid:commit`. `braid init --autocommit` turns it on.
   - `autopush` (on for private repositories, off for public ones): `git push` publishes the committed part of the sessions behind the pushed commits. Off, `/braid:push` publishes. `braid init --no-autopush` turns it off.
   The user's own `~/.config/braid/config.toml` can set any of them for every repository; `braid init --repo <path>` run outside a repository writes `repo` there. `braid init --no-git-hooks` leaves git alone.
4. `.braidignore` uses `.gitignore` syntax: tool calls on those paths, and their results, are never published. It starts with `.env` files and keys; ask whether there are other paths to add, such as client data. Suggest committing `.braid/` and `.braidignore`, so teammates with the plugin get the same settings.
5. With a separate repository, it can be shared by giving it a remote: `git -C <path> remote add origin <url>`.
6. A new session picks up the hooks and the status line.

If `braid` is not on PATH, run `node "$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/braid/cli")"` in its place.
