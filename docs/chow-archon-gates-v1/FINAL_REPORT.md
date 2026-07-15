# Final report

Decision: SHIP for production activation.

Chow now has one Telegram-facing Recovery Inbox. `/gates` retrieves bound
Archon gates from the Mac control plane, presents either `Approve & continue`
or `Answer & continue`, revalidates the gate at interaction time, and delegates
continuation to the installed `chow-control` runtime. Telegram never owns the
workflow state or receives a raw capability token.

The feature fails closed unless an explicit control-chat allowlist and
repository allowlist are configured. Response prompts expire after ten minutes.
The normal path binds the exact force-reply prompt. Telegram forum topics
additionally support a narrowly bound fallback after the explicit button click:
same chat, same user, and same topic.

AWS contained two Chow supervisors sharing one Telegram polling token. The
duplicate PM2 process is now stopped, and the canonical user systemd
`chow.service` in `/home/ubuntu/pi-hector` is active with the gate adapter and
explicit allowlists. Its pre-existing dirty source was preserved through a
timestamped backup and surgical patch.

The canonical runtime passes 6/6 focused tests, a full bot bundle/syntax check,
the AWS-to-Mac adapter probe, and supervisor stability checks. The live
user-authenticated canary resumed the exact bound managed job with `amber`; both
the native Archon run and managed owner reached terminal `SHIP`, all five eval
artifacts are present, and the response SHA is recorded in the managed owner.

The temporary canary repository is no longer production-allowlisted. The final
adapter surface contains only `flow` and `chow`, reports zero gates and zero
errors, canonical `chow.service` is active without restart growth or polling
conflicts, and the duplicate PM2 `chow` remains stopped.
