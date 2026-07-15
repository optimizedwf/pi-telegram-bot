# Final report

Decision: SHIP for code and staged release. Live activation is intentionally
pending.

Chow now has one Telegram-facing Recovery Inbox. `/gates` retrieves bound
Archon gates from the Mac control plane, presents either `Approve & continue`
or `Answer & continue`, revalidates the gate at interaction time, and delegates
continuation to the installed `chow-control` runtime. Telegram never owns the
workflow state or receives a raw capability token.

The feature fails closed unless an explicit control-chat allowlist and
repository allowlist are configured. Response prompts expire after ten minutes
and must be answered as a reply by the same Telegram user in the same chat.

The live bot was inspected read-only and left online without restart. Its
current environment lacks the required control allowlist, so no gate control is
active yet. The release can be staged safely; activation needs one focused PM2
restart and an end-to-end synthetic gate canary after operator approval.
