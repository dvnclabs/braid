"""Write conversation.atxf.jsonl, the example braid conversation.

    python3 generate.py conversation.atxf.jsonl
"""
import json
import sys

ALICE = {"actorId": "alice@example.com", "userAgent": "claude-code/2.1"}
BOB = {"actorId": "bob@example.com", "userAgent": "codex/0.60"}
ALICE_BRAID = {"actorId": "alice@example.com", "userAgent": "claude-code/2.1 braid/0.0.0"}
CLAUDE = {"provider": "anthropic", "id": "claude-sonnet-5-5"}
CODEX = {"provider": "openai", "id": "gpt-5-codex"}

ALICE_SID = "5b0e2c1a-7f3d-4c2e-9a61-0d8e4b2f6c13"  # Claude Code session id (UUIDv4)
BOB_SID = "01a1bc3e-e950-7c4b-9e7a-62f0e9a7c418"    # Codex session id (UUIDv7)
SESSION = {"alice@example.com": ALICE_SID, "bob@example.com": BOB_SID}
CC_RAW = f"raw/claude-code/{ALICE_SID}.jsonl"
CX_RAW = f"raw/codex/rollout-2026-11-08T17-40-02-{BOB_SID}.jsonl"


def braid(actor, raw_file=None, line=None, **extra):
    b = {"actor": actor, "session": SESSION[actor["actorId"]]}
    if raw_file:
        b["raw"] = {"file": raw_file, "line": line}
    b.update(extra)
    return {"braid": b}


def msg(id, parent, time, role, content, actor, raw_file=None, line=None, part_of=None, **fields):
    rec = {"type": "message", "id": id, "parentId": parent, "time": time, "role": role}
    rec.update(fields)
    rec["content"] = content
    extra = {"partOf": part_of} if part_of else {}
    rec["ext"] = braid(actor, raw_file, line, **extra)
    return rec


def call(id, name, arguments):
    return {"type": "tool_call", "id": id, "name": name, "arguments": arguments}


def text(t):
    return {"type": "text", "text": t}


SUMMARY = (
    "Review by bob@example.com (Codex), merged into this branch. The retry count of 3 was never "
    "justified in the session. src/config.ts defines WEBHOOK_TIMEOUT_MS = 30000, which matches the "
    "30 s delivery SLA. Decision: retry until WEBHOOK_TIMEOUT_MS is spent instead of a fixed count, "
    "and keep the jitter added on this branch. No conflicts."
)

records = [
    {
        "type": "transcript",
        "atxf": "0.1",
        "id": ALICE_SID,
        "time": "2026-11-08T17:02:11Z",
        "title": "Add retries to the webhook sender",
        "source": {"agent": "braid", "version": "0.0.0"},
        "workspace": {
            "cwd": ".",
            "vcs": {"type": "git", "remote": "https://github.com/example/shop.git",
                    "branch": "webhook-retries", "commit": "4e1d9a7"},
        },
        "fidelity": {"topology": "tree", "native": "none"},
        "ext": {"braid": {"version": 1}},
    },
    # Alice's Claude Code session: retries.
    msg("e1", None, "2026-11-08T17:02:11Z", "user",
        "Webhook deliveries fail on transient 503s. Add retries to sendWebhook in src/webhooks/send.ts.",
        ALICE, CC_RAW, 4),
    msg("e2", "e1", "2026-11-08T17:02:15Z", "assistant",
        [{"type": "reasoning", "text": "Read the sender before changing it."},
         call("toolu_01", "Read", {"file_path": "src/webhooks/send.ts"})],
        ALICE, CC_RAW, 5, model=CLAUDE, stop="tool_use"),
    msg("e3", "e2", "2026-11-08T17:02:15Z", "tool",
        "import { withRetry } from \"./retry\";\n\n"
        "export async function sendWebhook(url: string, body: unknown) {\n"
        "  const res = await fetch(url, { method: \"POST\", body: JSON.stringify(body) });\n"
        "  if (!res.ok) throw new WebhookError(res.status);\n"
        "}",
        ALICE, CC_RAW, 6, toolCallId="toolu_01", toolName="Read"),
    msg("e4", "e3", "2026-11-08T17:02:31Z", "assistant",
        [text("send.ts already imports withRetry from src/webhooks/retry.ts. I'll wrap the request in it: "
              "3 attempts, exponential backoff from 200 ms."),
         call("toolu_02", "Edit", {
             "file_path": "src/webhooks/send.ts",
             "old_string": "const res = await fetch(url, { method: \"POST\", body: JSON.stringify(body) });",
             "new_string": "const res = await withRetry(() => fetch(url, { method: \"POST\", body: JSON.stringify(body) }), { attempts: 3, baseMs: 200 });"})],
        ALICE, CC_RAW, 7, model=CLAUDE, stop="tool_use"),
    msg("e5", "e4", "2026-11-08T17:02:32Z", "tool",
        "The file src/webhooks/send.ts has been updated.",
        ALICE, CC_RAW, 8, toolCallId="toolu_02", toolName="Edit"),
    msg("e6", "e5", "2026-11-08T17:02:40Z", "assistant",
        [call("toolu_03", "Bash", {"command": "npm test -- webhooks"})],
        ALICE, CC_RAW, 9, model=CLAUDE, stop="tool_use"),
    msg("e7", "e6", "2026-11-08T17:02:58Z", "tool",
        "Tests: 12 passed, 12 total",
        ALICE, CC_RAW, 10, toolCallId="toolu_03", toolName="Bash"),
    msg("e8", "e7", "2026-11-08T17:03:02Z", "assistant",
        [text("sendWebhook now retries 5xx responses up to 3 times (200, 400 and 800 ms). The webhook tests pass.")],
        ALICE, CC_RAW, 11, model=CLAUDE, stop="end"),
    # Alice keeps going in the same session: jitter.
    msg("e9", "e8", "2026-11-08T17:08:40Z", "user",
        "Add jitter to the backoff.",
        ALICE, CC_RAW, 12),
    msg("e10", "e9", "2026-11-08T17:08:47Z", "assistant",
        [call("toolu_04", "Edit", {"file_path": "src/webhooks/retry.ts",
                                   "old_string": "const delay = baseMs * 2 ** attempt;",
                                   "new_string": "const delay = Math.random() * baseMs * 2 ** attempt;"})],
        ALICE, CC_RAW, 13, model=CLAUDE, stop="tool_use"),
    msg("e11", "e10", "2026-11-08T17:08:48Z", "tool",
        "The file src/webhooks/retry.ts has been updated.",
        ALICE, CC_RAW, 14, toolCallId="toolu_04", toolName="Edit"),
    msg("e12", "e11", "2026-11-08T17:08:55Z", "assistant",
        [text("Added full jitter: each delay is now a random value between 0 and the exponential backoff.")],
        ALICE, CC_RAW, 15, model=CLAUDE, stop="end"),
    # Bob's Codex session forks at e8: his first turn loaded Alice's session.
    msg("r1", "e8", "2026-11-08T17:40:02Z", "user",
        "Review this PR. Why a fixed count of 3 retries? Our SLA gives each delivery 30 seconds.",
        BOB, CX_RAW, 3),
    msg("r2", "r1", "2026-11-08T17:40:09Z", "assistant",
        [call("call_r1", "exec_command", {"cmd": "rg -n WEBHOOK_TIMEOUT src"})],
        BOB, CX_RAW, 4, model=CODEX, stop="tool_use"),
    msg("r3", "r2", "2026-11-08T17:40:10Z", "tool",
        "src/config.ts:14:export const WEBHOOK_TIMEOUT_MS = 30_000;",
        BOB, CX_RAW, 5, toolCallId="call_r1", toolName="exec_command"),
    msg("r4", "r3", "2026-11-08T17:40:21Z", "assistant",
        [text("The session picked 3 without discussing the SLA. src/config.ts already defines "
              "WEBHOOK_TIMEOUT_MS = 30000, so retrying until that deadline would match the SLA and adapt if it changes.")],
        BOB, CX_RAW, 6, model=CODEX, stop="end"),
    msg("r5", "r4", "2026-11-08T17:41:30Z", "user",
        "Agreed. Recommendation for the author: retry until WEBHOOK_TIMEOUT_MS is spent and drop the fixed count.",
        BOB, CX_RAW, 7),
    # Alice runs /braid:sync. The turn's native records are kept and tagged partOf m1,
    # and the merge record continues from them, so the path from the root passes through m1.
    msg("s1", "e12", "2026-11-08T18:00:58Z", "user",
        "/braid:sync keep my jitter, adopt the reviewer's time budget",
        ALICE, CC_RAW, 16, part_of="m1"),
    msg("s2", "s1", "2026-11-08T18:01:00Z", "assistant",
        [call("toolu_05", "Bash", {"command": "braid merge --context 01a1bc3e"})],
        ALICE, CC_RAW, 17, part_of="m1", model=CLAUDE, stop="tool_use"),
    msg("s3", "s2", "2026-11-08T18:01:01Z", "tool",
        "Base e8. This session since the base: full jitter in src/webhooks/retry.ts (e9-e12). "
        "review/bob since the base: questioned the fixed count of 3 retries; found WEBHOOK_TIMEOUT_MS = 30000 "
        "in src/config.ts; recommends retrying until that deadline (r1-r5).",
        ALICE, CC_RAW, 18, part_of="m1", toolCallId="toolu_05", toolName="Bash"),
    msg("s4", "s3", "2026-11-08T18:01:11Z", "assistant",
        [text(SUMMARY)],
        ALICE, CC_RAW, 19, part_of="m1", model=CLAUDE, stop="end"),
    {
        "type": "branch_summary",
        "id": "m1",
        "parentId": "s4",
        "time": "2026-11-08T18:01:12Z",
        "fromId": "r5",
        "summary": SUMMARY,
        "ext": {"braid": {
            "actor": ALICE_BRAID,
            "session": ALICE_SID,
            "merge": {
                "base": "e8",
                "heads": ["s4", "r5"],
                "instruction": "keep my jitter, adopt the reviewer's time budget",
                "strategy": "review",
                "model": "anthropic:claude-sonnet-5-5",
                "conflicts": [],
            },
        }},
    },
    # Alice continues from the merge.
    msg("e13", "m1", "2026-11-08T18:02:05Z", "user",
        "Apply the merged review.",
        ALICE, CC_RAW, 20),
    msg("e14", "e13", "2026-11-08T18:02:20Z", "assistant",
        [call("toolu_06", "Edit", {"file_path": "src/webhooks/retry.ts",
                                   "old_string": "{ attempts, baseMs }: RetryOptions",
                                   "new_string": "{ deadlineMs, baseMs }: RetryOptions"}),
         call("toolu_07", "Edit", {"file_path": "src/webhooks/send.ts",
                                   "old_string": "{ attempts: 3, baseMs: 200 }",
                                   "new_string": "{ deadlineMs: WEBHOOK_TIMEOUT_MS, baseMs: 200 }"})],
        ALICE, CC_RAW, 21, model=CLAUDE, stop="tool_use"),
    msg("e15", "e14", "2026-11-08T18:02:21Z", "tool",
        "The file src/webhooks/retry.ts has been updated.",
        ALICE, CC_RAW, 22, toolCallId="toolu_06", toolName="Edit"),
    msg("e16", "e15", "2026-11-08T18:02:21Z", "tool",
        "The file src/webhooks/send.ts has been updated.",
        ALICE, CC_RAW, 23, toolCallId="toolu_07", toolName="Edit"),
    msg("e17", "e16", "2026-11-08T18:02:40Z", "assistant",
        [text("withRetry now takes a deadline instead of an attempt count. sendWebhook passes "
              "WEBHOOK_TIMEOUT_MS and keeps the jittered backoff between attempts.")],
        ALICE, CC_RAW, 24, model=CLAUDE, stop="end"),
    # A name for Bob's session, on its first record.
    {"type": "label", "id": "l1", "time": "2026-11-08T17:40:02Z", "targetId": "r1",
     "label": "review/bob", "ext": braid(BOB)},
]

with open(sys.argv[1], "w") as f:
    for r in records:
        f.write(json.dumps(r, ensure_ascii=False) + "\n")
print(f"wrote {len(records)} records to {sys.argv[1]}")
