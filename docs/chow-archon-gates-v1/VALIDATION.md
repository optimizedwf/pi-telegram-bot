# Validation

## Deterministic checks

- `npm ci`: PASS.
- `npm run test:chow-control`: PASS, 6/6.
- Adapter TypeScript transpilation through the repository's `tsx` runtime:
  PASS.
- Full bot esbuild syntax/bundle check with the existing external Hive sibling:
  PASS.
- `node --check` on the generated ESM bundle: PASS.
- `git diff --check`: PASS.

## Contract checks

- Invalid project names, relative paths, SSH targets, job IDs, contracts, and
  repository mismatches are rejected.
- Callback handles are deterministic 16-character opaque hashes and contain no
  gate token.
- Gate selection is re-fetched before continuation; stale handles fail closed.
- Response gates require a nonblank answer.
- Pending answers match the exact force-reply prompt. In Telegram forum topics,
  where Desktop may retain the topic-root reply instead, the fallback accepts
  only the explicitly armed same chat, same user, and same topic.
- Plain approval gates reject answers.
- The continuation command supplies the repository, exact expected gate token,
  explicit acknowledgement, and optional answer to `chow-control`.

## Live read-only bridge

- AWS host: `ubuntu@100.105.34.85`, Node `v22.22.2`.
- AWS can SSH to the Mac orchestrator as `adam26@100.114.125.71`.
- The installed Mac bridge returned contract
  `chow.flow.managed-recovery` version 1 with `read_only: true` for Flow.
- The production adapter queried both `flow` and `chow`: 0 pending gates, 0
  errors after canary cleanup.
- The duplicate AWS PM2 `chow` process is stopped; canonical ownership belongs
  to user systemd `chow.service`.

## Production activation

- Discovery found two AWS supervisors using the same Chow Telegram token.
- The duplicate PM2 `chow` process is stopped.
- Canonical runtime: user systemd `chow.service` in `/home/ubuntu/pi-hector`.
- The canonical source received a backed-up surgical patch preserving its
  substantial pre-existing uncommitted work.
- Canonical focused tests: PASS, 6/6.
- Canonical full bot esbuild bundle and Node syntax check: PASS.
- The first live canary exposed a Telegram Desktop forum-topic behavior: the
  typed response stayed attached to the topic root rather than the force-reply
  prompt. The strict binding correctly refused to continue the gate.
- A narrow forum-topic fallback was added, tested, bundled, backed up, and
  activated. It still requires the explicit callback plus the same chat, user,
  and topic, and re-fetches the exact gate before continuation.
- The retried user-authenticated path `/gates` -> `Answer & continue` ->
  `amber` resumed managed job
  `job-managed-91f5a9f24e36f4a5ca111581df7b1f21` and Archon run
  `2e2c4bf2b88d5b9599993aad4f34b69f`.
- The managed owner and native Archon run both completed with decision `SHIP`.
- `owner.json` and `execution-request.json` record the same continuation
  response SHA-256, proving the answer was bound into the managed request.
- `SPEC.md`, `PLAN.md`, `VALIDATION.md`, `EVAL.json`, and `FINAL_REPORT.md` are
  all nonempty in the exact run artifact root; the run `EVAL.json` says `SHIP`.
- The temporary canary repository was removed from production configuration.
- Final canonical probe: projects `flow` and `chow`, 0 gates, 0 errors.
- Final systemd probe: active/running, zero restart growth over 25 seconds, no
  Telegram 409 conflict; duplicate PM2 `chow` remains stopped.

## Existing dependency risk

`npm audit` reports 12 existing dependency findings (1 low, 5 moderate, 6
high). This slice does not run an unbounded dependency upgrade because that
would broaden risk in the live bot; it should be handled as a separate tested
maintenance lane.
