# Prior art

Surveyed in November 2026. Several projects cover parts of what braid needs, and braid is designed to build on them. Corrections are welcome: these projects move quickly.

## Capturing and sharing agent sessions

| Project | What it does | Relation to braid |
|---|---|---|
| [Entire](https://docs.entire.io/overview) | Open-source CLI (MIT) that records agent sessions per commit, stores full transcripts in the repository under `refs/entire/checkpoints/`, adds an `Entire-Checkpoint` commit trailer, redacts secrets, and supports Claude Code, Codex, Cursor, Copilot CLI and others. A web viewer shows checkpoints next to their diff. | Closest in storage design. Its docs describe no fork, merge or cross-harness load. braid plans to import Entire checkpoints as a native source. |
| [Traces](https://www.traces.com/docs) | Uploads a session from many harnesses and returns a shareable link; can follow a live session; has skills to share from inside an agent. | Hosted sharing. braid keeps conversations in the team's repository. |
| [Hugging Face Agent Traces](https://huggingface.co/docs/hub/agent-traces) | The Hub detects Claude Code, Codex and Pi session files in datasets and shows them in a trace viewer. Other harnesses can use its [Session Trace format](https://huggingface.co/docs/hub/session-traces-format). | Publishing traces as datasets. |
| [SpecStory](https://specstory.com/learning/ai-coding/ai-coding-session-history) | Saves agent chat history into the project and recommends linking transcripts from pull requests. | The practice braid automates. |

## Attributing code to agents

| Project | What it does | Relation to braid |
|---|---|---|
| [git-ai](https://github.com/acunniffe/git-ai) | Records which agent, model and session wrote each line, in git notes, and keeps attribution through rebases and squashes. | Line-level attribution. braid links whole conversations to commits and could read git-ai's data. |
| [Agent Trace](https://agent-trace.dev/) | Draft specification from Cursor for linking code ranges to the conversations behind them, with support from Cognition, Cloudflare, Vercel and others. | Complementary. A braid conversation is a natural target for an Agent Trace record. |

## Transcript formats

| Format | Notes |
|---|---|
| [ATXF](https://github.com/leostera/atxf) | JSONL transcript format with branches, rewinds, compaction, subagents and verbatim native records. v0.1 draft; v0.2 draft adds per-record attribution. **braid's storage format.** |
| [ATIF](https://docs.harborframework.com/agents/atif) | Trajectory format from Harbor, used by NVIDIA NeMo and Arize Phoenix. Linear, one JSON file. **braid exports it.** |
| [AgentLog](https://github.com/braintied/agentlog) | Single-document JSON format for sessions, draft 0.2.0. |
| [OpenTelemetry GenAI](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-events) | Message-level schema for observability: parts for text, tool calls and tool results. |
| [Open Responses](https://openresponses.org/) | Multi-provider specification based on OpenAI's Responses API, built around typed items. |

## Moving sessions between harnesses

| Project | What it does |
|---|---|
| [casr](https://github.com/Dicklesworthstone/cross_agent_session_resumer) | Converts sessions between Claude Code, Codex, Gemini CLI and others through a common intermediate form, so one harness can resume another's session. |
| [agent-plugin-resume](https://github.com/AkaraChen/agent-plugin-resume), [agent-session-resume](https://github.com/hacktivist123/agent-session-resume) | Skills and plugins that resume or hand off sessions across Claude Code, Codex, Cursor and others. |

## Branching and merging conversations

| Project | What it does |
|---|---|
| [Forky](https://github.com/ishandhanani/forky) | Git-style branching for LLM chats, with a three-way semantic merge and conflict detection. |
| [Branch Agent](https://dev.to/harishkotra/branch-agent-git-style-branching-for-llm-conversations-5c61) | Web app that forks conversations at any message and merges forks back with an LLM summary. |
| [GitChat](https://github.com/DrustZ/GitChat) | Branches a chat and rewires which branches feed the context of a new one. |
| [ContextBranch](https://arxiv.org/pdf/2512.13914) | Paper that formalizes version-control semantics for LLM conversations. |

These tools work on single-user chats. braid applies the same ideas to coding-agent sessions shared by a team.

## What braid adds

- **Merging agent sessions with an instruction**, recorded with its base, model and conflicts.
- **Conversations with many participants**, rendered for each viewer by projection, so they move between people and harnesses.
- **The review loop:** the reviewer forks the author's conversation, questions it, and the author merges the review back.
- **Digests on the pull request**, with claims in the conversation checked against what the agent ran.
