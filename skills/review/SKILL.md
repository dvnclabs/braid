---
name: review
description: Review this agent session before it is committed and published, and remove or rewrite parts of it for privacy: withhold records, rewrite a record's text, hide a word everywhere, or keep the session private. Use for /braid:review, or when the user asks what would be shared, or not to share something from this session.
---

# Review this session

1. Run `braid review`. It prints the session as `git push` would publish it, one numbered line per record (subagent records are numbered under the line that spawned them, such as `4.1`), after redaction. Marks: `↑` committed and not published yet, `✗` withheld, `✎` edited.
2. Show the user the lines that matter, not the whole list, and point out anything that looks private: names of clients or people, credentials, internal URLs, personal remarks. Then apply what the user asks:
   - Remove records: `braid review 4 7-9 12.3`. A tool call takes its result along, and a subagent goes with all its records.
   - Rewrite a record's text: write the new text on stdin, as in `braid review --edit 5 <<'EOF'` followed by the text and `EOF`. Start from the record's text in the listing, and change only what the user asked for. A tool call has no text to rewrite: remove it, or hide text in it.
   - Hide a word or phrase in every record: `braid review --text "Acme Corp"`.
   - Keep the whole session back: `braid review --all`.
   - Undo any of these with `--undo`: `braid review --undo 7`, `braid review --undo --edit 5`, `braid review --undo --text "Acme Corp"`, `braid review --undo --all`.
3. Confirm what changed. If braid says some of it was already published, the next push replaces the published copy; anyone who fetched it before keeps theirs, so a leaked secret must be rotated.
4. When the user is happy with it, `/braid:commit` commits the conversation up to here.

In a terminal, `braid review --edit 5` opens the record in the user's editor; emptying it withholds the record. To keep a path out of every session, such as a folder of client data, add it to `.braidignore` (same syntax as `.gitignore`), or to `~/.config/braid/ignore` for the user alone.

If `braid` is not on PATH, run `node "$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/braid/cli")"` in its place.
