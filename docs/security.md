# Privacy and redaction

Agent transcripts hold more than code. They contain file contents, environment variables, command output, customer data pulled from logs, and remarks people type to an agent and would not say to a colleague. braid shares conversations only when the author asks, only with people who can already read the repository, and only after redaction and a preview.

## Defaults

- **Local until published.** `braid import` and `braid save` write to the local machine. Nothing leaves it until `braid push` or `braid pr open`.
- **Opt-in per pull request.** Capturing a session does not publish it. The author decides for each pull request.
- **Preview before every push.** The author sees the exact records and the digest that will be shared.
- **Selective publishing.** The author can drop single records or publish one range of the conversation, for example from the request that started the feature to the last commit.

## Who can read a conversation

Conversations pushed to a repository live under `refs/braid/` in that repository, so they have the repository's access control. Anyone who can clone the repository can fetch its conversations. braid adds no separate hosting and no separate permissions.

For a public repository this means published conversations are public. `braid push` warns when the remote is public and requires `--public` to continue.

## Redaction

Before anything is pushed, braid scans both the ATXF file and the raw files with an established secret scanner such as [gitleaks](https://github.com/gitleaks/gitleaks), plus rules the team adds in `.braid/redact.toml`:

```toml
[[rule]]
description = "internal customer ids"
regex = "cus_[A-Za-z0-9]{14}"

[[rule]]
description = "anything under the fixtures folder"
path = "tests/fixtures/**"
```

Each match is replaced with a marker such as `[REDACTED:aws-access-key]`. The published record lists what was removed in `ext.braid.redactions`, so readers know the content was changed and replay tools know an exact replay is no longer possible:

```json
"ext": { "braid": { "redactions": [ { "rule": "aws-access-key", "count": 1 } ] } }
```

The local copy keeps the original. Raw files stay byte for byte on the author's machine, and the published raw files are redacted copies.

Pattern scanning misses secrets that look like ordinary text. The preview step exists for that reason, and teams with sensitive data should also limit which sessions get captured.

## What braid sends to model providers

Merges, digests and briefings send conversation text to the configured LLM provider. Teams choose that provider in `.braid/config.toml`, and can point it at a harness they already use (`claude-code:default`) or at a self-hosted endpoint. Redaction runs before any text goes to a provider for a digest that will be published.
