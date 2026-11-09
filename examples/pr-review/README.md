# Example: a pull request review

[`conversation.atxf.jsonl`](conversation.atxf.jsonl) is a complete braid conversation in ATXF 0.1. It validates against the [ATXF v0.1 schema](https://github.com/leostera/atxf/tree/main/schema/v0.1).

## The story

1. **Alice** asks Claude Code to add retries to a webhook sender. The agent reads the file, adds 3 retries with exponential backoff, and runs the tests (`e1`–`e8`).
2. Alice continues on her own branch and asks for jitter (`e9`–`e12`, branch `alice/jitter`).
3. **Bob** reviews the pull request. He loads the conversation into Codex as a briefing and asks why there are 3 retries. His agent finds a 30-second timeout already defined in the code (`r1`–`r5`, branch `review/bob`).
4. Alice merges Bob's branch into hers with the instruction "keep my jitter, adopt the reviewer's time budget" (`m1`).
5. Alice continues from the merge (`e13`–`e14`).

```
e1 … e8                       shared history      alice via claude-code
├── e9 … e12                  alice/jitter        alice via claude-code
│   └── m1                    merge of review/bob into alice/jitter
│       └── e13 … e14         alice continues
└── r1 … r5                   review/bob          bob via codex
```

## What to look at

- **Participants.** Every record carries `ext.braid.actor`. Alice's and Bob's records come from different harnesses, recorded in `userAgent`, and different models, recorded in `model`.
- **Tool calls from two harnesses.** Claude Code's `Read`, `Edit` and `Bash` and Codex's `shell` sit in one tree.
- **The fork.** `r1` has `e8` as its parent while `e9` already continues from `e8`. That is the whole encoding of a branch in ATXF.
- **The merge.** `m1` is a `branch_summary`: `parentId` is Alice's head, `fromId` is Bob's head, and `ext.braid.merge` records the base, the instruction and the model.
- **Branch names.** The two `label` records at the end name the branches by their first records.
- **Native files.** Records point to their native source with `ext.braid.raw`. The `raw/` folder is left out of this example.

To read it formatted:

```sh
jq . conversation.atxf.jsonl | less
```
