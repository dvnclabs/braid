# Adapters

braid has two plugin points that vary independently:

- **Harness adapters** connect braid to the tools where sessions happen: Claude Code, Codex, and others.
- **LLM providers** serve the model calls braid makes itself, for merges, summaries, briefings and digests.

A team can work in Claude Code and Codex while braid's merges run on any provider.

## Harness adapters

Each adapter implements the same small interface:

```
adapter
  name                        "claude-code", "codex", ...
  capabilities                replay, headless, hooks
  discover(repo)        ->    native sessions that belong to this repository
  import(session)       ->    ATXF records, plus the raw file
  export(branch, dir)   ->    a native session file the harness can resume
  resume(session)       ->    the command that opens it interactively
  run(session, prompt)  ->    new records, from a headless run
  tool_kind(tool_name)  ->    read | edit | write | shell | search | web | subagent | other
```

**Import reuses ATXF's converters.** ATXF already ships converters for Claude Code, Codex, Gemini CLI, OpenCode and Pi. A braid adapter adds what a converter lacks: finding sessions on disk, writing native files back for replay, and launching the harness.

### Tool kinds

Harnesses name their tools differently. Claude Code edits files with `Edit`, Codex with `apply_patch`. braid maps every tool to a small set of kinds, and the digest, the review checks and briefings work from the kinds. The original name stays in the record.

Kinds are computed when a conversation is read. They depend only on the harness and the tool name, and ATXF does not allow extension fields inside content blocks, so storing them would add nothing.

| Kind | Claude Code | Codex |
|---|---|---|
| read | `Read` | `shell` commands that only read |
| edit | `Edit` | `apply_patch` |
| write | `Write` | `apply_patch` (new file) |
| shell | `Bash` | `shell` |
| search | `Grep`, `Glob` | `shell` with `rg` or `grep` |
| web | `WebFetch`, `WebSearch` | `web_search` |
| subagent | `Agent` (formerly `Task`) | |
| other | everything else, such as `TodoWrite` | `update_plan` and the rest |

Tool names change between releases. Each adapter keeps its table in one place, with tests built from recorded sessions.

### Claude Code

- **Sessions:** `~/.claude/projects/<encoded-project-path>/<session-id>.jsonl`, one JSON record per line. Subagent work is recorded as sidechains of the main session.
- **Replay:** write the rebuilt file under the viewer's project path with a new session id, rewrite the working-directory fields, then run `claude --resume <session-id>`.
- **Headless:** `claude -p`, or the Claude Agent SDK.
- **Hooks:** a `SessionEnd` hook imports new records back into the conversation. The `/braid:*` commands ship as a Claude Code plugin; see [pr-review.md](pr-review.md#skills).

### Codex

- **Sessions:** rollout files under `~/.codex/sessions/YYYY/MM/DD/`, one JSON record per line.
- **Replay:** write the rebuilt rollout file, then run `codex resume <session-id>`.
- **Headless:** `codex exec`.
- **Skills:** Codex reads `SKILL.md` skills, so the same skills cover both harnesses.

### Other harnesses

Gemini CLI, OpenCode and Pi can be imported through ATXF's converters from the first release. Loading into them uses briefings until someone writes their `export`. Cursor and others follow when there is demand.

Replaying one harness's records inside a different harness means translating tool calls and record formats. braid leaves that out of its first versions and uses briefings across harnesses. Projects such as [casr](https://github.com/Dicklesworthstone/cross_agent_session_resumer) already convert between formats, and one of them could become an optional backend.

## LLM providers

braid's own model calls go through one function:

```
complete(messages, model, max_tokens, json_schema?) -> text or JSON
```

Models are named `provider:model`. The first providers are Anthropic and OpenAI, plus any endpoint compatible with OpenAI's API or with [Open Responses](https://openresponses.org/). API keys come from the usual environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`).

A provider can also be a harness running headless. `claude-code:default` sends braid's calls through `claude -p` and `codex:default` through `codex exec`, so braid runs on the subscription a developer already has, with no extra API key.

Each task can use a different model, set in `.braid/config.toml`:

```toml
[models]
merge = "anthropic:claude-opus-5-5"
digest = "anthropic:claude-sonnet-5-5"
briefing = "claude-code:default"
```
