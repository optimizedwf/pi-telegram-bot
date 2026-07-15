# Final report

Decision: FIX_REQUIRED for production activation. Code and deterministic checks
pass; the final user-authenticated Telegram canary is awaiting input.

Chow now has one Telegram-facing Recovery Inbox. `/gates` retrieves bound
Archon gates from the Mac control plane, presents either `Approve & continue`
or `Answer & continue`, revalidates the gate at interaction time, and delegates
continuation to the installed `chow-control` runtime. Telegram never owns the
workflow state or receives a raw capability token.

The feature fails closed unless an explicit control-chat allowlist and
repository allowlist are configured. Response prompts expire after ten minutes
and must be answered as a reply by the same Telegram user in the same chat.

AWS contained two Chow supervisors sharing one Telegram polling token. The
duplicate PM2 process is now stopped, and the canonical user systemd
`chow.service` in `/home/ubuntu/pi-hector` is active with the gate adapter and
explicit allowlists. Its pre-existing dirty source was preserved through a
timestamped backup and surgical patch.

The canonical runtime passes 5/5 focused tests, a full bot bundle/syntax check,
the AWS-to-Mac adapter probe, and a no-restart-growth stability check. A harmless
response canary is visible to the bot and paused safely. Production becomes
SHIP only after the operator answers it with `amber` and the same managed Archon
run reaches terminal SHIP.
