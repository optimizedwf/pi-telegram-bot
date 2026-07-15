# Chow Telegram Archon Gates v1

## Outcome

The authenticated Chow Telegram chat can inspect Archon gates owned by the
versioned Chow control plane, approve plain gates, answer response-capture
gates, and resume the exact bound run.

## Acceptance criteria

- `/gates` reads the managed Recovery Inbox from configured Mac repositories.
- Gate capability tokens never appear in Telegram callback data.
- Every click or answer re-fetches the gate and rejects stale or ambiguous
  handles.
- Plain approvals reject supplied text; response gates require nonblank text.
- Control commands fail closed without an explicit chat allowlist and repository
  allowlist.
- The AWS bot contains no duplicate workflow selection, gate, or continuation
  logic; `chow-control` remains authoritative.
- No production restart or live activation occurs without a separate operator
  approval.

## Non-goals

- Moving the managed execution ledger to AWS.
- Running Archon directly inside the Telegram bot.
- General remote shell access from Telegram.
- Automatically approving safety or response gates.
