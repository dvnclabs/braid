# braid

Version control for agent conversations. braid saves the conversations you have with coding agents (Claude Code, Codex and others), lets you fork them, hand them to a teammate, merge them back with an instruction you write, and attach them to the pull requests they produced.

> **Status: design draft.** There is no code yet. This repository holds the design, a worked example, and the plan. Feedback is welcome in issues.

## Why

A pull request written with an agent arrives as a diff. The conversation behind it stays on the author's laptop: the request, the approaches the agent tried and dropped, the commands it ran, the places where it guessed. Reviewers reconstruct that context from the code. An author who returns to the branch a week later starts a fresh session. A teammate who takes over the branch starts from nothing.

braid keeps the conversation next to the code, in a form any harness can read:

- **Save** a session from any supported harness to a folder or to your git repository.
- **Share** it with everyone who already has access to the repository.
- **Load** it into Claude Code, Codex or another harness, as an exact replay in the same harness or as a briefing in any harness.
- **Fork** it at any point, and **merge** forks back with an instruction: `braid merge alice/jitter review/bob -p "keep my jitter, adopt the reviewer's time budget"`.
- **Attach** it to a pull request. Reviewers get a digest and can question the session that wrote the code.

## A short tour

The CLI below is the planned interface.

```sh
# Author: capture the session behind this branch and open a PR with it
braid import claude-code --latest
braid pr open

# Reviewer: load the PR's conversation into your own agent and question it
braid pr review 128              # or /braid:review-pr 128 inside Claude Code or Codex

# Author: bring the reviewer's fork into your conversation
braid pr sync 128 -p "adopt the reviewer's naming, keep my retry logic"

# Anyone: write a conversation to a folder
braid save pr:128 ./conversations/pr-128
```

## The model in one paragraph

A conversation is a tree of records written by any number of participants: people, agents and tools. A fork is a branch of the tree. A **merge** asks an LLM to combine what the branches learned, following your instruction, and records the instruction, the model and the merge base next to the result. A **projection** renders the stored conversation for one participant in one harness: that participant's turns become `assistant` turns, and everyone else's become `user` turns labeled with the speaker. That is how one conversation moves between people, agents and harnesses. [docs/concepts.md](docs/concepts.md) has the details.

## Open formats underneath

braid reuses existing formats and adds as little as possible on top.

- **Native session files are the source of truth.** braid keeps the files your harness wrote (Claude Code JSONL, Codex rollouts) byte for byte.
- **[ATXF](https://github.com/leostera/atxf)** (Agent Transcript Exchange Format) holds the conversation tree. It already models branches, rewinds, compaction, subagents and verbatim native records. braid stores participants and merge metadata in an `ext.braid` namespace.
- **[ATIF](https://docs.harborframework.com/agents/atif)** export is available for the Harbor, NVIDIA NeMo and Arize Phoenix tools.

A conversation saved to a folder:

```
pr-128/
  conversation.atxf.jsonl          # the tree: every branch, merge and participant
  raw/
    claude-code/5b0e2c1a.jsonl     # native files, byte for byte
    codex/rollout-2026-11-08T17-40-02-8d2f.jsonl
  trajectory.json                  # optional ATIF export of one branch
```

[examples/pr-review](examples/pr-review) walks through a complete conversation: an author on Claude Code, a reviewer on Codex, and a merge. The file validates against the ATXF v0.1 schema.

## Documentation

| Document | Contents |
|---|---|
| [Concepts](docs/concepts.md) | Conversations, participants, branches, projection, the operations |
| [Format](docs/format.md) | On-disk layout, ATXF usage, the `ext.braid` fields, git storage |
| [Operations and CLI](docs/operations.md) | Every command, with merge, load and conflict handling in detail |
| [Adapters](docs/adapters.md) | Harness adapters (Claude Code, Codex, ...) and LLM providers |
| [PR review](docs/pr-review.md) | The review workflow, the digest, and the agent skills |
| [Privacy and redaction](docs/security.md) | What gets shared, with whom, and how secrets are removed |
| [Prior art](docs/prior-art.md) | Related tools and specs, and how braid fits with them |
| [Roadmap](docs/roadmap.md) | Milestones, open questions, and future uses |

## License

[MIT](LICENSE)
