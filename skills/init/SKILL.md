---
name: init
description: Set up braid, the efficient session manager, on this machine (the braid command, the status line, and ~/.braid, the braid repository that keeps every conversation) and in the current repository (.braid/config.toml, .braidignore and git hooks), or change its settings. Use for /braid:init, or when the user asks to install, enable or configure braid.
---

# Set up braid

1. Run `braid init`. braid:
   - installs a `braid` command in `~/.local/bin` and adds braid's part to the Claude Code status line, running any existing status line first
   - creates `~/.braid`, the braid repository, which keeps every conversation apart from the code, whichever repositories a session runs or commits in, and the braid repository this repository's `repo` setting names, if another
   - inside a git repository, writes `.braid/config.toml` and `.braidignore`, and installs git hooks that keep any existing hooks
   - when Codex is on the machine, adds braid's hooks to `~/.codex/hooks.json`, so Codex sessions are saved too. Tell the user to open `/hooks` in Codex once and trust braid's three hooks: Codex runs a new hook only after that.
2. Tell the user which steps run by themselves. They can change each one later with the same command:
   - `autopilot` (on by default): nothing leaves the machine. `braid init --no-autopilot` lets `git push` publish conversations to the code repository's remote, so teammates who review the code read the sessions behind it.
   - `autocommit` (off by default): each code commit the agent makes commits its conversation too. Off, the user runs `/braid:edit`, then `/braid:commit`. `braid init --autocommit` turns it on.
   - `autopush` (on for private repositories, off for public ones, once autopilot is off): `git push` publishes the committed part of the sessions behind the pushed commits. Off, `/braid:push` publishes. `braid init --no-autopush` turns it off.
   - `repo`: `auto` keeps every conversation in `~/.braid`; a path, such as `~/work-convos`, names another braid repository, for instance to keep work conversations apart. Publishing still goes to the code repository's remote.
   The user's own `~/.config/braid/config.toml` can set any of them for every repository; `braid init --repo <path>` run outside a repository writes `repo` there. `braid init --no-git-hooks` leaves git alone.
3. `.braidignore` uses `.gitignore` syntax: tool calls on those paths, and their results, are never published. It starts with `.env` files and keys; ask whether there are other paths to add, such as client data. Suggest committing `.braid/` and `.braidignore`, so teammates with the plugin get the same settings.
4. Conversations outside any code repository can be shared by giving the braid repository a remote: `git -C ~/.braid remote add origin <url>`, then `/braid:push`.
5. A new session picks up the hooks and the status line.

If `braid` is not on PATH, run `node "$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/braid/cli")"` in its place.
