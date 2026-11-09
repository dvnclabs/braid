# Concepts

braid has one central object, the **conversation**, and a small set of operations on it. A coding session with Claude Code, a pull request review, and a chain of cooperating agents are all conversations of different shapes.

## Conversation

A conversation is a tree of **records**. Each record has an id, a parent, a timestamp and an author. Records are appended and never edited. The first record of a conversation is the root.

The most common records are:

| Record | Meaning |
|---|---|
| user message | text from a person, or from another agent seen as input |
| assistant message | model output: text, reasoning, tool calls |
| tool result | the output of a tool call, linked to the call by id |
| merge | an LLM-written summary that brings one branch into another |
| link | a pointer to another conversation, for example a subagent's |

braid stores conversations in [ATXF](https://github.com/leostera/atxf), which defines these record types and more (compaction, context edits, checkpoints). [format.md](format.md) maps each concept to its ATXF encoding.

## Participants

Every record has an author. braid identifies an author by two values:

- **actor**: the person or account on whose behalf the record was written, such as `alice@example.com`
- **user agent**: the software that wrote it, such as `claude-code/2.1` or `codex/0.60`

Alice typing into Claude Code and the model answering her are both `(alice@example.com, claude-code/2.1)`. The record's role (user, assistant, tool) tells them apart. Bob reviewing in Codex is `(bob@example.com, codex/0.60)`. A conversation can have any number of participants. A harness session is the special case with one person, one agent and its tools.

These two fields follow the attribution proposal for ATXF 0.2. Until that version ships, braid keeps them under `ext.braid.actor`.

## Branches and heads

A **fork** happens when a new record's parent is some record other than the active leaf. Branches are never deleted. An abandoned approach stays in the tree, which is often what a reviewer wants to see.

A **branch name** labels the first record of a branch, so the name stays put while the branch grows. The branch **head** is the newest record that descends from that first record. The **active leaf** is the record the next turn will attach to.

## Projection

LLM APIs know two speakers, `user` and `assistant`, and those roles are relative to the model being called. braid stores authors and computes roles when a conversation is loaded. A projection takes three inputs:

1. **the conversation and a branch**, which fix the path from the root to the head
2. **the viewer**, the participant who will continue the conversation
3. **the target**, the harness or format to write

The rules:

- The viewer's own assistant records stay `assistant`.
- Every other participant's messages become `user` messages, prefixed with the speaker, for example `[bob@example.com via codex]`.
- Another agent's tool calls and results are summarized into that agent's message when the target harness cannot run them.
- Merge records become a context message that carries the summary.

There are two kinds of projection:

| Mode | Target | Fidelity |
|---|---|---|
| **replay** | the same harness that wrote the records | exact: braid writes back the native records and the harness resumes the session |
| **briefing** | any harness | a written summary of the path, injected as the first message of a new session |

Replay is exact and only works within one harness. Briefing works everywhere and loses detail. braid chooses replay when it can and briefing otherwise. A user can force either one.

## Operations

| Operation | What it does | Uses an LLM |
|---|---|---|
| **append** | adds a record at the active leaf | no |
| **fork** | starts a branch at any record | no |
| **reconcile** | unions two copies of the same conversation; where they diverge, the copies become sibling branches | no |
| **merge** | writes one record that brings branch B into branch A, following an instruction | yes |
| **summarize** | writes one record that stands in for a range, for long conversations | yes |
| **project** | renders a branch for a viewer and a target | for briefings |
| **link** | points a record at another conversation, for subagents and chains of agents | no |

Reconcile and merge both combine branches, at different levels. **Reconcile** works on structure: Alice's copy and Bob's copy of a conversation have both grown since they last synced, and reconcile produces one tree that contains both. It is deterministic and follows ATXF's reconciliation rules. **Merge** works on meaning: given two branches in that tree, it writes what branch B means for branch A and lists conflicts for a person to resolve. [operations.md](operations.md) describes merge in detail.

## Shapes this model covers

| Use | Participants | Shape |
|---|---|---|
| A Claude Code or Codex session | one person, one agent, tools | one branch, plus rewinds and linked subagent conversations |
| A pull request review | author and author's agent, reviewer and reviewer's agent | the reviewer forks, the author merges the fork back |
| A chain of agents optimizing a metric | agents 1..d and an evaluator | forward messages between agents, critiques passed backward, scores as records; see [roadmap.md](roadmap.md#future-optimization-loops) |
| A human discussion thread | people only | one branch; importers for PR comments or chat threads are possible later |

The worked example in [examples/pr-review](../examples/pr-review) shows the second shape end to end.
