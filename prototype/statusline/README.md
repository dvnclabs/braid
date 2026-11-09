# Status line prototype

`braid-status.sh` prints braid's part of the Claude Code status line, as [docs/design.md](../../docs/design.md#status) describes it:

```
5b0e2c1a · #128 · ↑4 · ↓ review/bob +5 → /braid:sync
```

It reads the store and the published session refs described under [Storage](../../docs/design.md#storage). braid does not write those yet, so in an ordinary repository the line shows the session id and, when the branch has one, the pull request number. `test.sh` builds a repository with refs cut from the [example conversation](../../examples/pr-review) and checks 15 states, from "not saved" to a review merged and then skipped.

It needs `git` and `jq`. `gh` is optional: it supplies the pull request number, cached for five minutes and refreshed in the background so the line never waits for it. Results are cached in `.git/braid/cache` until a session ref moves.

## Use it

In `~/.claude/settings.json`:

```json
"statusLine": {
  "type": "command",
  "command": "/path/to/braid/prototype/statusline/braid-status.sh",
  "refreshInterval": 30
}
```

To keep an existing status line, run both commands from a small script and join their output.

## Test

```sh
./test.sh
```
