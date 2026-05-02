# Catholic Market Eval Summary

- generated_at: `2026-05-02T07:22:13Z`
- base_url: `http://127.0.0.1:8110`
- pass: **YES**
- checks: `12/12`
- failed: `0`
- p95_ms: `14518.63`

## Check results

- [PASS] `health_gate` (51.26 ms) — health endpoint valid
- [PASS] `catalog_gate` (27.93 ms) — catalog returned items
- [PASS] `destination_browse_gate` (37.99 ms) — destinations endpoint + filtered catalog valid
- [PASS] `ai_recommend_gate` (8046.95 ms) — recommendations returned
- [PASS] `ranking_eval_gate` (48186.98 ms) — 6/6 golden tests passed
- [PASS] `chat_sse_gate` (14518.63 ms) — SSE stream valid (6360 bytes)
- [PASS] `social_gate` (20.82 ms) — social draft payload valid
- [PASS] `mobile_html_gate` (39.2 ms) — viewport and bottom nav present
- [PASS] `auth_saved_gate` (102.65 ms) — guest auth and save/unsave flow valid
- [PASS] `cart_checkout_intent_gate` (145.06 ms) — cart add/update + checkout intent idempotency valid
- [PASS] `checkout_order_ops_gate` (96.95 ms) — dry-run checkout + order ops valid
- [PASS] `analytics_gate` (31.62 ms) — post + summary valid (total: 110, event_id: 4a51d2b5-34cf-4276-b1f7-d3b53f9d4ebc)
