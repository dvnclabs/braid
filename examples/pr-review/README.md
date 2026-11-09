# Example: a pull request review

[`conversation.atxf.jsonl`](conversation.atxf.jsonl) is a complete braid conversation in ATXF 0.1, made of two sessions. [`generate.py`](generate.py) writes it, and [`validate.py`](validate.py) checks it against the ATXF v0.1 schema plus the tree's references:

```sh
python3 generate.py conversation.atxf.jsonl
pip install jsonschema
curl -sLO https://raw.githubusercontent.com/leostera/atxf/main/schema/v0.1/atxf.schema.json
python3 validate.py atxf.schema.json conversation.atxf.jsonl
```

## The story

1. **Alice** asks Claude Code to add retries to a webhook sender. The agent reads the file, wraps the request in the existing `withRetry` helper with 3 attempts, and runs the tests (`e1` to `e8`). Her session is `5b0e2c1a`. She commits and pushes, which publishes the session, and opens pull request 128.
2. Alice keeps working in the same session and adds jitter (`e9` to `e12`).
3. **Bob** checks out the pull request and asks Codex to review it. His first turn loads Alice's published session, so his session `01a1bc3e` forks at `e8`, the last record Alice had published. His agent finds a 30-second timeout already defined in the code (`r1` to `r5`). His session is named `review/bob` and is published when it ends.
4. Alice's status line shows `↓ review/bob +5`. She runs `/braid:sync keep my jitter, adopt the reviewer's time budget` (`s1` to `s4`), and braid records the merge her agent wrote (`m1`).
5. Alice applies the merged review (`e13` to `e17`).

```
e1 … e8                 5b0e2c1a   alice via claude-code
├── e9 … e12            5b0e2c1a   alice adds jitter
│   └── s1 … s4         5b0e2c1a   the /braid:sync turn, tagged partOf m1
│       └── m1          5b0e2c1a   merge of review/bob, written by alice's agent
│           └── e13 … e17          alice applies the review
└── r1 … r5             01a1bc3e   bob via codex, named review/bob
```

## What to look at

- **Sessions.** Every record carries `ext.braid.session`. The header's `id` is Alice's session id, because her session started the conversation. Bob's id is a UUIDv7, as Codex assigns them.
- **Participants.** `ext.braid.actor` gives each record's person and software. Alice's and Bob's records come from different harnesses and models.
- **Tool calls from two harnesses.** Claude Code's `Read`, `Edit` and `Bash` and Codex's `exec_command` sit in one tree. Every change the agents claim has a tool call behind it.
- **The fork.** ATXF encodes a branch through parent ids alone: `r1` has `e8` as its parent while `e9` also continues from `e8`.
- **The merge turn.** The records of the `/braid:sync` turn are kept and tagged `partOf: "m1"`, so a projection can show the merge once. `m1` continues from that turn, so the path from the root to Alice's head passes through it.
- **The merge.** `m1` is a `branch_summary`: `parentId` is Alice's head, `fromId` is Bob's head, and `ext.braid.merge` records the base, the heads, the instruction and the model. The merge ran inside Alice's session, so its model is her session's model and its `userAgent` lists both programs.
- **Native files.** Records point to their lines in the native files with `ext.braid.raw`. The `raw/` folder is left out of this example.
