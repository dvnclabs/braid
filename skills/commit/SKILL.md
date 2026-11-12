---
name: commit
description: Commit the current agent conversation in braid with a message, like a git commit for the conversation; publishing goes up to the last commit. Use for /braid:commit, or when the user asks to commit, checkpoint or share this conversation.
---

# Commit this conversation

1. If the user has not looked at the session since its last commit, run `braid edit` first and show what would go out, as `/braid:edit` does. Commit only once the user is happy with it.
2. Take the message from the text after the command. If there is none, write one line, under 72 characters, that says what this conversation decided or did since its last commit.
3. Run `braid commit -m "<message>"`.
4. Confirm in one line, with what braid says about publishing: with autopush (the default off autopilot, in private repositories), the next `git push` of a commit made in this session publishes the conversation up to this commit; otherwise, or to publish now, `/braid:push`.

This commits the conversation only. Code commits do not commit the conversation unless `autocommit = true` is set in `.braid/config.toml` or `~/.config/braid/config.toml`.

If `braid` is not on PATH, run `node "$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/braid/cli")"` in its place.
