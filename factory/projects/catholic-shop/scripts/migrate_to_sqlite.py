#!/usr/bin/env python3
"""
One-shot migration: populate SQLite from existing JSON files.
Run once, then app.py can switch to SQLite.
Idempotent — skips if data already exists.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Dict, List

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.api.db import (
    init_db, upsert_shop, upsert_product, insert_user, insert_cart,
    upsert_cart_item, insert_order, insert_order_item, upsert_conversation,
    insert_message, insert_checkout_intent, insert_shop_lead,
    insert_analytics_event, get_shops, get_products,
)

DATA = ROOT / "data" / "processed"


def _read_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def migrate_shops() -> int:
    shops = _read_json(DATA / "shops.json", [])
    if not shops:
        return 0
    count = 0
    for s in shops:
        if not isinstance(s, dict):
            continue
        sid = str(s.get("shop_id") or "").strip()
        if not sid:
            continue
        upsert_shop(s)
        count += 1
    return count


def migrate_products() -> int:
    products = _read_json(DATA / "products.json", [])
    if not products:
        return 0
    count = 0
    for p in products:
        if not isinstance(p, dict):
            continue
        pid = str(p.get("product_id") or "").strip()
        if not pid:
            continue
        upsert_product(p)
        count += 1
    return count


def migrate_users() -> int:
    users = _read_json(DATA / "users.json", {})
    if not users:
        return 0
    count = 0
    for uid, u in users.items():
        if not isinstance(u, dict):
            continue
        insert_user(u)
        count += 1
    return count


def migrate_carts() -> int:
    carts = _read_json(DATA / "carts.json", {})
    if not carts:
        return 0
    count = 0
    for cid, c in carts.items():
        if not isinstance(c, dict):
            continue
        insert_cart(c)
        for item in c.get("items") or []:
            pid = str(item.get("product_id") or "").strip()
            qty = int(item.get("quantity") or 0)
            if pid and qty > 0:
                upsert_cart_item(cid, pid, qty)
        count += 1
    return count


def migrate_orders() -> int:
    orders = _read_json(DATA / "orders.json", {})
    if not orders:
        return 0
    count = 0
    for oid, o in orders.items():
        if not isinstance(o, dict):
            continue
        insert_order(o)
        for item in o.get("items") or []:
            pid = str(item.get("product_id") or "").strip()
            qty = int(item.get("quantity") or 0)
            price = int(item.get("price_cents") or 0)
            if pid and qty > 0:
                insert_order_item(oid, pid, qty, price)
        # Also handle legacy single-product orders
        pid = str(o.get("product_id") or "").strip()
        if pid and not o.get("items"):
            qty = int(o.get("quantity") or 1)
            price = int(o.get("price_cents") or 0)
            insert_order_item(oid, pid, qty, price)
        count += 1
    return count


def migrate_saved_items() -> int:
    saved = _read_json(DATA / "saved_items.json", {})
    if not saved:
        return 0
    count = 0
    from backend.api.db import save_item
    for uid, items in saved.items():
        if not isinstance(items, list):
            continue
        for pid in items:
            pid_str = str(pid or "").strip()
            if pid_str:
                save_item(uid, pid_str)
                count += 1
    return count


def migrate_conversations() -> int:
    convs = _read_json(DATA / "chat_conversations.json", {})
    if not convs:
        return 0
    count = 0
    for cid, c in convs.items():
        if not isinstance(c, dict):
            continue
        title = str(c.get("title") or c.get("id") or "")[:200]
        occasion = str(c.get("occasion") or "")
        upsert_conversation(cid, title, occasion)

        # Update the conversation timestamp to match
        from backend.api.db import _get_conn
        conn = _get_conn()
        created = str(c.get("created_at") or "")
        updated = str(c.get("updated_at") or "")
        if created:
            conn.execute("UPDATE conversations SET created_at = ? WHERE conversation_id = ?", (created, cid))
        if updated:
            conn.execute("UPDATE conversations SET updated_at = ? WHERE conversation_id = ?", (updated, cid))
        conn.commit()

        for msg in c.get("messages") or []:
            if not isinstance(msg, dict):
                continue
            role = str(msg.get("role") or "user")
            content = str(msg.get("content") or "")
            ts = str(msg.get("timestamp") or "")
            insert_message(cid, role, content, ts)
        count += 1
    return count


def migrate_chat_users() -> int:
    users = _read_json(DATA / "chat_users.json", {})
    if not users:
        return 0
    # Chat users may overlap with regular users. We insert only if new.
    from backend.api.db import get_user
    count = 0
    for uid, u in users.items():
        if not isinstance(u, dict):
            continue
        existing = get_user(uid)
        if existing:
            continue
        insert_user(u)
        count += 1
    return count


def migrate_shop_leads() -> int:
    leads = _read_json(DATA / "shop_onboarding_leads.json", {})
    if not leads:
        return 0
    count = 0
    for lid, lead in leads.items():
        if not isinstance(lead, dict):
            continue
        lead["lead_id"] = lid
        insert_shop_lead(lead)
        count += 1
    return count


def migrate_analytics() -> int:
    analytics_file = DATA / "analytics_events.jsonl"
    if not analytics_file.exists():
        return 0
    count = 0
    try:
        with open(analytics_file, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                    insert_analytics_event(event)
                    count += 1
                except Exception:
                    continue
    except Exception:
        pass
    return count


def main() -> int:
    print("[migrate] Initializing SQLite database...")
    init_db()

    # Check if already migrated
    existing_shops = get_shops()
    if existing_shops:
        print("[migrate] Data already exists in SQLite. Skipping migration.")
        print(f"  Shops: {len(existing_shops)}")
        print(f"  Products: {len(get_products())}")
        return 0

    print("[migrate] Migrating data from JSON to SQLite...")

    results = {
        "shops": migrate_shops(),
        "products": migrate_products(),
        "users": migrate_users(),
        "carts": migrate_carts(),
        "orders": migrate_orders(),
        "saved_items": migrate_saved_items(),
        "conversations": migrate_conversations(),
        "chat_users": migrate_chat_users(),
        "shop_leads": migrate_shop_leads(),
        "analytics": migrate_analytics(),
    }

    print("[migrate] Migration complete:")
    for key, count in results.items():
        print(f"  {key}: {count}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
