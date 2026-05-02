#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Tuple

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BASE_URL = "http://127.0.0.1:8110"


def _fetch(url: str, method: str = "GET", payload: Dict[str, Any] | None = None, timeout: int = 15) -> Tuple[int, str, float]:
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    started = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            return int(resp.status), body, time.time() - started
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        return int(exc.code), body, time.time() - started


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def run(base_url: str) -> Dict[str, Any]:
    checks: List[Dict[str, Any]] = []

    def add_check(name: str, passed: bool, detail: str, elapsed_ms: float) -> None:
        checks.append(
            {
                "name": name,
                "passed": passed,
                "detail": detail,
                "elapsed_ms": round(elapsed_ms, 2),
            }
        )

    sample_product_id = ""

    # health gate
    status, body, elapsed = _fetch(f"{base_url}/health")
    try:
        payload = json.loads(body or "{}")
    except Exception:
        payload = {}
    try:
        _assert(status == 200, f"expected 200 got {status}")
        _assert(bool(payload.get("ok")), "health ok=false")
        _assert(int(payload.get("products") or 0) >= 1, "expected >=1 products")
        add_check("health_gate", True, "health endpoint valid", elapsed * 1000)
    except AssertionError as exc:
        add_check("health_gate", False, str(exc), elapsed * 1000)

    # catalog gate
    status, body, elapsed = _fetch(f"{base_url}/api/v1/catalog/feed?limit=5")
    try:
        payload = json.loads(body or "{}")
    except Exception:
        payload = {}
    try:
        _assert(status == 200, f"expected 200 got {status}")
        items = payload.get("items") or []
        _assert(isinstance(items, list) and len(items) >= 3, "expected >=3 catalog items")
        sample_product_id = str((items[0] or {}).get("product_id") or "").strip()
        _assert(bool(sample_product_id), "sample product_id missing from catalog")
        add_check("catalog_gate", True, "catalog returned items", elapsed * 1000)
    except AssertionError as exc:
        add_check("catalog_gate", False, str(exc), elapsed * 1000)

    # destination browse gate
    status, body, elapsed = _fetch(f"{base_url}/api/v1/destinations?limit=10")
    try:
        payload = json.loads(body or "{}")
    except Exception:
        payload = {}
    try:
        _assert(status == 200, f"expected 200 got {status}")
        destinations = payload.get("items") or []
        _assert(isinstance(destinations, list) and len(destinations) >= 1, "expected >=1 destination")
        destination_id = str((destinations[0] or {}).get("destination_id") or "").strip()
        _assert(bool(destination_id), "destination_id missing")

        status2, body2, elapsed2 = _fetch(f"{base_url}/api/v1/catalog/feed?destination={destination_id}&limit=5")
        _assert(status2 == 200, f"destination catalog expected 200 got {status2}")
        payload2 = json.loads(body2 or "{}")
        _assert(int(payload2.get("count") or 0) >= 1, "destination catalog empty")

        add_check("destination_browse_gate", True, "destinations endpoint + filtered catalog valid", (elapsed + elapsed2) * 1000)
    except Exception as exc:
        add_check("destination_browse_gate", False, str(exc), elapsed * 1000)

    # AI recommendation gate
    status, body, elapsed = _fetch(
        f"{base_url}/api/v1/ai/recommend",
        method="POST",
        payload={
            "intent": "confirmation gift from italy",
            "budget_usd": 50,
            "occasion": "confirmation",
            "limit": 3,
        },
    )
    try:
        payload = json.loads(body or "{}")
    except Exception:
        payload = {}
    try:
        _assert(status == 200, f"expected 200 got {status}")
        recommendations = payload.get("recommendations") or []
        _assert(isinstance(recommendations, list) and len(recommendations) >= 1, "no recommendations returned")
        top = recommendations[0].get("product") or {}
        _assert(bool(top.get("product_id")), "top recommendation missing product_id")
        add_check("ai_recommend_gate", True, "recommendations returned", elapsed * 1000)
    except AssertionError as exc:
        add_check("ai_recommend_gate", False, str(exc), elapsed * 1000)

    # ─── Ranking eval: golden test cases ──────────────────
    RANKING_TESTS = [
        {
            "label": "confirmation_italy",
            "intent": "confirmation gift from Italy",
            "occasion": "confirmation",
            "budget_usd": 60,
            "limit": 3,
            "must_include_any": [],
            "expect_top_any": [],
        },
        {
            "label": "healing_after_surgery",
            "intent": "something for healing after surgery",
            "occasion": "healing",
            "budget_usd": 50,
            "limit": 3,
            "must_include_any": ["prod_monastery_candle", "prod_monastery_soap"],
            "expect_top_any": [],
        },
        {
            "label": "wedding_under_40",
            "intent": "wedding gift under $40",
            "occasion": "wedding",
            "budget_usd": 40,
            "limit": 3,
            "must_include_any": [],
            "budget_check": True,
        },
        {
            "label": "first_communion_rosary",
            "intent": "rosary for first communion",
            "occasion": "first_communion",
            "budget_usd": 60,
            "limit": 3,
            "must_include_any": ["prod_cw_full_grace", "prod_catholically_murrina", "prod_cw_mother_pure"],
            "expect_top_any": [],
        },
        {
            "label": "guadalupe_gift",
            "intent": "something from Guadalupe for my goddaughter",
            "occasion": "baptism",
            "budget_usd": 30,
            "limit": 3,
            "must_include_any": [],
            "expect_top_any": [],
        },
        {
            "label": "house_blessing",
            "intent": "bless my new apartment",
            "occasion": "house_blessing",
            "budget_usd": 50,
            "limit": 3,
            "must_include_any": ["prod_monastery_soap", "prod_monastery_candle", "prod_monastery_candle"],
            "expect_top_any": [],
        },
    ]

    ranking_delta_ms = 0.0
    ranking_passed = 0
    ranking_total = 0
    ranking_details: List[str] = []

    for test in RANKING_TESTS:
        ranking_total += 1
        status, body, elapsed = _fetch(
            f"{base_url}/api/v1/ai/recommend",
            method="POST",
            payload={
                "intent": test["intent"],
                "occasion": test["occasion"],
                "budget_usd": test["budget_usd"],
                "limit": test["limit"],
            },
        )
        ranking_delta_ms += elapsed * 1000
        try:
            payload = json.loads(body or "{}")
        except Exception:
            payload = {}

        recs = payload.get("recommendations") or []
        rec_ids = [(r.get("product") or {}).get("product_id") for r in recs]

        test_passed = True
        failures: List[str] = []

        if test.get("must_include_any"):
            if not any(pid in rec_ids for pid in test["must_include_any"]):
                test_passed = False
                failures.append(f"none of {test['must_include_any']} in {rec_ids[:3]}")

        if test.get("expect_top_any"):
            if rec_ids and rec_ids[0] not in test["expect_top_any"]:
                test_passed = False
                failures.append(f"expected top in {test['expect_top_any']}, got {rec_ids[0]}")

        if test.get("budget_check") and recs:
            over_budget = [
                (r.get("product") or {}).get("title")
                for r in recs
                if (r.get("product") or {}).get("price_cents", 0) / 100 > test["budget_usd"]
            ]
            if len(over_budget) == len(recs):
                test_passed = False
                failures.append(f"all {len(over_budget)} results over ${test['budget_usd']} budget")

        if test_passed:
            ranking_passed += 1

        ranking_details.append(
            "PASS" if test_passed else "FAIL",
        )
        if failures:
            ranking_details[-1] += f": {', '.join(failures)}"

    detail_lines = []
    for i, detail in enumerate(ranking_details):
        if "FAIL" in detail:
            label = RANKING_TESTS[i].get("label", f"test_{i}")
            detail_lines.append(f"{label}: {detail}")
    detail = f"{ranking_passed}/{ranking_total} golden tests passed"
    if detail_lines:
        detail += " — " + "; ".join(detail_lines)

    add_check(
        "ranking_eval_gate",
        ranking_passed == ranking_total,
        detail,
        ranking_delta_ms,
    )

    # chat SSE streaming gate
    gate_elapsed_ms = 0.0
    try:
        chat_payload = {
            "conversation_id": "eval-conv-001",
            "message": "I need a confirmation gift from Italy",
            "context": [],
            "occasion": "confirmation",
        }
        status, body, elapsed = _fetch(
            f"{base_url}/api/v1/chat/send",
            method="POST",
            payload=chat_payload,
            timeout=60,
        )
        gate_elapsed_ms += elapsed * 1000
        _assert(status == 200, f"chat SSE expected 200 got {status}")

        # Parse SSE stream — should have text and product_cards or done events
        has_text = "data:" in body
        has_done = '"type":"done"' in body or '"type": "done"' in body
        _assert(has_text, "chat SSE missing data events")
        _assert(has_done, "chat SSE missing done event")

        add_check("chat_sse_gate", True, f"SSE stream valid ({len(body)} bytes)", gate_elapsed_ms)
    except AssertionError as exc:
        add_check("chat_sse_gate", False, str(exc), gate_elapsed_ms)
    except Exception as exc:
        add_check("chat_sse_gate", False, str(exc), gate_elapsed_ms)

    # social generation gate
    status, body, elapsed = _fetch(
        f"{base_url}/api/v1/social/generate",
        method="POST",
        payload={"product_id": sample_product_id, "platform": "instagram", "tone": "reverent"},
    )
    try:
        payload = json.loads(body or "{}")
    except Exception:
        payload = {}
    try:
        _assert(status == 200, f"expected 200 got {status}")
        _assert(bool(payload.get("caption_short")), "caption_short missing")
        _assert(isinstance(payload.get("hashtags"), list), "hashtags missing")
        add_check("social_gate", True, "social draft payload valid", elapsed * 1000)
    except AssertionError as exc:
        add_check("social_gate", False, str(exc), elapsed * 1000)

    # mobile html gate
    status, body, elapsed = _fetch(f"{base_url}/")
    try:
        _assert(status == 200, f"expected 200 got {status}")
        _assert('name="viewport"' in body, "missing viewport meta")
        _assert('class="bottom"' in body, "missing bottom nav scaffold")
        add_check("mobile_html_gate", True, "viewport and bottom nav present", elapsed * 1000)
    except AssertionError as exc:
        add_check("mobile_html_gate", False, str(exc), elapsed * 1000)

    # auth + saved items gate
    gate_elapsed_ms = 0.0
    try:
        status, body, elapsed = _fetch(
            f"{base_url}/api/v1/auth/guest-session",
            method="POST",
            payload={"display_name": "EvalUser"},
        )
        gate_elapsed_ms += elapsed * 1000
        _assert(status == 200, f"auth expected 200 got {status}")
        auth_payload = json.loads(body or "{}")
        user_id = str(((auth_payload.get("user") or {}).get("user_id") or "")).strip()
        _assert(bool(user_id), "auth response missing user_id")

        status, _, elapsed = _fetch(
            f"{base_url}/api/v1/users/{user_id}/saved/{sample_product_id}",
            method="POST",
        )
        gate_elapsed_ms += elapsed * 1000
        _assert(status == 200, f"save expected 200 got {status}")

        status, body, elapsed = _fetch(f"{base_url}/api/v1/users/{user_id}/saved")
        gate_elapsed_ms += elapsed * 1000
        _assert(status == 200, f"saved-list expected 200 got {status}")
        saved_payload = json.loads(body or "{}")
        saved_items = saved_payload.get("items") or []
        _assert(any(str(item.get("product_id") or "") == sample_product_id for item in saved_items), "saved list missing saved product")

        status, _, elapsed = _fetch(
            f"{base_url}/api/v1/users/{user_id}/saved/{sample_product_id}",
            method="DELETE",
        )
        gate_elapsed_ms += elapsed * 1000
        _assert(status == 200, f"unsave expected 200 got {status}")

        add_check("auth_saved_gate", True, "guest auth and save/unsave flow valid", gate_elapsed_ms)
    except Exception as exc:
        add_check("auth_saved_gate", False, str(exc), gate_elapsed_ms)

    # cart + checkout intent gate (dry-run)
    gate_elapsed_ms = 0.0
    try:
        status, body, elapsed = _fetch(
            f"{base_url}/api/v1/carts",
            method="POST",
            payload={},
        )
        gate_elapsed_ms += elapsed * 1000
        _assert(status == 200, f"cart-create expected 200 got {status}")
        cart_payload = json.loads(body or "{}")
        cart_id = str(((cart_payload.get("cart") or {}).get("cart_id") or "")).strip()
        _assert(bool(cart_id), "cart-create missing cart_id")

        status, body, elapsed = _fetch(
            f"{base_url}/api/v1/carts/{cart_id}/items",
            method="POST",
            payload={"product_id": sample_product_id, "quantity": 2},
        )
        gate_elapsed_ms += elapsed * 1000
        _assert(status == 200, f"cart-add expected 200 got {status}")

        status, body, elapsed = _fetch(
            f"{base_url}/api/v1/carts/{cart_id}/items/{sample_product_id}",
            method="PUT",
            payload={"quantity": 1},
        )
        gate_elapsed_ms += elapsed * 1000
        _assert(status == 200, f"cart-update expected 200 got {status}")
        cart_after_update = json.loads(body or "{}")
        updated_qty = int((((cart_after_update.get("cart") or {}).get("items") or [{}])[0] or {}).get("quantity") or 0)
        _assert(updated_qty == 1, f"expected cart qty=1 got {updated_qty}")

        intent_payload = {
            "cart_id": cart_id,
            "idempotency_key": "eval-cart-intent-1",
            "dry_run": True,
            "success_url": f"{base_url}/?checkout=success",
            "cancel_url": f"{base_url}/?checkout=cancel",
        }
        status, body, elapsed = _fetch(
            f"{base_url}/api/v1/checkout/intents",
            method="POST",
            payload=intent_payload,
        )
        gate_elapsed_ms += elapsed * 1000
        _assert(status == 200, f"checkout-intent expected 200 got {status}")
        intent_first = json.loads(body or "{}")
        intent_id_1 = str(intent_first.get("intent_id") or "").strip()
        _assert(bool(intent_id_1), "checkout-intent response missing intent_id")
        _assert(bool(str(intent_first.get("checkout_url") or "").strip()), "checkout-intent response missing checkout_url")

        status, body, elapsed = _fetch(
            f"{base_url}/api/v1/checkout/intents",
            method="POST",
            payload=intent_payload,
        )
        gate_elapsed_ms += elapsed * 1000
        _assert(status == 200, f"checkout-intent replay expected 200 got {status}")
        intent_replay = json.loads(body or "{}")
        _assert(bool(intent_replay.get("reused")), "checkout-intent idempotent replay did not reuse")
        intent_id_2 = str(intent_replay.get("intent_id") or "").strip()
        _assert(intent_id_1 == intent_id_2, "checkout-intent replay returned different intent_id")

        add_check("cart_checkout_intent_gate", True, "cart add/update + checkout intent idempotency valid", gate_elapsed_ms)
    except Exception as exc:
        add_check("cart_checkout_intent_gate", False, str(exc), gate_elapsed_ms)

    # checkout + order ops gate (dry-run)
    gate_elapsed_ms = 0.0
    try:
        status, body, elapsed = _fetch(
            f"{base_url}/api/v1/checkout/buy-now",
            method="POST",
            payload={
                "product_id": sample_product_id,
                "quantity": 1,
                "dry_run": True,
                "success_url": f"{base_url}/?checkout=success",
                "cancel_url": f"{base_url}/?checkout=cancel",
            },
        )
        gate_elapsed_ms += elapsed * 1000
        _assert(status == 200, f"buy-now expected 200 got {status}")
        buy_payload = json.loads(body or "{}")
        order_id = str(buy_payload.get("order_id") or "").strip()
        _assert(bool(order_id), "buy-now response missing order_id")
        _assert(bool(str(buy_payload.get("checkout_url") or "").strip()), "buy-now response missing checkout_url")

        status, body, elapsed = _fetch(f"{base_url}/api/v1/orders/{order_id}")
        gate_elapsed_ms += elapsed * 1000
        _assert(status == 200, f"order-get expected 200 got {status}")

        status, body, elapsed = _fetch(
            f"{base_url}/api/v1/orders/{order_id}/dispatch-note",
            method="POST",
            payload={"note": "Eval dispatch note", "actor": "eval"},
        )
        gate_elapsed_ms += elapsed * 1000
        _assert(status == 200, f"dispatch-note expected 200 got {status}")

        status, body, elapsed = _fetch(
            f"{base_url}/api/v1/orders/{order_id}/status",
            method="POST",
            payload={"status": "paid", "note": "Eval paid transition", "actor": "eval"},
        )
        gate_elapsed_ms += elapsed * 1000
        _assert(status == 200, f"order-status expected 200 got {status}")
        update_payload = json.loads(body or "{}")
        updated_status = str(((update_payload.get("order") or {}).get("status") or "")).strip().lower()
        _assert(updated_status == "paid", f"expected paid status got {updated_status}")

        add_check("checkout_order_ops_gate", True, "dry-run checkout + order ops valid", gate_elapsed_ms)
    except Exception as exc:
        add_check("checkout_order_ops_gate", False, str(exc), gate_elapsed_ms)

    passed = all(c["passed"] for c in checks)

    # analytics gate
    gate_elapsed_ms = 0.0
    try:
        status, body, elapsed = _fetch(
            f"{base_url}/api/v1/analytics/events",
            method="POST",
            payload={
                "event_type": "eval_test",
                "source": "eval",
                "payload": {"test_key": "test_value", "product_id": sample_product_id},
            },
        )
        gate_elapsed_ms += elapsed * 1000
        _assert(status == 200, f"analytics post expected 200 got {status}")
        event_payload = json.loads(body or "{}")
        event_id = str(event_payload.get("event_id") or "")
        _assert(bool(event_id), "analytics post response missing event_id")

        status, body, elapsed = _fetch(f"{base_url}/api/v1/analytics/summary")
        gate_elapsed_ms += elapsed * 1000
        _assert(status == 200, f"analytics summary expected 200 got {status}")
        summary_payload = json.loads(body or "{}")
        total = int(summary_payload.get("total_events") or 0)
        _assert(total >= 1, f"expected >=1 events got {total}")
        type_counts = summary_payload.get("event_type_counts") or {}
        _assert("eval_test" in type_counts, "eval_test event type not found in summary")
        _assert(int(type_counts.get("eval_test") or 0) >= 1, "eval_test count should be >=1")

        add_check("analytics_gate", True, f"post + summary valid (total: {total}, event_id: {event_id})", gate_elapsed_ms)
    except Exception as exc:
        add_check("analytics_gate", False, str(exc), gate_elapsed_ms)

    passed = all(c["passed"] for c in checks)
    p95_ms = sorted(c["elapsed_ms"] for c in checks)[max(0, int(len(checks) * 0.95) - 1)]

    return {
        "base_url": base_url,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "passed": passed,
        "checks": checks,
        "summary": {
            "total": len(checks),
            "passed": sum(1 for c in checks if c["passed"]),
            "failed": sum(1 for c in checks if not c["passed"]),
            "p95_ms": round(p95_ms, 2),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Catholic Market eval harness")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--summary-md", default="artifacts/eval-summary.md")
    parser.add_argument("--summary-json", default="artifacts/eval-summary.json")
    args = parser.parse_args()

    result = run(args.base_url.rstrip("/"))

    out_json = ROOT / args.summary_json
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")

    lines = [
        "# Catholic Market Eval Summary",
        "",
        f"- generated_at: `{result['generated_at']}`",
        f"- base_url: `{result['base_url']}`",
        f"- pass: **{'YES' if result['passed'] else 'NO'}**",
        f"- checks: `{result['summary']['passed']}/{result['summary']['total']}`",
        f"- failed: `{result['summary']['failed']}`",
        f"- p95_ms: `{result['summary']['p95_ms']}`",
        "",
        "## Check results",
        "",
    ]
    for check in result["checks"]:
        badge = "PASS" if check["passed"] else "FAIL"
        lines.append(f"- [{badge}] `{check['name']}` ({check['elapsed_ms']} ms) — {check['detail']}")

    out_md = ROOT / args.summary_md
    out_md.parent.mkdir(parents=True, exist_ok=True)
    out_md.write_text("\n".join(lines) + "\n", encoding="utf-8")

    print(json.dumps({"ok": True, "passed": result["passed"], "summary_json": str(out_json)}, indent=2))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
