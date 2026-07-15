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

## Production activation

- Discovery found two AWS supervisors using the same Chow Telegram token.
- The duplicate PM2 `chow` process is stopped.
- Canonical runtime: user systemd `chow.service` in `/home/ubuntu/pi-hector`.
- The canonical source received a backed-up surgical patch preserving its
  substantial pre-existing uncommitted work.
- Canonical focused tests: PASS, 5/5.
- Canonical full bot esbuild bundle and Node syntax check: PASS.
- Canonical AWS-to-Mac adapter probe: 3 projects, 1 response gate, 0 errors.
- Canonical systemd stability probe: active, zero restart growth after startup.
- Harmless managed canary is paused at `operator-input`, with
  `response_required: true` and a valid bound token.

Final user-authenticated proof is pending: `/gates`, `Answer & continue`, then
reply `amber`. Until that exact callback/reply reaches terminal `SHIP`, the
production activation decision remains `fix_required`.

## Existing dependency risk

`npm audit` reports 12 existing dependency findings (1 low, 5 moderate, 6
high). This slice does not run an unbounded dependency upgrade because that
would broaden risk in the live bot; it should be handled as a separate tested
maintenance lane.
