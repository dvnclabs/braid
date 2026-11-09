# Pull request review

The first use of braid is code review on teams that write code with agents. The author's conversation travels with the pull request. The reviewer reads a digest, questions the session when the digest raises a question, and sends a review branch back. The author merges that branch into their own conversation and continues with the review in context.

```
author                                       reviewer
------                                       --------
works with an agent
braid pr open  ──────────────────────►  PR #128, with a digest comment
                                             braid pr review 128
                                             reads the digest, questions the session
                ◄────────────────────── review branch pushed
braid pr sync 128 -p "..."
continues with the review in context
```

## Capture

`braid init` installs a `prepare-commit-msg` hook. While a captured session is active, every commit gets a trailer:

```
Braid-Conversation: conv-01JC8Q4W5T
```

A harness hook at session start tells braid which session is active. Without hooks, `braid import --latest` finds the newest session for the repository. A pull request can involve several sessions and several people, and braid collects the conversations from every trailer on the PR's commits.

## `braid pr open`

1. Imports new records from the active sessions.
2. Redacts secrets and shows the author a preview of everything that will be shared, digest included. The author can drop records or publish only a range. See [security.md](security.md).
3. Pushes the conversation to `refs/braid/conversations/<id>`.
4. Creates the pull request with `gh pr create` if it does not exist yet, and posts the digest as a comment. Later pushes edit that same comment.

## The digest

The digest is what most reviewers will read, so it is short and organized around review questions:

| Section | Contents |
|---|---|
| Request | what the author asked for, quoted |
| Decisions | each decision, with the reason given in the conversation |
| Rejected approaches | what was tried and dropped, and why |
| Assumptions | places where the agent assumed something it did not check |
| Evidence | commands that ran and their results: tests, builds, linters |
| Files | files touched, grouped by kind of change |
| Load | `braid pr review 128` or `/braid:review-pr 128` |

For the [example conversation](../examples/pr-review), the digest would read:

> **Request:** "Webhook deliveries fail on transient 503s. Add retries to sendWebhook."
>
> **Decisions**
> - Retry 5xx responses with exponential backoff from 200 ms. *Reason given: transient 503s.*
> - Full jitter on each delay. *Requested by the author.*
>
> **Assumptions**
> - The retry count of 3 was chosen without reference to the delivery SLA.
>
> **Evidence**
> - `npm test -- webhooks`: 12 passed, 12 total.
>
> **Files:** edited `src/webhooks/send.ts`, `src/webhooks/retry.ts`.

## `braid pr review <n>`

Run it in a terminal, or as `/braid:review-pr <n>` inside an agent.

1. Fetches the pull request's conversations and its diff.
2. When there are several conversations, merges them into one briefing with the `review` strategy. `-p` steers it, for example `-p "focus on the auth changes"`.
3. Runs checks before the reviewer asks anything:
   - **Claims against evidence.** When the conversation says "tests pass", is there a shell record that ran them, with a passing result?
   - **Diff against conversation.** Files in the diff that no record mentions or edits were changed outside the captured sessions.
   - **Unexplained decisions.** Choices visible in the code with no discussion behind them.
   - **Dead ends.** Approaches tried and dropped, so the reviewer does not propose them again.
   - **Drift.** Commits added to the pull request after the conversation's last record.
4. Reports the findings, and then the reviewer asks their own questions. The reviewer's turns go on a branch named `review/<reviewer>`.
5. At the end, shows the reviewer a preview and pushes the review branch. It can also draft GitHub review comments from the findings, which it posts only after the reviewer confirms.

## `braid pr load <n>`

For an author returning to a branch, or a teammate taking it over. From a terminal it replays the conversation when the harness matches and starts a new session. Inside an agent, `/braid:load-pr <n>` injects a briefing into the current session.

## `braid pr sync <n>`

For the author, after a review:

1. Fetches the review branches.
2. Merges them into the author's branch with the `review` strategy and any `-p` instruction. Conflicts follow the flow in [operations.md](operations.md#output-and-conflicts).
3. Offers to resume the author's session with the merge record in context.

## Skills

The workflow ships as agent skills, packaged as a plugin named `braid` so the commands do not collide with other review commands:

| Skill | Inside an agent | Terminal equivalent |
|---|---|---|
| open-pr | `/braid:open-pr` | `braid pr open` |
| review-pr | `/braid:review-pr <n>` | `braid pr review <n>` |
| load-pr | `/braid:load-pr <n>` | `braid pr load <n>` |
| sync-pr | `/braid:sync-pr <n>` | `braid pr sync <n>` |

Three design rules:

1. **A skill runs inside a live session and cannot replace that session's history.** In-session commands therefore work with briefings. Exact replay starts from the terminal, where braid launches a new harness session.
2. **Skills stay thin.** Each `SKILL.md` calls the CLI and holds the judgment: what to check in a review, how to phrase a finding. The logic lives in the CLI, where it behaves the same in every harness and has tests.
3. **One set of files for every harness.** Claude Code and Codex both read `SKILL.md`. Each harness has its own invocation syntax.

### Skills used inside a conversation

A session that relied on a skill depends on that skill's instructions. Loading the session elsewhere without the skill leaves the agent mid-task without the rules it was following. braid detects skill loads in transcripts (Claude Code records them as `Skill` tool calls) and notes each skill's name and content hash. On load, braid checks that the target has the same version, and otherwise includes the skill's text in the briefing.

## Forges

braid uses the `gh` CLI and its login for GitHub. GitLab and other forges can follow through the same interface: find a pull request's commits, post and edit a comment, read the diff.
