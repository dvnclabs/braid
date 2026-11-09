---
name: commit
description: Commit the current agent conversation in braid with a message, like a git commit for the conversation. Use for /braid:commit, or when the user asks to commit, checkpoint or save this conversation.
---

# Commit this conversation

1. Take the message from the text after the command. If there is none, write one line, under 72 characters, that says what this conversation decided or did since its last commit.
2. Run `braid commit -m "<message>"`.
3. Confirm in one line. The conversation goes out with the next `git push` of a commit made in this session, or with `/braid:push`.

This commits the conversation only. When the user also wants the code committed, commit it with git as usual: with git-hooks on (the default), every commit you make commits the conversation too, so step 2 is then not needed.

If `braid` is not on PATH, run `node "$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/braid/cli")"` in its place.
