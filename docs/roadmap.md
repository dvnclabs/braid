# Roadmap

## Milestones

Each milestone is usable on its own, and the first one tests whether reviewers want conversations at all.

| # | Milestone | Scope |
|---|---|---|
| 0 | **Design** | This repository: concepts, format, CLI, a validated example |
| 1 | **Capture and digest** | Import Claude Code and Codex sessions through ATXF's converters; `braid save`; the commit trailer hook; `braid digest`; `braid pr open` posting the digest |
| 2 | **Load** | Replay in the same harness with path rewriting; briefings across harnesses; repository drift |
| 3 | **Branches** | `fork`, `reconcile`, `merge` with `-p`, `-F`, `-s` and the editor template; conflicts; strategies |
| 4 | **Review loop** | `braid pr review` with its checks; review branches; `braid pr sync`; the skills plugin for Claude Code and Codex |
| 5 | **Team scale** | Sync of `refs/braid/*` with reconciliation; the Entire importer; ATIF export; team redaction rules |

## Open questions

- **Implementation language.** TypeScript can use ATXF's npm package and the Claude and OpenAI agent SDKs directly. Rust has an ATXF crate and produces a single binary. Python is the quickest to prototype. The current preference is TypeScript.
- **Package name.** `braid` is taken on PyPI and npm.
- **ATXF maturity.** ATXF is a v0.1 draft with one maintainer and expects breaking changes. Keeping the raw files means any conversation can be regenerated into a successor format.
- **Branch names.** Labels on the first record of each branch keep names stable as branches grow. Usage will show whether people expect names that move with the head, as in git.
- **Where the digest lives.** A pull request comment is the simplest. A check run would keep the conversation tab clean.
- **Long conversations.** Sessions with thousands of records need range summaries for briefings and merges, and lazy loading of raw files.
- **Entire.** Capture through Entire where a team already uses it, or always capture independently.
- **Skill detection** in harnesses other than Claude Code.

## Future: optimization loops

braid started from a different idea: a chain of d agents that improves a numeric goal (a KPI) by a form of gradient descent, with an LLM writing the gradients. That idea is set aside for now. The design keeps room for it, and it needs no new primitives:

| Optimization concept | braid primitive |
|---|---|
| an agent's parameters θ | a skill or prompt file the agent loads |
| a step θ → θ' | a new version of that file, recorded in the conversation and committed |
| a forward pass through d agents | messages between linked conversations (`agent_link`) |
| a gradient | a critique passed from agent k+1 back to agent k |
| the KPI | a message from an evaluator participant, with the score in `ext.braid.metric` |
| a rejected step | an abandoned branch |
| a batch of candidate steps | forks |
| combining several gradients | a merge with an instruction such as "combine these critiques into one direction of change" |
| momentum | the log of past steps and the KPI change each one produced |

The PR review design already requires everything this table uses: open metadata on records, a merge instruction passed as a parameter, links between conversations, and headless runs.
