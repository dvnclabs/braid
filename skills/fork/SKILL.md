---
name: fork
description: Fork an agent conversation saved by braid into a new window, in Claude Code or Codex: this one, another (a session id, or the name the user gave it with /rename), or the end of one of its turns (<session>.<n>, or .<n> for this one). Use for /braid:fork, or when the user asks to branch this conversation, continue another session, or continue a session in Codex or Claude Code.
---

# Fork a conversation

1. Run `braid fork` to branch this conversation, or `braid fork <target>` for another session. Every turn has a name, `<session>.<n>`: to go back, run `braid log` to list this conversation's turns with what each did, and `braid fork .<n>` to continue from the end of turn n (to do turn n again, fork `.<n-1>`). `<session>.<n>` names a turn of another session, by id or by any name braid finds it by. `braid sessions` lists the sessions the project keeps.
2. braid prints a command, `cd <dir> && claude --resume <id>`. Give it to the user to run in a new terminal window, where the fork continues with the whole conversation.
3. To continue in Codex, add `--to codex`: braid writes the session as a new Codex session and prints `cd <dir> && codex resume <id>`. With `--to claude-code`, a Codex session continues in Claude Code. Without `--to`, a fork continues in the agent the command runs in. Asked for again, the same fork is the same session, continued or not; add `--new` for another. Each agent gets the messages, tool calls and results; reasoning stays behind, as only the provider that wrote it can read it, and so do the instructions and environment each agent gives its own model.
4. With no target, the user can also run `/branch` to branch in this window. braid files either branch in this conversation, and it shows as ↓ until it is merged back with `/braid:merge`.

If `braid` is not on PATH, run `node "$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/braid/cli")"` in its place.
