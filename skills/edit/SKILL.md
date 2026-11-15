---
name: edit
description: Edit this agent session before it is committed and published, for privacy: list it, withhold records, rewrite a record's text, hide a word everywhere, or keep the whole session private. Use for /braid:edit, or when the user asks what would be shared, or to remove or change something in this session before sharing it.
---

# Edit this session

1. Run `braid edit`. It prints the session as it would be published, one numbered line per record (subagent records are numbered under the line that spawned them, such as `4.1`), after redaction, grouped under each turn's name (`5b0e2c1a.3`). Marks: `↑` committed and not published yet, `✗` withheld, `✎` rewritten.
2. Show the user the lines that matter, not the whole list, and point out anything that looks private: names of clients or people, credentials, internal URLs, personal remarks. Then apply what the user asks:
   - Remove records: `braid edit 4 7-9 12.3`. A tool call takes its result along, and a subagent goes with all its records.
   - Remove whole turns: `braid edit .3` or `braid edit .3-5`.
   - Rewrite a record's text: write the new text on stdin, as in `braid edit --rewrite 5 <<'EOF'` followed by the text and `EOF`. Start from the record's text in the listing, and change only what the user asked for. A tool call has no text to rewrite: remove it, or hide text in it.
   - Hide a word or phrase in every record: `braid edit --hide "Acme Corp"`.
   - Remove everything from the last half hour: `braid edit --last 30m`.
   - Keep the whole session back: `braid edit --all`.
   - Undo any of these with `--undo`: `braid edit --undo 7`, `braid edit --undo --rewrite 5`, `braid edit --undo --hide "Acme Corp"`, `braid edit --undo --all`.
3. Confirm what changed. If braid says some of it was already published, the next push replaces the published copy; anyone who fetched it before keeps theirs, so a leaked secret must be rotated.
4. When the user is happy with it, `/braid:commit` commits the conversation up to here.

In a terminal, `braid edit --rewrite 5` opens the record in the user's editor; emptying it withholds the record. To keep a path out of every session, such as a folder of client data, add it to `.braidignore` (same syntax as `.gitignore`), or to `~/.config/braid/ignore` for the user alone.

If `braid` is not on PATH, run `node "$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/braid/cli")"` in its place.
