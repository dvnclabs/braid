---
name: init
description: Set up braid, the efficient session manager, on this machine (the braid command, the status line, and braid's hooks in Codex) and make this project's .braid folder, where its conversations are kept. Use for /braid:init, or when the user asks to install or enable braid.
---

# Set up braid

1. Run `braid init`. braid:
   - installs a `braid` command in `~/.local/bin` and adds braid's part to the Claude Code status line, running any existing status line first
   - makes this project's `.braid` folder, where every session of the project is kept as it happens: `.braid/sessions/<id>.jsonl.gz`, one record per line, gzip-compressed (`zcat` reads it). A `.gitignore` inside the folder keeps git from seeing it, so no file of the project changes. A project is a git repository's main checkout, so its worktrees share one folder; outside any repository, it is the folder itself.
   - moves conversations braid 0.1 kept in `~/.braid` into the projects they ran in
   - saves this conversation, from its first turn
   - says how many earlier sessions of this project on this machine are not saved, as those from before braid was installed. When it does, offer to save them with `braid save --all`, which saves every Claude Code and Codex session that ran in this project, in any of its worktrees, and lists them with their titles.
   - when Codex is on the machine, adds braid's hooks to `~/.codex/hooks.json`, so Codex sessions are saved too. Tell the user to open `/hooks` in Codex once and trust braid's four hooks: Codex runs a new hook only after that.
2. Tell the user that braid saves every session from now on, after each turn, and that nothing leaves the machine.
3. A new session picks up the hooks and the status line. `braid init --undo` puts back the previous status line and takes braid's hooks out of Codex.

If `braid` is not on PATH, run `node "$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/braid/cli")"` in its place.
