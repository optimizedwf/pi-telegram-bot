# Validation

## Deterministic checks

- `npm ci`: PASS.
- `npm run test:chow-control`: PASS, 5/5.
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
- Plain approval gates reject answers.
- The continuation command supplies the repository, exact expected gate token,
  explicit acknowledgement, and optional answer to `chow-control`.

## Live read-only bridge

- AWS host: `ubuntu@100.105.34.85`, Node `v22.22.2`.
- AWS can SSH to the Mac orchestrator as `adam26@100.114.125.71`.
- The installed Mac bridge returned contract
  `chow.flow.managed-recovery` version 1 with `read_only: true` for Flow.
- The new adapter queried both `flow` and `chow`: 0 pending gates, 0 errors.
- Existing AWS `chow` PM2 process remained online and was not restarted.

## Activation gate

The live `.env` does not currently expose `ALLOWED_CHAT_IDS` or
`CHOW_CONTROL_ALLOWED_CHAT_IDS`. The new control surface therefore correctly
stays disabled. Activation requires adding the explicit Chow chat ID and the
two repository paths, installing the staged source, then restarting only the
`chow` PM2 process after operator approval.

## Existing dependency risk

`npm audit` reports 12 existing dependency findings (1 low, 5 moderate, 6
high). This slice does not run an unbounded dependency upgrade because that
would broaden risk in the live bot; it should be handled as a separate tested
maintenance lane.
