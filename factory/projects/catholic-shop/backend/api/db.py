"""
SQLite database module for Catholic Shop.
Replaces JSON file stores with a single SQLite database.
WAL mode, foreign keys enforced, connection per request.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

ROOT = Path(__file__).resolve().parents[2]
DB_PATH = ROOT / "data" / "catholic_shop.db"

_local = threading.local()


def _get_conn() -> sqlite3.Connection:
    """Get a thread-local connection. Creates if needed."""
    if not hasattr(_local, "conn") or _local.conn is None:
        _local.conn = _create_connection()
    return _local.conn


def _create_connection() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    """Create tables if they don't exist. Idempotent."""
    conn = _get_conn()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS shops (
            shop_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            country TEXT NOT NULL DEFAULT '',
            city TEXT NOT NULL DEFAULT '',
            website_url TEXT DEFAULT '',
            whatsapp TEXT DEFAULT '',
            description TEXT DEFAULT '',
            story TEXT DEFAULT '',
            image_url TEXT DEFAULT '',
            logo_url TEXT DEFAULT '',
            lead_time_days INTEGER,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS products (
            product_id TEXT PRIMARY KEY,
            shop_id TEXT NOT NULL REFERENCES shops(shop_id),
            sku TEXT DEFAULT '',
            title TEXT NOT NULL,
            description TEXT DEFAULT '',
            story TEXT DEFAULT '',
            price_cents INTEGER NOT NULL DEFAULT 0,
            currency TEXT NOT NULL DEFAULT 'USD',
            city TEXT DEFAULT '',
            country TEXT DEFAULT '',
            materials TEXT DEFAULT '[]',
            sacrament_tags TEXT DEFAULT '[]',
            inventory_status TEXT NOT NULL DEFAULT 'in_stock',
            quantity_on_hand INTEGER DEFAULT 0,
            lead_time_days INTEGER,
            image_url TEXT DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS users (
            user_id TEXT PRIMARY KEY,
            email TEXT DEFAULT '',
            display_name TEXT DEFAULT '',
            role TEXT NOT NULL DEFAULT 'shopper',
            password_hash TEXT DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS carts (
            cart_id TEXT PRIMARY KEY,
            user_id TEXT REFERENCES users(user_id),
            status TEXT NOT NULL DEFAULT 'active',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS cart_items (
            cart_id TEXT NOT NULL REFERENCES carts(cart_id) ON DELETE CASCADE,
            product_id TEXT NOT NULL REFERENCES products(product_id),
            quantity INTEGER NOT NULL DEFAULT 1,
            added_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (cart_id, product_id)
        );

        CREATE TABLE IF NOT EXISTS orders (
            order_id TEXT PRIMARY KEY,
            user_id TEXT REFERENCES users(user_id),
            cart_id TEXT DEFAULT '',
            order_kind TEXT DEFAULT '',
            idempotency_key TEXT DEFAULT '',
            customer_email TEXT DEFAULT '',
            status TEXT NOT NULL DEFAULT 'created',
            stripe_session_id TEXT DEFAULT '',
            checkout_url TEXT DEFAULT '',
            note TEXT DEFAULT '',
            dry_run INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS order_items (
            order_id TEXT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
            product_id TEXT NOT NULL REFERENCES products(product_id),
            quantity INTEGER NOT NULL DEFAULT 1,
            price_cents INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (order_id, product_id)
        );

        CREATE TABLE IF NOT EXISTS saved_items (
            user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
            product_id TEXT NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,
            saved_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (user_id, product_id)
        );

        CREATE TABLE IF NOT EXISTS conversations (
            conversation_id TEXT PRIMARY KEY,
            title TEXT DEFAULT '',
            occasion TEXT DEFAULT '',
            product_count INTEGER DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS messages (
            message_id INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
            role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
            content TEXT NOT NULL DEFAULT '',
            timestamp TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS checkout_intents (
            intent_id TEXT PRIMARY KEY,
            cart_id TEXT REFERENCES carts(cart_id),
            user_id TEXT REFERENCES users(user_id),
            customer_email TEXT DEFAULT '',
            success_url TEXT DEFAULT '',
            cancel_url TEXT DEFAULT '',
            note TEXT DEFAULT '',
            idempotency_key TEXT DEFAULT '',
            checkout_url TEXT DEFAULT '',
            dry_run INTEGER NOT NULL DEFAULT 0,
            reused INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS shop_leads (
            lead_id TEXT PRIMARY KEY,
            shop_name TEXT DEFAULT '',
            contact_name TEXT DEFAULT '',
            email TEXT DEFAULT '',
            country TEXT DEFAULT '',
            city TEXT DEFAULT '',
            website_url TEXT DEFAULT '',
            whatsapp TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            status TEXT NOT NULL DEFAULT 'new',
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_products_shop ON products(shop_id);
        CREATE INDEX IF NOT EXISTS idx_products_inventory ON products(inventory_status);
        CREATE INDEX IF NOT EXISTS idx_cart_items_cart ON cart_items(cart_id);
        CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
        CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
        CREATE INDEX IF NOT EXISTS idx_saved_items_user ON saved_items(user_id);
    """)

    # Analytics events table
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS analytics_events (
            event_id TEXT PRIMARY KEY,
            event_type TEXT NOT NULL DEFAULT '',
            session_id TEXT DEFAULT '',
            user_id TEXT DEFAULT '',
            path TEXT DEFAULT '',
            source TEXT DEFAULT 'backend',
            payload TEXT DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_analytics_type ON analytics_events(event_type);
    """)

    conn.commit()


# ═══ Shops ═══

def get_shops() -> List[Dict[str, Any]]:
    rows = _get_conn().execute("SELECT * FROM shops ORDER BY name").fetchall()
    return [dict(r) for r in rows]

def get_shop(shop_id: str) -> Optional[Dict[str, Any]]:
    row = _get_conn().execute("SELECT * FROM shops WHERE shop_id = ?", (shop_id,)).fetchone()
    return dict(row) if row else None

def upsert_shop(data: Dict[str, Any]) -> None:
    conn = _get_conn()
    conn.execute("""
        INSERT INTO shops (shop_id, name, country, city, website_url, whatsapp, description, story, image_url, logo_url, lead_time_days)
        VALUES (:shop_id, :name, :country, :city, :website_url, :whatsapp, :description, :story, :image_url, :logo_url, :lead_time_days)
        ON CONFLICT(shop_id) DO UPDATE SET
            name=excluded.name, country=excluded.country, city=excluded.city,
            website_url=excluded.website_url, whatsapp=excluded.whatsapp,
            description=excluded.description, story=excluded.story,
            image_url=excluded.image_url, logo_url=excluded.logo_url,
            lead_time_days=excluded.lead_time_days
    """, {
        "shop_id": data.get("shop_id", ""),
        "name": data.get("name", ""),
        "country": data.get("country", ""),
        "city": data.get("city", ""),
        "website_url": data.get("website_url", ""),
        "whatsapp": data.get("whatsapp", ""),
        "description": data.get("description", ""),
        "story": data.get("story", ""),
        "image_url": data.get("image_url", ""),
        "logo_url": data.get("logo_url", ""),
        "lead_time_days": data.get("lead_time_days"),
    })
    conn.commit()


# ═══ Products ═══

def get_products() -> List[Dict[str, Any]]:
    rows = _get_conn().execute("SELECT * FROM products ORDER BY title").fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["materials"] = json.loads(d.get("materials") or "[]")
        d["sacrament_tags"] = json.loads(d.get("sacrament_tags") or "[]")
        out.append(d)
    return out

def get_product(product_id: str) -> Optional[Dict[str, Any]]:
    row = _get_conn().execute("SELECT * FROM products WHERE product_id = ?", (product_id,)).fetchone()
    if not row:
        return None
    d = dict(row)
    d["materials"] = json.loads(d.get("materials") or "[]")
    d["sacrament_tags"] = json.loads(d.get("sacrament_tags") or "[]")
    return d

def get_products_with_shop() -> List[Dict[str, Any]]:
    rows = _get_conn().execute("""
        SELECT p.*, s.name as shop_name, s.country as shop_country, s.city as shop_city,
               s.website_url as shop_website, s.whatsapp as shop_whatsapp,
               s.description as shop_description, s.story as shop_story,
               s.image_url as shop_image_url, s.logo_url as shop_logo_url,
               s.lead_time_days as shop_lead_time_days
        FROM products p
        JOIN shops s ON p.shop_id = s.shop_id
        ORDER BY p.title
    """).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["materials"] = json.loads(d.get("materials") or "[]")
        d["sacrament_tags"] = json.loads(d.get("sacrament_tags") or "[]")
        d["shop"] = {
            "shop_id": d.get("shop_id"),
            "name": d.pop("shop_name", ""),
            "country": d.pop("shop_country", ""),
            "city": d.pop("shop_city", ""),
            "website_url": d.pop("shop_website", ""),
            "whatsapp": d.pop("shop_whatsapp", ""),
            "description": d.pop("shop_description", ""),
            "story": d.pop("shop_story", ""),
            "image_url": d.pop("shop_image_url", ""),
            "logo_url": d.pop("shop_logo_url", ""),
            "lead_time_days": d.pop("shop_lead_time_days", None),
        }
        out.append(d)
    return out

def upsert_product(data: Dict[str, Any]) -> None:
    conn = _get_conn()
    materials = json.dumps(data.get("materials") or [])
    sacrament_tags = json.dumps(data.get("sacrament_tags") or data.get("tags") or [])
    conn.execute("""
        INSERT INTO products (product_id, shop_id, sku, title, description, story, price_cents, currency,
                              city, country, materials, sacrament_tags, inventory_status,
                              quantity_on_hand, lead_time_days, image_url)
        VALUES (:product_id, :shop_id, :sku, :title, :description, :story, :price_cents, :currency,
                :city, :country, :materials, :sacrament_tags, :inventory_status,
                :quantity_on_hand, :lead_time_days, :image_url)
        ON CONFLICT(product_id) DO UPDATE SET
            shop_id=excluded.shop_id, sku=excluded.sku, title=excluded.title,
            description=excluded.description, story=excluded.story,
            price_cents=excluded.price_cents, currency=excluded.currency,
            city=excluded.city, country=excluded.country,
            materials=excluded.materials, sacrament_tags=excluded.sacrament_tags,
            inventory_status=excluded.inventory_status,
            quantity_on_hand=excluded.quantity_on_hand,
            lead_time_days=excluded.lead_time_days, image_url=excluded.image_url
    """, {
        "product_id": data.get("product_id", ""),
        "shop_id": data.get("shop_id", ""),
        "sku": data.get("sku", ""),
        "title": data.get("title", ""),
        "description": data.get("description", ""),
        "story": data.get("story", ""),
        "price_cents": data.get("price_cents", 0),
        "currency": data.get("currency", "USD"),
        "city": data.get("city", ""),
        "country": data.get("country", ""),
        "materials": materials,
        "sacrament_tags": sacrament_tags,
        "inventory_status": data.get("inventory_status", "in_stock"),
        "quantity_on_hand": data.get("quantity_on_hand", 0),
        "lead_time_days": data.get("lead_time_days"),
        "image_url": data.get("image_url", ""),
    })
    conn.commit()


# ═══ Users ═══

def get_users() -> Dict[str, Dict[str, Any]]:
    rows = _get_conn().execute("SELECT * FROM users").fetchall()
    return {r["user_id"]: dict(r) for r in rows}

def get_user(user_id: str) -> Optional[Dict[str, Any]]:
    row = _get_conn().execute("SELECT * FROM users WHERE user_id = ?", (user_id,)).fetchone()
    return dict(row) if row else None

def get_user_by_email(email: str) -> Optional[Dict[str, Any]]:
    row = _get_conn().execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    return dict(row) if row else None

def insert_user(data: Dict[str, Any]) -> None:
    conn = _get_conn()
    conn.execute("""
        INSERT INTO users (user_id, email, display_name, role, password_hash)
        VALUES (:user_id, :email, :display_name, :role, :password_hash)
    """, {
        "user_id": data.get("user_id", data.get("id", "")),
        "email": data.get("email", ""),
        "display_name": data.get("display_name", data.get("name", "")),
        "role": data.get("role", "shopper"),
        "password_hash": data.get("password_hash", data.get("password", "")),
    })
    conn.commit()


# ═══ Carts ═══

def get_carts() -> Dict[str, Dict[str, Any]]:
    conn = _get_conn()
    carts = {}
    cart_rows = conn.execute("SELECT * FROM carts ORDER BY created_at DESC").fetchall()
    for cr in cart_rows:
        c = dict(cr)
        items = conn.execute(
            "SELECT product_id, quantity FROM cart_items WHERE cart_id = ?", (c["cart_id"],)
        ).fetchall()
        c["items"] = [dict(i) for i in items]
        carts[c["cart_id"]] = c
    return carts

def get_cart(cart_id: str) -> Optional[Dict[str, Any]]:
    conn = _get_conn()
    row = conn.execute("SELECT * FROM carts WHERE cart_id = ?", (cart_id,)).fetchone()
    if not row:
        return None
    c = dict(row)
    items = conn.execute(
        "SELECT product_id, quantity FROM cart_items WHERE cart_id = ?", (cart_id,)
    ).fetchall()
    c["items"] = [dict(i) for i in items]
    return c

def insert_cart(data: Dict[str, Any]) -> None:
    conn = _get_conn()
    now = _utc_now_iso()
    conn.execute("""
        INSERT INTO carts (cart_id, user_id, status, created_at, updated_at)
        VALUES (:cart_id, :user_id, :status, :created_at, :updated_at)
    """, {
        "cart_id": data.get("cart_id", ""),
        "user_id": data.get("user_id"),
        "status": data.get("status", "active"),
        "created_at": data.get("created_at", now),
        "updated_at": data.get("updated_at", now),
    })
    conn.commit()

def upsert_cart_item(cart_id: str, product_id: str, quantity: int) -> None:
    conn = _get_conn()
    conn.execute("""
        INSERT INTO cart_items (cart_id, product_id, quantity)
        VALUES (?, ?, ?)
        ON CONFLICT(cart_id, product_id) DO UPDATE SET quantity=excluded.quantity
    """, (cart_id, product_id, quantity))
    conn.execute("UPDATE carts SET updated_at = ? WHERE cart_id = ?", (_utc_now_iso(), cart_id))
    conn.commit()

def delete_cart_item(cart_id: str, product_id: str) -> None:
    conn = _get_conn()
    conn.execute("DELETE FROM cart_items WHERE cart_id = ? AND product_id = ?", (cart_id, product_id))
    conn.execute("UPDATE carts SET updated_at = ? WHERE cart_id = ?", (_utc_now_iso(), cart_id))
    conn.commit()


# ═══ Orders ═══

def get_orders() -> Dict[str, Dict[str, Any]]:
    conn = _get_conn()
    orders = {}
    rows = conn.execute("SELECT * FROM orders ORDER BY created_at DESC").fetchall()
    for r in rows:
        o = dict(r)
        o["dry_run"] = bool(o.get("dry_run"))
        items = conn.execute(
            "SELECT product_id, quantity, price_cents FROM order_items WHERE order_id = ?",
            (o["order_id"],)
        ).fetchall()
        o["items"] = [dict(i) for i in items]
        orders[o["order_id"]] = o
    return orders

def get_order(order_id: str) -> Optional[Dict[str, Any]]:
    conn = _get_conn()
    row = conn.execute("SELECT * FROM orders WHERE order_id = ?", (order_id,)).fetchone()
    if not row:
        return None
    o = dict(row)
    o["dry_run"] = bool(o.get("dry_run"))
    items = conn.execute(
        "SELECT product_id, quantity, price_cents FROM order_items WHERE order_id = ?",
        (order_id,)
    ).fetchall()
    o["items"] = [dict(i) for i in items]
    return o

def insert_order(data: Dict[str, Any]) -> None:
    conn = _get_conn()
    now = _utc_now_iso()
    conn.execute("""
        INSERT INTO orders (order_id, user_id, cart_id, order_kind, idempotency_key, customer_email,
                            status, stripe_session_id, checkout_url, note, dry_run, created_at, updated_at)
        VALUES (:order_id, :user_id, :cart_id, :order_kind, :idempotency_key, :customer_email,
                :status, :stripe_session_id, :checkout_url, :note, :dry_run, :created_at, :updated_at)
    """, {
        "order_id": data.get("order_id", data.get("intent_id", "")),
        "user_id": data.get("user_id"),
        "cart_id": data.get("cart_id", ""),
        "order_kind": data.get("order_kind", ""),
        "idempotency_key": data.get("idempotency_key", ""),
        "customer_email": data.get("customer_email", ""),
        "status": data.get("status", "created"),
        "stripe_session_id": data.get("stripe_session_id", ""),
        "checkout_url": data.get("checkout_url", ""),
        "note": data.get("note", ""),
        "dry_run": 1 if data.get("dry_run") else 0,
        "created_at": data.get("created_at", now),
        "updated_at": data.get("updated_at", now),
    })
    conn.commit()

def insert_order_item(order_id: str, product_id: str, quantity: int, price_cents: int) -> None:
    _get_conn().execute("""
        INSERT INTO order_items (order_id, product_id, quantity, price_cents)
        VALUES (?, ?, ?, ?)
    """, (order_id, product_id, quantity, price_cents))
    _get_conn().commit()

def update_order_status(order_id: str, status: str, note: str = "") -> None:
    conn = _get_conn()
    now = _utc_now_iso()
    if note:
        conn.execute(
            "UPDATE orders SET status = ?, note = ?, updated_at = ? WHERE order_id = ?",
            (status, note, now, order_id)
        )
    else:
        conn.execute(
            "UPDATE orders SET status = ?, updated_at = ? WHERE order_id = ?",
            (status, now, order_id)
        )
    conn.commit()

def update_order_note(order_id: str, note: str) -> None:
    conn = _get_conn()
    conn.execute(
        "UPDATE orders SET note = ?, updated_at = ? WHERE order_id = ?",
        (note, _utc_now_iso(), order_id)
    )
    conn.commit()


# ═══ Saved Items ═══

def get_saved_items() -> Dict[str, List[str]]:
    conn = _get_conn()
    rows = conn.execute("SELECT user_id, product_id FROM saved_items ORDER BY saved_at").fetchall()
    out: Dict[str, List[str]] = {}
    for r in rows:
        uid = r["user_id"]
        if uid not in out:
            out[uid] = []
        out[uid].append(r["product_id"])
    return out

def save_item(user_id: str, product_id: str) -> None:
    conn = _get_conn()
    conn.execute("""
        INSERT OR IGNORE INTO saved_items (user_id, product_id) VALUES (?, ?)
    """, (user_id, product_id))
    conn.commit()

def unsave_item(user_id: str, product_id: str) -> None:
    conn = _get_conn()
    conn.execute("DELETE FROM saved_items WHERE user_id = ? AND product_id = ?", (user_id, product_id))
    conn.commit()


# ═══ Conversations ═══

def get_conversations() -> Dict[str, Dict[str, Any]]:
    conn = _get_conn()
    convs = {}
    rows = conn.execute("SELECT * FROM conversations ORDER BY updated_at DESC").fetchall()
    for r in rows:
        c = dict(r)
        msgs = conn.execute(
            "SELECT role, content, timestamp FROM messages WHERE conversation_id = ? ORDER BY message_id",
            (c["conversation_id"],)
        ).fetchall()
        c["messages"] = [dict(m) for m in msgs]
        convs[c["conversation_id"]] = c
    return convs

def get_conversation(conversation_id: str) -> Optional[Dict[str, Any]]:
    conn = _get_conn()
    row = conn.execute("SELECT * FROM conversations WHERE conversation_id = ?", (conversation_id,)).fetchone()
    if not row:
        return None
    c = dict(row)
    msgs = conn.execute(
        "SELECT role, content, timestamp FROM messages WHERE conversation_id = ? ORDER BY message_id",
        (conversation_id,)
    ).fetchall()
    c["messages"] = [dict(m) for m in msgs]
    return c

def upsert_conversation(conv_id: str, title: str, occasion: str = "") -> None:
    conn = _get_conn()
    now = _utc_now_iso()
    conn.execute("""
        INSERT INTO conversations (conversation_id, title, occasion, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(conversation_id) DO UPDATE SET
            title=excluded.title, occasion=excluded.occasion, updated_at=excluded.updated_at
    """, (conv_id, title, occasion, now, now))
    conn.commit()

def insert_message(conversation_id: str, role: str, content: str, timestamp: str = "") -> None:
    conn = _get_conn()
    ts = timestamp or _utc_now_iso()
    conn.execute("""
        INSERT INTO messages (conversation_id, role, content, timestamp) VALUES (?, ?, ?, ?)
    """, (conversation_id, role, content, ts))
    conn.execute("UPDATE conversations SET updated_at = ? WHERE conversation_id = ?", (ts, conversation_id))
    conn.commit()


# ═══ Checkout Intents ═══

def get_checkout_intent_by_key(idempotency_key: str) -> Optional[Dict[str, Any]]:
    row = _get_conn().execute(
        "SELECT * FROM checkout_intents WHERE idempotency_key = ?", (idempotency_key,)
    ).fetchone()
    if not row:
        return None
    d = dict(row)
    d["dry_run"] = bool(d.get("dry_run"))
    d["reused"] = bool(d.get("reused"))
    return d

def get_checkout_intent(intent_id: str) -> Optional[Dict[str, Any]]:
    row = _get_conn().execute(
        "SELECT * FROM checkout_intents WHERE intent_id = ?", (intent_id,)
    ).fetchone()
    if not row:
        return None
    d = dict(row)
    d["dry_run"] = bool(d.get("dry_run"))
    d["reused"] = bool(d.get("reused"))
    return d

def insert_checkout_intent(data: Dict[str, Any]) -> None:
    conn = _get_conn()
    conn.execute("""
        INSERT INTO checkout_intents (intent_id, cart_id, user_id, customer_email,
                                      success_url, cancel_url, note, idempotency_key,
                                      checkout_url, dry_run, reused)
        VALUES (:intent_id, :cart_id, :user_id, :customer_email,
                :success_url, :cancel_url, :note, :idempotency_key,
                :checkout_url, :dry_run, :reused)
    """, {
        "intent_id": data.get("intent_id", ""),
        "cart_id": data.get("cart_id"),
        "user_id": data.get("user_id"),
        "customer_email": data.get("customer_email", ""),
        "success_url": data.get("success_url", ""),
        "cancel_url": data.get("cancel_url", ""),
        "note": data.get("note", ""),
        "idempotency_key": data.get("idempotency_key", ""),
        "checkout_url": data.get("checkout_url", ""),
        "dry_run": 1 if data.get("dry_run") else 0,
        "reused": 1 if data.get("reused") else 0,
    })
    conn.commit()


# ═══ Shop Leads ═══

def get_shop_leads() -> Dict[str, Dict[str, Any]]:
    rows = _get_conn().execute("SELECT * FROM shop_leads ORDER BY created_at DESC").fetchall()
    return {r["lead_id"]: dict(r) for r in rows}

def insert_shop_lead(data: Dict[str, Any]) -> None:
    conn = _get_conn()
    conn.execute("""
        INSERT INTO shop_leads (lead_id, shop_name, contact_name, email, country, city,
                                website_url, whatsapp, notes, status)
        VALUES (:lead_id, :shop_name, :contact_name, :email, :country, :city,
                :website_url, :whatsapp, :notes, :status)
    """, {
        "lead_id": data.get("lead_id", f"lead_{uuid.uuid4().hex[:12]}"),
        "shop_name": data.get("shop_name", ""),
        "contact_name": data.get("contact_name", ""),
        "email": data.get("email", ""),
        "country": data.get("country", ""),
        "city": data.get("city", ""),
        "website_url": data.get("website_url", ""),
        "whatsapp": data.get("whatsapp", ""),
        "notes": data.get("notes", ""),
        "status": data.get("status", "new"),
    })
    conn.commit()


def insert_analytics_event(data: Dict[str, Any]) -> None:
    conn = _get_conn()
    conn.execute("""
        INSERT INTO analytics_events (event_id, event_type, session_id, user_id, path, source, payload)
        VALUES (:event_id, :event_type, :session_id, :user_id, :path, :source, :payload)
    """, {
        "event_id": data.get("event_id", ""),
        "event_type": data.get("event_type", ""),
        "session_id": data.get("session_id", ""),
        "user_id": data.get("user_id", ""),
        "path": data.get("path", ""),
        "source": data.get("source", "backend"),
        "payload": json.dumps(data.get("payload") or {}),
    })
    conn.commit()


# ═══ Helpers ═══

def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
