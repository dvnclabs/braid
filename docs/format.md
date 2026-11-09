# Format

braid stores a conversation as a folder: one ATXF file with the full tree, plus the native session files it came from. The same folder can live anywhere on disk or inside a git repository.

## Principles

1. **Native files are the source of truth for what a harness wrote.** braid copies them byte for byte and never rewrites them locally.
2. **[ATXF](https://github.com/leostera/atxf) holds the conversation tree.** It includes records that no single harness wrote, such as merges and branch names.
3. **Everything braid adds is valid ATXF 0.1.** braid-specific data lives in the `ext.braid` namespace, which ATXF reserves for extensions. Any ATXF reader can open a braid conversation.
4. **Exports are generated.** An ATIF file or a briefing can always be rebuilt from the folder.

## Folder layout

```
<conversation>/
  conversation.atxf.jsonl      # the tree, one record per line, append-only
  raw/
    <harness>/<file>           # native session files, byte for byte
  trajectory.json              # optional ATIF export of one branch
```

`conversation.atxf.jsonl` is the only required file. The `raw/` folder makes exact replay possible. Without it, braid can still produce briefings.

## How braid uses ATXF

braid writes ATXF **0.1** and validates every file against the [published schema](https://github.com/leostera/atxf/tree/main/schema/v0.1).

**Header.** braid always writes `source.agent: "braid"`, because one conversation can contain records from several harnesses. The harness of each record is in its `ext.braid` fields.

| Header field | braid's use |
|---|---|
| `id` | conversation id, `conv-` followed by a ULID |
| `time` | creation time, UTC |
| `title` | short human title |
| `workspace.vcs` | repository remote, branch and commit when the conversation started |
| `fidelity` | `topology: "tree"`; `native: "none"` unless native records are embedded |
| `parent` | set when a conversation was split out of another (`relation: "fork"`) |

**Records.**

| braid concept | ATXF record |
|---|---|
| user, assistant and tool messages | `message` with `role` `user`, `assistant` or `tool` |
| reasoning and tool calls | `reasoning` and `tool_call` blocks in assistant content |
| merge | `branch_summary`: `parentId` is the head being continued, `fromId` the head brought in |
| branch name | `label` on the first record of the branch |
| subagent or linked conversation | `agent_link`, and `parent` in the child's header |
| compaction, rewinds, context edits | kept as the ATXF converters produce them |

`branch_summary` fits merges well. ATXF defines it as a summary of one branch, from `fromId` back to the common ancestor, carried into the branch that continues from `parentId`. A braid merge is that summary written to an instruction.

## The `ext.braid` fields

ATXF allows `ext` on the header and on every record envelope. braid uses these fields:

| Where | Field | Type | Meaning |
|---|---|---|---|
| header | `version` | integer | version of the `ext.braid` fields, currently `1` |
| any record | `actor.actorId` | string | person or account the record was written for |
| any record | `actor.userAgent` | string | software that wrote it, as product tokens: `claude-code/2.1` |
| imported records | `raw.file` | string | native file, relative to the conversation folder |
| imported records | `raw.line` | integer | 1-based line in that file |
| merge records | `merge.base` | id | the merge base |
| merge records | `merge.heads` | ids | every head merged; the first is the branch being continued |
| merge records | `merge.instruction` | string | the instruction exactly as given |
| merge records | `merge.strategy` | string | strategy name, or `default` |
| merge records | `merge.model` | string | `provider:model` that wrote the summary |
| merge records | `merge.conflicts` | array | unresolved conflicts; empty once the merge is complete |
| published records | `redactions` | array | what was removed before publishing; see [security.md](security.md) |

A merge of more than two branches is one `branch_summary` record. `fromId` holds the second head, `merge.heads` lists all of them, and the summary covers every incoming branch.

Here are a merge and a branch label from the [example](../examples/pr-review/conversation.atxf.jsonl), formatted for reading:

```json
{
  "type": "branch_summary",
  "id": "m1",
  "parentId": "e12",
  "time": "2026-11-08T18:01:12Z",
  "fromId": "r5",
  "summary": "Review by bob@example.com (Codex), merged into this branch. ...",
  "ext": {
    "braid": {
      "actor": { "actorId": "alice@example.com", "userAgent": "braid/0.0.0" },
      "merge": {
        "base": "e8",
        "heads": ["e12", "r5"],
        "instruction": "keep my jitter, adopt the reviewer's time budget",
        "strategy": "default",
        "model": "anthropic:claude-opus-5-5",
        "conflicts": []
      }
    }
  }
}
```

```json
{ "type": "label", "id": "l2", "time": "2026-11-08T17:40:02Z", "targetId": "r1", "label": "review/bob" }
```

### Moving to ATXF 0.2

The ATXF 0.2 draft adds `actorId` and `userAgent` directly on record envelopes. When 0.2 is final and its reference libraries ship, braid will write those fields natively and keep reading `ext.braid.actor` from older files. ATXF 0.1 validators reject the 0.2 fields, which is why braid waits.

## Storage in git

Inside a repository, each conversation lives on its own ref:

```
refs/braid/conversations/<conversation-id>
```

The ref points to a commit whose tree is the conversation folder, and each push adds a commit. Refs outside `refs/heads/` stay out of the branch list, and git fetches them only when asked. braid configures the refspec:

```sh
git config --add remote.origin.fetch '+refs/braid/*:refs/braid/*'
```

**Linking code to conversations.** A git hook adds a trailer to each code commit made during a captured session:

```
Braid-Conversation: conv-01JC8Q4W5T
```

GitHub shows trailers in commit messages, and its default squash-merge message keeps the original commit messages.

**Concurrent updates.** When two people push different versions of one conversation, braid fetches both, reconciles them, and pushes a commit with both as parents. Reconciliation follows ATXF's rules: it is deterministic, order-independent and safe to repeat, so two people syncing in any order end up with the same file. For conversations committed to ordinary branches, a git merge driver for `*.atxf.jsonl` runs the same reconciliation.

**Access.** Anyone who can read the repository can read its conversations. braid redacts before it pushes; see [security.md](security.md).

## Exports

**ATIF.** `braid export --atif <branch>` writes `trajectory.json` for the Harbor, NVIDIA NeMo and Arize Phoenix tools. ATIF is linear and has three sources (`system`, `user`, `agent`), so the export follows one branch from the root to its head, maps the viewer's assistant turns to `agent`, other participants to `user` with a speaker prefix, and merge summaries to `system`.

**Embedded native records.** `braid save --embed-native` copies each native record into the ATXF `native` field and sets `fidelity.native` to `all`. The result is a single self-contained file at roughly twice the size.

## Reading from Entire

Repositories that use [Entire](https://docs.entire.io/overview) already store full transcripts under `refs/entire/checkpoints/` and link them with an `Entire-Checkpoint` trailer. braid plans an importer that reads those checkpoints as its native source, so a team using Entire does not capture sessions twice.
