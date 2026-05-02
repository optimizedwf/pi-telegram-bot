from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

import hashlib
import hmac
import secrets

import jwt
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field

from backend.api.analytics_store import log_event, compute_summary
from backend.api import db

ROOT = Path(__file__).resolve().parents[2]
FRONTEND_INDEX = ROOT / "frontend/index.html"
OPS_INDEX = ROOT / "frontend/ops.html"
PRODUCT_PAGE = ROOT / "frontend/product.html"
SACRAMENTS_PAGE = ROOT / "frontend/sacraments.html"
SHOP_PAGE = ROOT / "frontend/shop.html"
CHAT_UI_DIST = ROOT / "chat-ui/dist"
CHAT_UI_INDEX = CHAT_UI_DIST / "index.html"

# Legacy JSON paths (kept for reference, no longer primary store)
SHOPS_JSON = ROOT / "data/processed/shops.json"
PRODUCTS_JSON = ROOT / "data/processed/products.json"
SHOP_LEADS_JSON = ROOT / "data/processed/shop_onboarding_leads.json"
USERS_JSON = ROOT / "data/processed/users.json"
SAVED_ITEMS_JSON = ROOT / "data/processed/saved_items.json"
ORDERS_JSON = ROOT / "data/processed/orders.json"
CARTS_JSON = ROOT / "data/processed/carts.json"
CONVERSATIONS_JSON = ROOT / "data/processed/chat_conversations.json"
CHAT_USERS_JSON = ROOT / "data/processed/chat_users.json"
JWT_SECRET = os.getenv("CHAT_JWT_SECRET", "catholic-marketplace-pilgrim-secret-2026")
STRIPE_API_BASE = "https://api.stripe.com/v1"
DEFAULT_CHECKOUT_SUCCESS_URL = "https://optimizedworkflow.dev/catholic-shop/?checkout=success"
DEFAULT_CHECKOUT_CANCEL_URL = "https://optimizedworkflow.dev/catholic-shop/?checkout=cancel"
ALLOWED_ORDER_STATUSES = {
    "checkout_created",
    "checkout_pending",
    "paid",
    "partner_notified",
    "fulfilled",
    "cancelled",
}

from fastapi.staticfiles import StaticFiles

app = FastAPI(title="Catholic Market API", version="0.1.0")

# Mount frontend static assets (images, CSS, JS)
_STATIC_DIR = ROOT / "frontend"
if _STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(_STATIC_DIR)), name="static")

# Mount chat-ui React SPA at /chat
if CHAT_UI_DIST.exists():
    app.mount("/chat/assets", StaticFiles(directory=str(CHAT_UI_DIST / "assets")), name="chat-assets")
    app.mount("/chat", StaticFiles(directory=str(CHAT_UI_DIST), html=True), name="chat-ui")


# ═══ PI Concierge helpers ═══

PI_CONCIERGE_URL = os.getenv("PI_CONCIERGE_URL", "http://127.0.0.1:8112")


def _compact_catalog(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Strip products to essential fields for the PI prompt."""
    def _detect_destination(row: dict) -> str:
        city = (row.get("city") or "").lower()
        if "lourdes" in city: return "Lourdes"
        if "krak" in city: return "Kraków"
        if "fatima" in city or "fátima" in city: return "Fátima"
        if "guadalupe" in city or "guadalajara" in city: return "Guadalupe"
        if "jerusalem" in city: return "Jerusalem"
        return "Assisi"

    return [
        {
            "product_id": row.get("product_id"),
            "title": row.get("title"),
            "price_cents": row.get("price_cents"),
            "city": row.get("city"),
            "country": row.get("country"),
            "story": row.get("story"),
            "sacrament_tags": row.get("sacrament_tags") or [],
            "materials": row.get("materials") or [],
            "inventory_status": row.get("inventory_status"),
            "lead_time_days": row.get("lead_time_days"),
            "image_url": row.get("image_url") or "",
            "buy_url": row.get("buy_url") or "",
            "shop": row.get("shop") or {},
            "shop_id": row.get("shop_id"),
            "destination": _detect_destination(row),
        }
        for row in rows
    ]


def _call_pi_concierge(catalog: List[Dict[str, Any]], payload: AIRecommendPayload) -> Dict[str, Any] | None:
    """Call the PI-powered concierge sidecar. Returns parsed result or None on failure."""
    body = json.dumps({
        "catalog": catalog,
        "intent": payload.intent or "",
        "budget_cents": int(max(0.0, payload.budget_usd) * 100) if payload.budget_usd is not None else None,
        "occasion": payload.occasion or "",
        "country": payload.country or "",
        "limit": payload.limit,
    }).encode("utf-8")

    rq = urllib.request.Request(
        PI_CONCIERGE_URL,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        # Keep storefront/eval responsive. If PI/cloud model is slow, fall back to deterministic ranking.
        with urllib.request.urlopen(rq, timeout=8) as resp:
            if resp.status == 200:
                return json.loads(resp.read().decode("utf-8"))
    except Exception:
        pass
    return None


def _detect_occasions(intent: str) -> set[str]:
    """Detect sacrament occasions from intent text."""
    found: set[str] = set()
    for phrase, canonical in _OCCASION_ALIASES.items():
        if phrase in intent:
            found.add(canonical)
    return found


# ═══ Keyword fallback (original logic preserved) ═══

def _keyword_recommend(payload: AIRecommendPayload, rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Original keyword-matching recommender. Used as fallback when PI is down."""
    context = _intent_context(payload, rows)

    ranked: List[Dict[str, Any]] = []
    for item in rows:
        score, reasons = _score_product(item, payload, context)
        if score <= -9:
            continue
        ranked.append({"score": round(score, 4), "reasons": reasons, "product": item})

    ranked.sort(key=lambda row: row["score"], reverse=True)
    top = [row for row in ranked if row["score"] > 0.05][: payload.limit]
    if not top:
        top = ranked[: payload.limit]

    summary = ""
    if top:
        first = top[0]["product"]
        summary = f"Top match: {first.get('title')} from {first.get('country')} at ${int(first.get('price_cents') or 0)/100:.2f}."

    return {
        "framework": "catholic-ai-concierge-v2-fallback",
        "intent": payload.intent,
        "summary": summary,
        "parsed_intent": {
            "tokens": context.get("tokens") or [],
            "requested_country": context.get("requested_country_slug") or None,
            "requested_city": context.get("requested_city_slug") or None,
            "requested_occasions": sorted(list(context.get("requested_occasions") or [])),
            "requested_categories": sorted(list(context.get("requested_categories") or [])),
            "budget_cents": context.get("budget_cents"),
        },
        "recommendations": top,
    }


class ShopOnboardingPayload(BaseModel):
    shop_name: str
    contact_name: str
    email: str
    country: str
    city: str
    website_url: str | None = None
    whatsapp: str | None = None
    notes: str | None = None


class AIRecommendPayload(BaseModel):
    intent: str
    budget_usd: float | None = None
    occasion: str | None = None
    country: str | None = None
    limit: int = Field(default=6, ge=1, le=30)


class SocialGeneratePayload(BaseModel):
    product_id: str | None = None
    custom_topic: str | None = None
    platform: str = "instagram"
    tone: str = "reverent"
    cta: str | None = None


class GuestSessionPayload(BaseModel):
    display_name: str | None = None


class BuyNowPayload(BaseModel):
    product_id: str
    user_id: str | None = None
    quantity: int = Field(default=1, ge=1, le=20)
    customer_email: str | None = None
    success_url: str | None = None
    cancel_url: str | None = None
    note: str | None = None
    dry_run: bool = False


class CartSessionPayload(BaseModel):
    user_id: str | None = None


class CartItemPayload(BaseModel):
    product_id: str
    quantity: int = Field(default=1, ge=1, le=20)


class CartItemUpdatePayload(BaseModel):
    quantity: int = Field(default=1, ge=0, le=20)


class CheckoutIntentPayload(BaseModel):
    cart_id: str
    user_id: str | None = None
    customer_email: str | None = None
    success_url: str | None = None
    cancel_url: str | None = None
    note: str | None = None
    idempotency_key: str | None = None
    dry_run: bool = False


class OrderStatusPayload(BaseModel):
    status: str
    note: str | None = None
    actor: str | None = None


class OrderDispatchNotePayload(BaseModel):
    note: str
    actor: str | None = None


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(value or "").lower()).strip("-") or "na"


def _json_read(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _json_write(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.parent / f".{path.name}.{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S%f')}.tmp"
    tmp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def _ensure_seed_data() -> None:
    """Initialize SQLite DB. Seed data is handled by migration script."""
    db.init_db()


def _user_store() -> Dict[str, Dict[str, Any]]:
    _ensure_seed_data()
    return db.get_users()


def _saved_store() -> Dict[str, List[str]]:
    _ensure_seed_data()
    return db.get_saved_items()


def _persist_user_store(payload: Dict[str, Dict[str, Any]]) -> None:
    """Full user store replacement — used for new users."""
    for uid, u in payload.items():
        if not isinstance(u, dict):
            continue
        existing = db.get_user(uid)
        if not existing:
            db.insert_user(u)


def _persist_saved_store(payload: Dict[str, List[str]]) -> None:
    """Full saved store replacement — used for batch updates."""
    existing = db.get_saved_items()
    for uid, items in payload.items():
        prev = set(existing.get(uid) or [])
        curr = set(items or [])
        for pid in curr - prev:
            db.save_item(uid, pid)
        for pid in prev - curr:
            db.unsave_item(uid, pid)


def _require_user(user_id: str) -> Dict[str, Any]:
    key = str(user_id or "").strip()
    if not key:
        raise HTTPException(status_code=400, detail="user_id is required")
    users = _user_store()
    user = users.get(key)
    if not user:
        raise HTTPException(status_code=404, detail=f"Unknown user_id {key}")
    return user


def _saved_products_for_user(user_id: str) -> List[Dict[str, Any]]:
    saved = _saved_store().get(str(user_id), [])
    products = {str(p.get("product_id") or ""): p for p in _products_with_shop()}
    out: List[Dict[str, Any]] = []
    for product_id in saved:
        item = products.get(product_id)
        if item:
            out.append(item)
    return out


def _orders_store() -> Dict[str, Dict[str, Any]]:
    _ensure_seed_data()
    return db.get_orders()


def _persist_orders_store(payload: Dict[str, Dict[str, Any]]) -> None:
    """Full orders store replacement. For new orders only — partial updates use specific db functions."""
    for oid, o in payload.items():
        if not isinstance(o, dict):
            continue
        existing = db.get_order(oid)
        if not existing:
            db.insert_order(o)
            for item in o.get("items") or []:
                pid = str(item.get("product_id") or "").strip()
                qty = int(item.get("quantity") or 0)
                price = int(item.get("price_cents") or 0)
                if pid and qty > 0:
                    db.insert_order_item(oid, pid, qty, price)
            # Legacy single-product orders
            pid = str(o.get("product_id") or "").strip()
            if pid and not o.get("items"):
                qty = int(o.get("quantity") or 1)
                db.insert_order_item(oid, pid, qty, 0)


def _cart_store() -> Dict[str, Dict[str, Any]]:
    _ensure_seed_data()
    return db.get_carts()


def _persist_cart_store(payload: Dict[str, Dict[str, Any]]) -> None:
    """Full cart store replacement. Handles new carts and updates."""
    for cid, c in payload.items():
        if not isinstance(c, dict):
            continue
        existing = db.get_cart(cid)
        if not existing:
            db.insert_cart(c)
        else:
            # Update timestamp for existing carts
            from backend.api.db import _get_conn
            conn = _get_conn()
            conn.execute("UPDATE carts SET updated_at = ? WHERE cart_id = ?",
                        (c.get("updated_at", _utc_now_iso()), cid))
            conn.commit()
        for item in c.get("items") or []:
            pid = str(item.get("product_id") or "").strip()
            qty = int(item.get("quantity") or 0)
            if pid and qty > 0:
                db.upsert_cart_item(cid, pid, qty)


def _cart_hydrate(cart: Dict[str, Any]) -> Dict[str, Any]:
    items_out: List[Dict[str, Any]] = []
    subtotal_cents = 0
    total_quantity = 0
    for row in list(cart.get("items") or []):
        product_id = str(row.get("product_id") or "").strip()
        quantity = int(max(0, int(row.get("quantity") or 0)))
        if not product_id or quantity <= 0:
            continue
        product = _find_product(product_id)
        if not product:
            continue
        inventory_status = str(product.get("inventory_status") or "").strip().lower()
        qty_on_hand = product.get("quantity_on_hand")
        if inventory_status == "out_of_stock":
            continue
        if qty_on_hand not in (None, ""):
            try:
                quantity = min(quantity, max(0, int(qty_on_hand)))
            except Exception:
                pass
        if quantity <= 0:
            continue
        unit_price_cents = int(product.get("price_cents") or 0)
        line_total_cents = unit_price_cents * quantity
        subtotal_cents += line_total_cents
        total_quantity += quantity
        items_out.append(
            {
                "product_id": str(product.get("product_id") or ""),
                "title": str(product.get("title") or "").strip(),
                "shop_id": str(product.get("shop_id") or "").strip() or None,
                "sku": str(product.get("sku") or "").strip() or None,
                "currency": str(product.get("currency") or "USD").strip() or "USD",
                "quantity": quantity,
                "unit_price_cents": unit_price_cents,
                "line_total_cents": line_total_cents,
                "inventory_status": str(product.get("inventory_status") or "").strip() or "in_stock",
                "lead_time_days": product.get("lead_time_days"),
                "product": product,
            }
        )

    hydrated = dict(cart)
    hydrated["items"] = items_out
    hydrated["total_quantity"] = total_quantity
    hydrated["subtotal_cents"] = subtotal_cents
    hydrated["currency"] = "USD"
    return hydrated


def _cart_get(cart_id: str) -> Dict[str, Any]:
    key = str(cart_id or "").strip()
    if not key:
        raise HTTPException(status_code=400, detail="cart_id is required")
    store = _cart_store()
    row = store.get(key)
    if not row:
        raise HTTPException(status_code=404, detail=f"Unknown cart_id {key}")
    return _cart_hydrate(row)


def _cart_set(cart_id: str, row: Dict[str, Any]) -> Dict[str, Any]:
    store = _cart_store()
    now = _utc_now_iso()
    row = dict(row)
    row["updated_at"] = now
    store[str(cart_id)] = row
    _persist_cart_store(store)
    return _cart_hydrate(row)


def _cart_set_product_quantity(cart_id: str, product_id: str, quantity: int) -> Dict[str, Any]:
    product_id = str(product_id or "").strip()
    if not product_id:
        raise HTTPException(status_code=400, detail="product_id is required")
    quantity = int(quantity)
    if quantity < 0:
        raise HTTPException(status_code=400, detail="quantity must be >= 0")

    cart = _cart_get(cart_id)
    product = _find_product(product_id)
    if not product:
        raise HTTPException(status_code=404, detail=f"Unknown product_id {product_id}")

    inventory_status = str(product.get("inventory_status") or "").strip().lower()
    if inventory_status == "out_of_stock":
        raise HTTPException(status_code=409, detail="Product is out_of_stock")

    qty_on_hand = product.get("quantity_on_hand")
    if qty_on_hand not in (None, "") and quantity > 0:
        try:
            on_hand = int(qty_on_hand)
            if quantity > on_hand:
                raise HTTPException(status_code=409, detail={"message": "Requested quantity exceeds quantity_on_hand", "quantity_on_hand": on_hand})
        except ValueError:
            pass

    items = [dict(v) for v in (cart.get("items") or []) if isinstance(v, dict)]
    next_items: List[Dict[str, Any]] = []
    matched = False
    for row in items:
        row_pid = str(row.get("product_id") or "").strip()
        if row_pid != product_id:
            if int(row.get("quantity") or 0) > 0:
                next_items.append({"product_id": row_pid, "quantity": int(row.get("quantity") or 0)})
            continue
        matched = True
        if quantity > 0:
            next_items.append({"product_id": product_id, "quantity": quantity})

    if not matched and quantity > 0:
        next_items.append({"product_id": product_id, "quantity": quantity})

    cart["items"] = next_items
    return _cart_set(cart_id, cart)


def _find_existing_checkout_intent(*, cart_id: str, user_id: str | None, idempotency_key: str | None) -> Dict[str, Any] | None:
    cart_id = str(cart_id or "").strip()
    user_id = str(user_id or "").strip() or None
    key = str(idempotency_key or "").strip() or None
    if not key:
        return None

    for row in _orders_store().values():
        if str(row.get("order_kind") or "") != "cart_checkout_intent":
            continue
        if str(row.get("cart_id") or "") != cart_id:
            continue
        row_user = str(row.get("user_id") or "").strip() or None
        if user_id and row_user != user_id:
            continue
        if str(row.get("idempotency_key") or "") != key:
            continue
        status = str(row.get("status") or "").strip().lower()
        if status in {"checkout_created", "checkout_pending", "paid"}:
            return row
    return None


def _find_product(product_id: str) -> Dict[str, Any] | None:
    key = str(product_id or "").strip()
    if not key:
        return None
    return db.get_product(key)


def _stripe_secret_key() -> str:
    return os.environ.get("STRIPE_SECRET_KEY", "").strip()


def _stripe_create_checkout_session_for_lines(
    *,
    secret_key: str,
    order_id: str,
    lines: List[Dict[str, Any]],
    success_url: str,
    cancel_url: str,
    customer_email: str | None = None,
    metadata: Dict[str, str] | None = None,
) -> Dict[str, Any]:
    if not lines:
        raise HTTPException(status_code=400, detail="checkout line items required")

    params: List[tuple[str, str]] = [
        ("mode", "payment"),
        ("success_url", success_url),
        ("cancel_url", cancel_url),
        ("client_reference_id", order_id),
        ("metadata[order_id]", order_id),
    ]

    for k, v in (metadata or {}).items():
        key = str(k or "").strip()
        val = str(v or "").strip()
        if key and val:
            params.append((f"metadata[{key}]", val))

    for idx, line in enumerate(lines):
        product_name = str(line.get("name") or "Catholic item").strip() or "Catholic item"
        currency = str(line.get("currency") or "USD").strip().lower() or "usd"
        unit_amount = int(line.get("unit_amount") or 0)
        quantity = int(line.get("quantity") or 0)
        if unit_amount <= 0 or quantity <= 0:
            raise HTTPException(status_code=409, detail="Invalid checkout line item amount/quantity")

        params.extend(
            [
                (f"line_items[{idx}][quantity]", str(quantity)),
                (f"line_items[{idx}][price_data][currency]", currency),
                (f"line_items[{idx}][price_data][unit_amount]", str(unit_amount)),
                (f"line_items[{idx}][price_data][product_data][name]", product_name),
            ]
        )

    if customer_email:
        params.append(("customer_email", customer_email))

    body = urllib.parse.urlencode(params).encode("utf-8")
    req = urllib.request.Request(
        f"{STRIPE_API_BASE}/checkout/sessions",
        data=body,
        headers={
            "Authorization": f"Bearer {secret_key}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as response:
            resp_body = response.read().decode("utf-8", errors="replace")
            payload = json.loads(resp_body or "{}")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise HTTPException(status_code=409, detail={"message": "Stripe rejected checkout session", "status": exc.code, "body": detail})
    except urllib.error.URLError as exc:
        raise HTTPException(status_code=409, detail={"message": "Stripe request failed", "reason": str(exc.reason)})

    session_id = str(payload.get("id") or "").strip()
    url = str(payload.get("url") or "").strip()
    if not session_id or not url:
        raise HTTPException(status_code=409, detail={"message": "Stripe response missing session id/url", "body": payload})
    return {"session_id": session_id, "url": url}


def _stripe_create_checkout_session(
    *,
    secret_key: str,
    order_id: str,
    product: Dict[str, Any],
    quantity: int,
    success_url: str,
    cancel_url: str,
    customer_email: str | None = None,
) -> Dict[str, Any]:
    unit_amount = int(product.get("price_cents") or 0)
    if unit_amount <= 0:
        raise HTTPException(status_code=409, detail="Product is missing valid price_cents")
    return _stripe_create_checkout_session_for_lines(
        secret_key=secret_key,
        order_id=order_id,
        lines=[
            {
                "name": str(product.get("title") or "Catholic item").strip() or "Catholic item",
                "currency": str(product.get("currency") or "USD").strip() or "USD",
                "unit_amount": unit_amount,
                "quantity": int(quantity),
            }
        ],
        success_url=success_url,
        cancel_url=cancel_url,
        customer_email=customer_email,
        metadata={
            "product_id": str(product.get("product_id") or ""),
            "shop_id": str(product.get("shop_id") or ""),
            "order_kind": "buy_now",
        },
    )


def _decrement_product_inventory(product_id: str, quantity: int) -> None:
    rows = _json_read(PRODUCTS_JSON, [])
    if not isinstance(rows, list):
        return
    changed = False
    for row in rows:
        if str(row.get("product_id") or "") != str(product_id or ""):
            continue
        qty_raw = row.get("quantity_on_hand")
        try:
            if qty_raw in (None, ""):
                return
            current_qty = int(qty_raw)
        except Exception:
            return
        new_qty = max(0, current_qty - int(max(0, quantity)))
        row["quantity_on_hand"] = new_qty
        if new_qty <= 0:
            row["inventory_status"] = "out_of_stock"
        elif new_qty <= 2:
            row["inventory_status"] = "low_stock"
        else:
            row["inventory_status"] = "in_stock"
        row["inventory_updated_at"] = _utc_now_iso()
        changed = True
        break
    if changed:
        _json_write(PRODUCTS_JSON, rows)


def _shops() -> List[Dict[str, Any]]:
    _ensure_seed_data()
    return db.get_shops()


def _products() -> List[Dict[str, Any]]:
    _ensure_seed_data()
    return db.get_products()


def _products_with_shop() -> List[Dict[str, Any]]:
    _ensure_seed_data()
    return db.get_products_with_shop()


_INTENT_STOPWORDS = {
    "a",
    "an",
    "the",
    "for",
    "from",
    "to",
    "of",
    "and",
    "with",
    "in",
    "on",
    "under",
    "below",
    "less",
    "than",
    "gift",
    "need",
    "looking",
    "shop",
}

_OCCASION_ALIASES = {
    "first communion": "first_communion",
    "communion": "first_communion",
    "confirmation": "confirmation",
    "baptism": "baptism",
    "christening": "baptism",
    "godchild": "baptism",
    "godparent": "baptism",
    "newborn": "baptism",
    "wedding": "wedding",
    "marriage": "wedding",
    "engaged": "wedding",
    "bride": "wedding",
    "groom": "wedding",
    "house blessing": "house_blessing",
    "bless my home": "house_blessing",
    "new home": "house_blessing",
    "new house": "house_blessing",
    "apartment": "house_blessing",
    "sick": "healing",
    "healing": "healing",
    "hospital": "healing",
    "illness": "healing",
    "surgery": "healing",
    "dying": "comfort",
    "grief": "comfort",
    "funeral": "comfort",
    "loss": "comfort",
    "comfort": "comfort",
    "rcia": "rcia",
    "convert": "rcia",
    "conversion": "rcia",
    "easter": "easter",
    "lent": "lent",
    "christmas": "christmas",
    "ordination": "ordination",
    "priest": "ordination",
    "travel": "travel",
    "trip": "travel",
    "pilgrimage": "travel",
    "protection": "protection",
    "safe": "protection",
}

_CATEGORY_KEYWORDS = {
    "rosary": ["rosary", "chaplet"],
    "cross": ["cross", "crucifix", "tau"],
    "icon": ["icon", "altar"],
    "scapular": ["scapular"],
    "prayer_cards": ["prayer card", "cards", "saint card"],
    "marian": ["marian", "our lady", "mary", "guadalupe"],
}


def _intent_tokenize(intent: str) -> List[str]:
    tokens = [tok for tok in re.split(r"[^a-z0-9]+", str(intent or "").lower()) if tok]
    return [tok for tok in tokens if tok not in _INTENT_STOPWORDS and len(tok) >= 2]


def _budget_from_intent(intent: str) -> int | None:
    text = str(intent or "").lower()
    patterns = [
        r"(?:under|below|less than)\s*\$?\s*(\d+(?:\.\d+)?)",
        r"\$\s*(\d+(?:\.\d+)?)",
    ]
    for pattern in patterns:
        m = re.search(pattern, text)
        if not m:
            continue
        try:
            return int(round(float(m.group(1)) * 100))
        except Exception:
            continue
    return None


def _intent_context(payload: AIRecommendPayload, rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    intent = str(payload.intent or "").strip().lower()
    intent_slug = _slug(intent)
    intent_words = set(intent_slug.split("-"))

    countries = {_slug(str(row.get("country") or "")): str(row.get("country") or "") for row in rows}
    cities = {_slug(str(row.get("city") or "")): str(row.get("city") or "") for row in rows}

    requested_country_slug = _slug(str(payload.country or "")) if payload.country else ""
    if not requested_country_slug or requested_country_slug == "na":
        for slug in countries.keys():
            if slug and slug != "na" and slug in intent_words:
                requested_country_slug = slug
                break

    requested_city_slug = ""
    for slug in cities.keys():
        if slug and slug != "na" and slug in intent_words:
            requested_city_slug = slug
            break

    requested_occasions = set()
    explicit_occasion = _slug(str(payload.occasion or "")).replace("-", "_") if payload.occasion else ""
    if explicit_occasion:
        requested_occasions.add(explicit_occasion)
    for phrase, canonical in _OCCASION_ALIASES.items():
        if phrase in intent:
            requested_occasions.add(canonical)

    requested_categories = set()
    for category, keywords in _CATEGORY_KEYWORDS.items():
        if any(keyword in intent for keyword in keywords):
            requested_categories.add(category)

    budget_cents = int(max(0.0, payload.budget_usd) * 100) if payload.budget_usd is not None else None
    if budget_cents is None:
        budget_cents = _budget_from_intent(intent)

    return {
        "intent": intent,
        "tokens": _intent_tokenize(intent),
        "requested_country_slug": requested_country_slug if requested_country_slug != "na" else "",
        "requested_city_slug": requested_city_slug if requested_city_slug != "na" else "",
        "requested_occasions": requested_occasions,
        "requested_categories": requested_categories,
        "budget_cents": budget_cents,
    }


def _score_product(item: Dict[str, Any], payload: AIRecommendPayload, context: Dict[str, Any]) -> tuple[float, List[str]]:
    reasons: List[str] = []
    score = 0.0

    inventory_status = str(item.get("inventory_status") or "").strip().lower()
    if inventory_status == "out_of_stock":
        return -10.0, ["out_of_stock"]

    corpus = " ".join(
        [
            str(item.get("title") or ""),
            str(item.get("story") or ""),
            " ".join(item.get("tags") or []),
            " ".join(item.get("sacrament_tags") or []),
        ]
    ).lower()

    matched_tokens = [tok for tok in (context.get("tokens") or []) if tok in corpus]
    if matched_tokens:
        score += min(0.45, 0.09 * len(matched_tokens))
        reasons.append(f"matches intent: {', '.join(matched_tokens[:4])}")

    requested_categories = set(context.get("requested_categories") or set())
    for category in requested_categories:
        keywords = _CATEGORY_KEYWORDS.get(category) or []
        if any(keyword in corpus for keyword in keywords):
            score += 0.3
            reasons.append(f"matches category: {category.replace('_', ' ')}")

    requested_occasions = set(context.get("requested_occasions") or set())
    if requested_occasions:
        item_occasions = {str(v).strip().lower() for v in (item.get("sacrament_tags") or []) if str(v).strip()}
        if item_occasions & requested_occasions:
            score += 0.35
            reasons.append("occasion fit")
        else:
            score -= 0.15

    requested_country_slug = str(context.get("requested_country_slug") or "")
    item_country_slug = _slug(str(item.get("country") or ""))
    if requested_country_slug:
        if item_country_slug == requested_country_slug:
            score += 0.45
            reasons.append(f"from requested country ({item.get('country')})")
        else:
            score -= 0.3

    requested_city_slug = str(context.get("requested_city_slug") or "")
    item_city_slug = _slug(str(item.get("city") or ""))
    if requested_city_slug:
        if item_city_slug == requested_city_slug:
            score += 0.25
            reasons.append(f"from requested city ({item.get('city')})")
        else:
            score -= 0.15

    price_cents = int(item.get("price_cents") or 0)
    budget_cents = context.get("budget_cents")
    if budget_cents is not None:
        try:
            budget_cents = int(budget_cents)
        except Exception:
            budget_cents = None
    if budget_cents is not None and budget_cents > 0:
        if price_cents <= budget_cents:
            score += 0.22
            reasons.append("within budget")
        else:
            over = max(1, price_cents - budget_cents)
            penalty = min(0.35, over / max(1, budget_cents))
            score -= penalty
            reasons.append("over budget")

    if inventory_status == "in_stock":
        score += 0.08
    elif inventory_status == "low_stock":
        score += 0.05
        reasons.append("low stock")
    elif inventory_status == "made_to_order":
        score -= 0.03
        lead_days = item.get("lead_time_days")
        if lead_days not in (None, ""):
            reasons.append(f"made to order (~{lead_days} day lead)")

    return score, reasons


def _destination_slugs_for_row(row: Dict[str, Any]) -> List[str]:
    shop = row.get("shop") or {}
    city = _slug(str(row.get("city") or shop.get("city") or ""))
    country = _slug(str(row.get("country") or shop.get("country") or ""))
    slugs = []
    if city and city != "na":
        slugs.append(city)
    if country and country != "na":
        slugs.append(country)
    if city and country and city != "na" and country != "na":
        slugs.append(f"{city}-{country}")
    return list(dict.fromkeys(slugs))


def _destination_rows() -> List[Dict[str, Any]]:
    by_id: Dict[str, Dict[str, Any]] = {}
    for row in _products_with_shop():
        shop = row.get("shop") or {}
        city = str(row.get("city") or shop.get("city") or "").strip()
        country = str(row.get("country") or shop.get("country") or "").strip()
        city_slug = _slug(city)
        country_slug = _slug(country)
        if not city_slug or city_slug == "na":
            continue
        if not country_slug or country_slug == "na":
            continue
        destination_id = f"{city_slug}-{country_slug}"
        item = by_id.get(destination_id)
        if item is None:
            by_id[destination_id] = {
                "destination_id": destination_id,
                "city": city,
                "country": country,
                "label": f"{city}, {country}",
                "product_count": 0,
                "shop_ids": set(),
            }
            item = by_id[destination_id]
        item["product_count"] += 1
        shop_id = str((row.get("shop") or {}).get("shop_id") or row.get("shop_id") or "").strip()
        if shop_id:
            item["shop_ids"].add(shop_id)

    out: List[Dict[str, Any]] = []
    for item in by_id.values():
        out.append(
            {
                "destination_id": item["destination_id"],
                "city": item["city"],
                "country": item["country"],
                "label": item["label"],
                "product_count": int(item["product_count"]),
                "shop_count": len(item["shop_ids"]),
            }
        )
    out.sort(key=lambda row: (-int(row.get("product_count") or 0), str(row.get("label") or "")))
    return out


@app.get("/")
def root() -> FileResponse:
    if not FRONTEND_INDEX.exists():
        raise HTTPException(status_code=404, detail="frontend not found")
    return FileResponse(FRONTEND_INDEX)


@app.get("/sacraments")
def sacraments_page() -> FileResponse:
    if not SACRAMENTS_PAGE.exists():
        raise HTTPException(status_code=404, detail="sacraments page not found")
    return FileResponse(SACRAMENTS_PAGE)


@app.get("/product")
def product_page() -> FileResponse:
    if not PRODUCT_PAGE.exists():
        raise HTTPException(status_code=404, detail="product page not found")
    return FileResponse(PRODUCT_PAGE)


@app.get("/product/{product_id}")
def product_page_by_id(product_id: str) -> FileResponse:
    if not PRODUCT_PAGE.exists():
        raise HTTPException(status_code=404, detail="product page not found")
    return FileResponse(PRODUCT_PAGE)


@app.get("/shop")
def shop_page() -> FileResponse:
    if not SHOP_PAGE.exists():
        raise HTTPException(status_code=404, detail="shop page not found")
    return FileResponse(SHOP_PAGE)


@app.get("/shop/{shop_id}")
def shop_page_by_id(shop_id: str) -> FileResponse:
    if not SHOP_PAGE.exists():
        raise HTTPException(status_code=404, detail="shop page not found")
    return FileResponse(SHOP_PAGE)


@app.get("/ops")
def ops_root() -> FileResponse:
    if not OPS_INDEX.exists():
        raise HTTPException(status_code=404, detail="ops frontend not found")
    return FileResponse(OPS_INDEX)


@app.get("/ops/")
def ops_root_slash() -> FileResponse:
    return ops_root()


@app.get("/health")
def health() -> Dict[str, Any]:
    items = _products()
    return {
        "ok": True,
        "products": len(items),
        "shops": len(_shops()),
        "source": str(PRODUCTS_JSON),
    }


@app.get("/api/v1/mobile/config")
def mobile_config() -> Dict[str, Any]:
    return {
        "framework": "catholic-mobile-v1",
        "nav": ["home", "search", "saved", "cart", "account"],
        "priority": "mobile_first",
        "card_layout": "single_column_compact",
    }


@app.post("/api/v1/auth/guest-session")
def auth_guest_session(payload: GuestSessionPayload) -> Dict[str, Any]:
    users = _user_store()
    now = _utc_now_iso()
    display_name = str(payload.display_name or "Guest").strip() or "Guest"
    user_id = f"user_{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')}"
    users[user_id] = {
        "user_id": user_id,
        "display_name": display_name,
        "role": "shopper",
        "created_at": now,
        "updated_at": now,
    }
    _persist_user_store(users)
    return {"user": users[user_id], "token": f"guest_{user_id}"}


@app.get("/api/v1/users/{user_id}")
def user_get(user_id: str) -> Dict[str, Any]:
    return {"user": _require_user(user_id)}


@app.get("/api/v1/users/{user_id}/saved")
def user_saved_list(user_id: str) -> Dict[str, Any]:
    _require_user(user_id)
    saved = _saved_products_for_user(user_id)
    return {"user_id": user_id, "count": len(saved), "items": saved}


@app.post("/api/v1/users/{user_id}/saved/{product_id}")
def user_saved_add(user_id: str, product_id: str) -> Dict[str, Any]:
    _require_user(user_id)
    match = next((p for p in _products() if str(p.get("product_id") or "") == str(product_id or "")), None)
    if not match:
        raise HTTPException(status_code=404, detail=f"Unknown product_id {product_id}")

    saved_store = _saved_store()
    rows = list(saved_store.get(user_id, []))
    if product_id not in rows:
        rows.append(product_id)
    saved_store[user_id] = rows
    _persist_saved_store(saved_store)
    return {"saved": True, "user_id": user_id, "product_id": product_id, "saved_count": len(rows)}


@app.delete("/api/v1/users/{user_id}/saved/{product_id}")
def user_saved_remove(user_id: str, product_id: str) -> Dict[str, Any]:
    _require_user(user_id)
    saved_store = _saved_store()
    rows = [pid for pid in (saved_store.get(user_id, []) or []) if pid != product_id]
    saved_store[user_id] = rows
    _persist_saved_store(saved_store)
    return {"saved": False, "user_id": user_id, "product_id": product_id, "saved_count": len(rows)}


@app.post("/api/v1/carts")
def cart_create(payload: CartSessionPayload) -> Dict[str, Any]:
    user_id = str(payload.user_id or "").strip()
    if user_id:
        _require_user(user_id)
    cart_id = f"cart_{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')}"
    now = _utc_now_iso()
    cart = {
        "cart_id": cart_id,
        "user_id": user_id or None,
        "status": "active",
        "items": [],
        "created_at": now,
        "updated_at": now,
    }
    store = _cart_store()
    store[cart_id] = cart
    _persist_cart_store(store)
    return {"cart": _cart_hydrate(cart)}


@app.get("/api/v1/carts/{cart_id}")
def cart_get(cart_id: str) -> Dict[str, Any]:
    return {"cart": _cart_get(cart_id)}


@app.post("/api/v1/carts/{cart_id}/items")
def cart_item_add(cart_id: str, payload: CartItemPayload) -> Dict[str, Any]:
    cart = _cart_get(cart_id)
    current_qty = 0
    for row in list(cart.get("items") or []):
        if str(row.get("product_id") or "").strip() == str(payload.product_id or "").strip():
            current_qty = int(row.get("quantity") or 0)
            break
    next_qty = current_qty + int(payload.quantity)
    return {"cart": _cart_set_product_quantity(cart_id, payload.product_id, next_qty)}


@app.put("/api/v1/carts/{cart_id}/items/{product_id}")
def cart_item_update(cart_id: str, product_id: str, payload: CartItemUpdatePayload) -> Dict[str, Any]:
    return {"cart": _cart_set_product_quantity(cart_id, product_id, int(payload.quantity))}


@app.delete("/api/v1/carts/{cart_id}/items/{product_id}")
def cart_item_remove(cart_id: str, product_id: str) -> Dict[str, Any]:
    return {"cart": _cart_set_product_quantity(cart_id, product_id, 0)}


@app.post("/api/v1/checkout/intents")
def checkout_intent_create(payload: CheckoutIntentPayload) -> Dict[str, Any]:
    user_id = str(payload.user_id or "").strip()
    if user_id:
        _require_user(user_id)

    cart = _cart_get(payload.cart_id)
    cart_user_id = str(cart.get("user_id") or "").strip()
    if cart_user_id and user_id and cart_user_id != user_id:
        raise HTTPException(status_code=409, detail="cart user mismatch")

    if user_id and not cart_user_id:
        raw = _cart_store().get(str(payload.cart_id), {})
        if isinstance(raw, dict):
            raw["user_id"] = user_id
            _cart_set(payload.cart_id, raw)
            cart = _cart_get(payload.cart_id)

    order_items = []
    lines = []
    subtotal_cents = 0
    for row in list(cart.get("items") or []):
        product = dict(row.get("product") or {})
        product_id = str(row.get("product_id") or "").strip()
        quantity = int(row.get("quantity") or 0)
        unit_price_cents = int(row.get("unit_price_cents") or 0)
        line_total_cents = int(row.get("line_total_cents") or 0)
        if not product_id or quantity <= 0 or unit_price_cents <= 0:
            continue

        subtotal_cents += line_total_cents
        order_items.append(
            {
                "product_id": product_id,
                "title": str(row.get("title") or "").strip() or str(product.get("title") or "").strip(),
                "shop_id": str(row.get("shop_id") or product.get("shop_id") or "").strip() or None,
                "sku": str(row.get("sku") or product.get("sku") or "").strip() or None,
                "quantity": quantity,
                "unit_price_cents": unit_price_cents,
                "line_total_cents": line_total_cents,
                "currency": str(row.get("currency") or product.get("currency") or "USD").strip() or "USD",
            }
        )
        lines.append(
            {
                "name": str(row.get("title") or product.get("title") or "Catholic item").strip() or "Catholic item",
                "currency": str(row.get("currency") or product.get("currency") or "USD").strip() or "USD",
                "unit_amount": unit_price_cents,
                "quantity": quantity,
            }
        )

    if not order_items:
        raise HTTPException(status_code=409, detail="Cart is empty")

    idem_key = str(payload.idempotency_key or "").strip() or None
    existing = _find_existing_checkout_intent(cart_id=payload.cart_id, user_id=user_id or cart_user_id or None, idempotency_key=idem_key)
    if existing:
        return {
            "intent_id": str(existing.get("order_id") or ""),
            "order_id": str(existing.get("order_id") or ""),
            "cart_id": str(existing.get("cart_id") or payload.cart_id),
            "status": str(existing.get("status") or "checkout_pending"),
            "checkout_url": str(existing.get("checkout_url") or ""),
            "checkout_mode": str(existing.get("checkout_mode") or "dry_run"),
            "reused": True,
            "order": existing,
        }

    order_id = f"ord_{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')}"
    now = _utc_now_iso()
    success_url = str(payload.success_url or "").strip() or DEFAULT_CHECKOUT_SUCCESS_URL
    cancel_url = str(payload.cancel_url or "").strip() or DEFAULT_CHECKOUT_CANCEL_URL

    checkout_url = ""
    stripe_session_id = ""
    checkout_mode = "dry_run"
    if not bool(payload.dry_run):
        secret = _stripe_secret_key()
        if not secret:
            raise HTTPException(status_code=409, detail="STRIPE_SECRET_KEY missing")
        stripe_session = _stripe_create_checkout_session_for_lines(
            secret_key=secret,
            order_id=order_id,
            lines=lines,
            success_url=success_url,
            cancel_url=cancel_url,
            customer_email=str(payload.customer_email or "").strip() or None,
            metadata={
                "cart_id": str(payload.cart_id),
                "order_kind": "cart_checkout_intent",
            },
        )
        checkout_url = stripe_session["url"]
        stripe_session_id = stripe_session["session_id"]
        checkout_mode = "stripe_live"
    else:
        checkout_url = f"{cancel_url}#dry_run_order={order_id}"

    currency = str(order_items[0].get("currency") or "USD") if order_items else "USD"
    record = {
        "order_id": order_id,
        "order_kind": "cart_checkout_intent",
        "cart_id": str(payload.cart_id),
        "idempotency_key": idem_key,
        "user_id": user_id or cart_user_id or None,
        "order_items": order_items,
        "total_quantity": int(sum(int(v.get("quantity") or 0) for v in order_items)),
        "total_amount_cents": subtotal_cents,
        "currency": currency,
        "customer_email": str(payload.customer_email or "").strip() or None,
        "status": "checkout_pending" if checkout_url else "checkout_created",
        "checkout_mode": checkout_mode,
        "checkout_url": checkout_url,
        "stripe_session_id": stripe_session_id or None,
        "partner_dispatch_notes": [],
        "created_at": now,
        "updated_at": now,
        "event_log": [
            {
                "event": "checkout_created",
                "at": now,
                "note": str(payload.note or "").strip() or None,
            }
        ],
    }

    store = _orders_store()
    store[order_id] = record
    _persist_orders_store(store)

    raw_cart_store = _cart_store()
    raw_cart = raw_cart_store.get(str(payload.cart_id), {})
    if isinstance(raw_cart, dict):
        raw_cart["last_checkout_intent_id"] = order_id
        raw_cart["updated_at"] = now
        raw_cart_store[str(payload.cart_id)] = raw_cart
        _persist_cart_store(raw_cart_store)

    return {
        "intent_id": order_id,
        "order_id": order_id,
        "cart_id": str(payload.cart_id),
        "status": record["status"],
        "checkout_url": checkout_url,
        "checkout_mode": checkout_mode,
        "reused": False,
        "order": record,
    }


@app.post("/api/v1/checkout/buy-now")
def checkout_buy_now(payload: BuyNowPayload) -> Dict[str, Any]:
    user_id = str(payload.user_id or "").strip()
    if user_id:
        _require_user(user_id)

    product = _find_product(payload.product_id)
    if not product:
        raise HTTPException(status_code=404, detail=f"Unknown product_id {payload.product_id}")

    inventory_status = str(product.get("inventory_status") or "").strip().lower()
    if inventory_status == "out_of_stock":
        raise HTTPException(status_code=409, detail="Product is out_of_stock")

    quantity = int(payload.quantity)
    qty_on_hand = product.get("quantity_on_hand")
    if qty_on_hand not in (None, ""):
        try:
            if quantity > int(qty_on_hand):
                raise HTTPException(status_code=409, detail={"message": "Requested quantity exceeds quantity_on_hand", "quantity_on_hand": int(qty_on_hand)})
        except ValueError:
            pass

    order_id = f"ord_{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')}"
    unit_price_cents = int(product.get("price_cents") or 0)
    total_amount_cents = unit_price_cents * quantity
    now = _utc_now_iso()

    success_url = str(payload.success_url or "").strip() or DEFAULT_CHECKOUT_SUCCESS_URL
    cancel_url = str(payload.cancel_url or "").strip() or DEFAULT_CHECKOUT_CANCEL_URL

    checkout_url = ""
    stripe_session_id = ""
    checkout_mode = "dry_run"
    if not bool(payload.dry_run):
        secret = _stripe_secret_key()
        if not secret:
            raise HTTPException(status_code=409, detail="STRIPE_SECRET_KEY missing")
        stripe_session = _stripe_create_checkout_session(
            secret_key=secret,
            order_id=order_id,
            product=product,
            quantity=quantity,
            success_url=success_url,
            cancel_url=cancel_url,
            customer_email=str(payload.customer_email or "").strip() or None,
        )
        checkout_url = stripe_session["url"]
        stripe_session_id = stripe_session["session_id"]
        checkout_mode = "stripe_live"
    else:
        checkout_url = f"{cancel_url}#dry_run_order={order_id}"

    record = {
        "order_id": order_id,
        "user_id": user_id or None,
        "product_id": str(product.get("product_id") or ""),
        "sku": str(product.get("sku") or "").strip() or None,
        "product_title": str(product.get("title") or "").strip(),
        "shop_id": str(product.get("shop_id") or "").strip(),
        "quantity": quantity,
        "unit_price_cents": unit_price_cents,
        "total_amount_cents": total_amount_cents,
        "currency": str(product.get("currency") or "USD").strip() or "USD",
        "customer_email": str(payload.customer_email or "").strip() or None,
        "status": "checkout_pending" if checkout_url else "checkout_created",
        "checkout_mode": checkout_mode,
        "checkout_url": checkout_url,
        "stripe_session_id": stripe_session_id or None,
        "partner_dispatch_notes": [],
        "created_at": now,
        "updated_at": now,
        "event_log": [
            {
                "event": "checkout_created",
                "at": now,
                "note": str(payload.note or "").strip() or None,
            }
        ],
    }

    store = _orders_store()
    store[order_id] = record
    _persist_orders_store(store)

    return {
        "order_id": order_id,
        "checkout_url": checkout_url,
        "checkout_mode": checkout_mode,
        "status": record["status"],
        "order": record,
    }


@app.get("/api/v1/orders")
def orders_list(status: str | None = None, limit: int = 100) -> Dict[str, Any]:
    rows = list(_orders_store().values())
    if status:
        desired = str(status or "").strip().lower()
        rows = [row for row in rows if str(row.get("status") or "").strip().lower() == desired]
    rows.sort(key=lambda row: str(row.get("updated_at") or row.get("created_at") or ""), reverse=True)
    limit = max(1, min(500, int(limit)))
    return {"count": len(rows), "items": rows[:limit]}


@app.get("/api/v1/orders/{order_id}")
def order_get(order_id: str) -> Dict[str, Any]:
    row = _orders_store().get(str(order_id or ""))
    if not row:
        raise HTTPException(status_code=404, detail=f"Unknown order_id {order_id}")
    return {"order": row}


@app.post("/api/v1/orders/{order_id}/dispatch-note")
def order_dispatch_note(order_id: str, payload: OrderDispatchNotePayload) -> Dict[str, Any]:
    note = str(payload.note or "").strip()
    if not note:
        raise HTTPException(status_code=400, detail="note is required")

    store = _orders_store()
    row = store.get(str(order_id or ""))
    if not row:
        raise HTTPException(status_code=404, detail=f"Unknown order_id {order_id}")

    notes = list(row.get("partner_dispatch_notes") or [])
    now = _utc_now_iso()
    notes.append({"note": note, "actor": str(payload.actor or "").strip() or None, "at": now})
    row["partner_dispatch_notes"] = notes
    row["updated_at"] = now
    event_log = list(row.get("event_log") or [])
    event_log.append({"event": "dispatch_note_added", "at": now, "note": note})
    row["event_log"] = event_log
    store[str(order_id)] = row
    _persist_orders_store(store)
    return {"ok": True, "order": row}


@app.post("/api/v1/orders/{order_id}/status")
def order_status_update(order_id: str, payload: OrderStatusPayload) -> Dict[str, Any]:
    new_status = str(payload.status or "").strip().lower()
    if new_status not in ALLOWED_ORDER_STATUSES:
        raise HTTPException(status_code=400, detail={"message": "invalid status", "allowed": sorted(ALLOWED_ORDER_STATUSES)})

    store = _orders_store()
    row = store.get(str(order_id or ""))
    if not row:
        raise HTTPException(status_code=404, detail=f"Unknown order_id {order_id}")

    previous_status = str(row.get("status") or "").strip().lower()
    now = _utc_now_iso()
    row["status"] = new_status
    row["updated_at"] = now
    event_log = list(row.get("event_log") or [])
    event_log.append(
        {
            "event": "status_updated",
            "at": now,
            "from": previous_status,
            "to": new_status,
            "note": str(payload.note or "").strip() or None,
            "actor": str(payload.actor or "").strip() or None,
        }
    )
    row["event_log"] = event_log

    if new_status == "paid" and previous_status != "paid":
        order_items = list(row.get("order_items") or [])
        if order_items:
            for item in order_items:
                _decrement_product_inventory(str(item.get("product_id") or ""), int(item.get("quantity") or 1))
        else:
            _decrement_product_inventory(str(row.get("product_id") or ""), int(row.get("quantity") or 1))

    store[str(order_id)] = row
    _persist_orders_store(store)
    return {"ok": True, "order": row}


@app.get("/api/v1/shops")
def list_shops(limit: int = 50) -> Dict[str, Any]:
    rows = _shops()[: max(1, min(200, limit))]
    return {"count": len(rows), "items": rows}


@app.get("/api/v1/shops/{shop_id}")
def get_shop(shop_id: str) -> Dict[str, Any]:
    match = next((s for s in _shops() if str(s.get("shop_id") or "") == shop_id), None)
    if not match:
        raise HTTPException(status_code=404, detail=f"Unknown shop_id {shop_id}")
    products = [p for p in _products() if str(p.get("shop_id") or "") == shop_id]
    # auto-log shop view
    log_event(
        event_type="shop_view",
        payload={"shop_id": shop_id, "shop_name": str(match.get("name") or ""), "product_count": len(products)},
        path=f"/api/v1/shops/{shop_id}",
        source="backend",
    )
    return {"shop": match, "products": products}


@app.get("/api/v1/destinations")
def list_destinations(limit: int = 20) -> Dict[str, Any]:
    rows = _destination_rows()[: max(1, min(200, limit))]
    return {"count": len(rows), "items": rows}


@app.get("/api/v1/catalog/feed")
def catalog_feed(
    q: str | None = None,
    country: str | None = None,
    destination: str | None = None,
    occasion: str | None = None,
    max_price_usd: float | None = None,
    limit: int = 20,
) -> Dict[str, Any]:
    rows = _products_with_shop()
    query = str(q or "").strip().lower()
    country_filter = str(country or "").strip().lower()
    destination_filter = _slug(destination).replace("-", "_").replace("_", "-") if destination else ""
    occasion_filter = _slug(occasion).replace("-", "_") if occasion else ""
    max_price_cents = int(max_price_usd * 100) if max_price_usd is not None else None

    filtered: List[Dict[str, Any]] = []
    for row in rows:
        corpus = " ".join(
            [
                str(row.get("title") or ""),
                str(row.get("story") or ""),
                " ".join(row.get("tags") or []),
                " ".join(row.get("sacrament_tags") or []),
                str((row.get("shop") or {}).get("name") or ""),
            ]
        ).lower()
        if query and query not in corpus:
            continue
        if country_filter and str(row.get("country") or "").lower() != country_filter:
            continue
        if destination_filter:
            row_destinations = _destination_slugs_for_row(row)
            if destination_filter not in row_destinations:
                continue
        if occasion_filter and occasion_filter not in [str(v) for v in (row.get("sacrament_tags") or [])]:
            continue
        if max_price_cents is not None and int(row.get("price_cents") or 0) > max_price_cents:
            continue
        filtered.append(row)

    filtered.sort(key=lambda item: int(item.get("price_cents") or 0))
    limit = max(1, min(200, limit))
    return {
        "count": len(filtered),
        "items": filtered[:limit],
        "filters": {
            "q": q,
            "country": country,
            "destination": destination,
            "occasion": occasion,
            "max_price_usd": max_price_usd,
            "limit": limit,
        },
    }


@app.get("/api/v1/products/{product_id}")
def product_detail(product_id: str) -> Dict[str, Any]:
    match = next((p for p in _products_with_shop() if str(p.get("product_id") or "") == product_id), None)
    if not match:
        raise HTTPException(status_code=404, detail=f"Unknown product_id {product_id}")
    # auto-log product view
    log_event(
        event_type="product_view",
        payload={"product_id": product_id, "title": str(match.get("title") or ""), "shop_id": str(match.get("shop_id") or "")},
        path=f"/api/v1/products/{product_id}",
        source="backend",
    )
    return {"product": match}


@app.post("/api/v1/shops/onboarding")
def shop_onboarding(payload: ShopOnboardingPayload) -> Dict[str, Any]:
    lead_id = f"lead_{_slug(payload.shop_name)}_{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')}"
    now = _utc_now_iso()
    db.insert_shop_lead({
        "lead_id": lead_id,
        "shop_name": payload.shop_name,
        "contact_name": payload.contact_name,
        "email": payload.email,
        "country": payload.country,
        "city": payload.city,
        "website_url": payload.website_url,
        "whatsapp": payload.whatsapp,
        "notes": payload.notes,
        "status": "new",
        "created_at": now,
    })
    return {"accepted": True, "lead_id": lead_id}


@app.post("/api/v1/ai/recommend")
def ai_recommend(payload: AIRecommendPayload) -> Dict[str, Any]:
    """
    AI-powered product recommendations.
    Calls the PI concierge (LLM) for intelligent matching.
    Falls back to keyword matching if PI is unavailable.
    """
    rows = _products_with_shop()
    catalog = _compact_catalog(rows)

    # Try PI concierge first
    try:
        pi_result = _call_pi_concierge(catalog, payload)
        if pi_result and pi_result.get("recommendations"):
            # auto-log recommendation request
            result_count = len(pi_result["recommendations"])
            log_event(
                event_type="ai_recommend",
                payload={
                    "intent": str(payload.intent or ""),
                    "result_count": result_count,
                    "framework": "catholic-ai-concierge-v3-pi",
                },
                path="/api/v1/ai/recommend",
                source="backend",
            )
            return {
                "framework": "catholic-ai-concierge-v3-pi",
                "intent": payload.intent,
                "summary": pi_result.get("summary", ""),
                "recommendations": pi_result["recommendations"],
                "parsed_intent": {
                    "tokens": _intent_tokenize(str(payload.intent or "").strip().lower()),
                    "requested_country": _slug(str(payload.country or "")) or None,
                    "requested_city": None,
                    "requested_occasions": sorted(list(_detect_occasions(str(payload.intent or "").lower()))),
                    "requested_categories": [],
                    "budget_cents": int(max(0.0, payload.budget_usd) * 100) if payload.budget_usd is not None else None,
                },
                "provider": "pi",
            }
    except Exception as e:
        import traceback
        print(f"[ai_recommend] PI concierge unavailable: {e}")
        traceback.print_exc()

    # Fallback: keyword matching
    result = _keyword_recommend(payload, rows)
    # auto-log recommendation request (fallback)
    recs = result.get("recommendations") or []
    log_event(
        event_type="ai_recommend",
        payload={
            "intent": str(payload.intent or ""),
            "result_count": len(recs),
            "framework": result.get("framework", "unknown"),
        },
        path="/api/v1/ai/recommend",
        source="backend",
    )
    return result

@app.post("/api/v1/social/generate")
def social_generate(payload: SocialGeneratePayload) -> Dict[str, Any]:
    product: Dict[str, Any] | None = None
    if payload.product_id:
        product = next((p for p in _products_with_shop() if str(p.get("product_id") or "") == payload.product_id), None)
        if not product:
            raise HTTPException(status_code=404, detail=f"Unknown product_id {payload.product_id}")

    cta = payload.cta or "Tap to see the full story and support a Catholic shop."
    tone = str(payload.tone or "reverent")

    if product:
        title = str(product.get("title") or "This item")
        shop_name = str((product.get("shop") or {}).get("name") or "a local Catholic shop")
        city = str(product.get("city") or "")
        country = str(product.get("country") or "")
        short = f"{title} • crafted in {city}, {country}. {cta}"
        long = (
            f"{title} from {shop_name} is rooted in local Catholic craftsmanship. "
            f"Built for prayerful daily life, this piece carries both devotion and story. {cta}"
        )
        reel_hook = f"From {city} to your prayer corner: {title}."
        tags = ["#Catholic", "#CatholicShop", "#FaithAndCraft", f"#{_slug(country).title().replace('-', '')}"]
    else:
        topic = str(payload.custom_topic or "Catholic craftsmanship").strip()
        short = f"{topic} spotlight: discover authentic items from Catholic shops around the world. {cta}"
        long = (
            f"We are building a trusted Catholic marketplace where each product has place, maker, and meaning. "
            f"Today’s focus: {topic}. {cta}"
        )
        reel_hook = f"A global Catholic shop, one authentic story at a time: {topic}."
        tags = ["#Catholic", "#CatholicMakers", "#FaithCommunity", "#ShopSmall"]

    return {
        "framework": "catholic-social-v1",
        "platform": payload.platform,
        "tone": tone,
        "caption_short": short,
        "caption_long": long,
        "reel_hook": reel_hook,
        "hashtags": tags,
        "generated_at": _utc_now_iso(),
    }


# ═══ Chat & Auth helpers ═══

def _ensure_chat_data() -> None:
    _ensure_seed_data()


def _conversations_store() -> Dict[str, Dict[str, Any]]:
    _ensure_seed_data()
    return db.get_conversations()


def _persist_conversations(payload: Dict[str, Dict[str, Any]]) -> None:
    """Full conversations store replacement."""
    for cid, c in payload.items():
        if not isinstance(c, dict):
            continue
        title = str(c.get("title") or c.get("id") or "")[:200]
        occasion = str(c.get("occasion") or "")
        db.upsert_conversation(cid, title, occasion)
        # Only insert messages that don't already exist (checked by row count match)
        existing = db.get_conversation(cid)
        existing_count = len(existing["messages"]) if existing else 0
        new_msgs = c.get("messages") or []
        if len(new_msgs) > existing_count:
            for msg in new_msgs[existing_count:]:
                if not isinstance(msg, dict):
                    continue
                db.insert_message(cid, str(msg.get("role") or "user"), str(msg.get("content") or ""), str(msg.get("timestamp") or ""))


def _chat_users_store() -> Dict[str, Dict[str, Any]]:
    _ensure_seed_data()
    return db.get_users()


def _persist_chat_users(payload: Dict[str, Dict[str, Any]]) -> None:
    """Full chat users store replacement."""
    for uid, u in payload.items():
        if not isinstance(u, dict):
            continue
        existing = db.get_user(uid)
        if not existing:
            db.insert_user(u)

def _hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 100000)
    return f"{salt}${h.hex()}"

def _verify_password(password: str, stored: str) -> bool:
    salt, hash_hex = stored.split("$", 1)
    h = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 100000)
    return hmac.compare_digest(h.hex(), hash_hex)

def _create_jwt(user_id: str, email: str, name: str) -> str:
    return jwt.encode(
        {"sub": user_id, "email": email, "name": name, "iat": datetime.now(timezone.utc)},
        JWT_SECRET,
        algorithm="HS256",
    )

def _decode_jwt(token: str) -> Dict[str, Any] | None:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
    except Exception:
        return None

def _products_for_concierge() -> List[Dict[str, Any]]:
    """Return full product rows with shop info for the concierge."""
    rows = _products_with_shop()
    return _compact_catalog(rows)


# ═══ Chat & Auth models ═══

class ChatSendPayload(BaseModel):
    conversation_id: str
    message: str
    context: List[Dict[str, str]] = Field(default_factory=list)
    occasion: str | None = None

class SignupPayload(BaseModel):
    email: str
    password: str
    name: str

class LoginPayload(BaseModel):
    email: str
    password: str


class AnalyticsEventPayload(BaseModel):
    event_type: str
    session_id: str | None = None
    user_id: str | None = None
    path: str | None = None
    source: str | None = None
    payload: Dict[str, Any] | None = None


# ═══ POST /api/v1/chat/send — SSE streaming ═══

@app.post("/api/v1/chat/send")
def chat_send(payload: ChatSendPayload) -> StreamingResponse:
    """
    Multi-turn chat with SSE streaming.
    Proxies to PI Concierge /chat which handles persona + product recommendations.
    """
    _ensure_chat_data()
    catalog = _products_for_concierge()

    # auto-log chat message (cap message text for privacy)
    log_event(
        event_type="chat_message",
        payload={
            "message": str(payload.message or ""),
            "conversation_id": str(payload.conversation_id or ""),
            "occasion": str(payload.occasion or ""),
        },
        path="/api/v1/chat/send",
        source="backend",
    )

    async def event_stream():
        import urllib.request

        body_bytes = json.dumps({
            "message": payload.message,
            "context": payload.context,
            "occasion": payload.occasion,
            "catalog": catalog,
        }).encode("utf-8")

        rq = urllib.request.Request(
            f"{PI_CONCIERGE_URL}/chat",
            data=body_bytes,
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        assistant_response = ""

        try:
            with urllib.request.urlopen(rq, timeout=90) as resp:
                buffer = b""
                while True:
                    chunk = resp.read(4096)
                    if not chunk:
                        break
                    buffer += chunk
                    lines = buffer.split(b"\n")
                    buffer = lines.pop()
                    for line in lines:
                        decoded = line.decode("utf-8", errors="replace")
                        if decoded.startswith("data: "):
                            yield f"{decoded}\n\n"
                            # Capture text for saving
                            try:
                                event = json.loads(decoded[6:])
                                if event.get("type") == "text":
                                    assistant_response += event.get("content", "")
                            except Exception:
                                pass

                if buffer:
                    decoded = buffer.decode("utf-8", errors="replace")
                    if decoded.strip():
                        yield f"{decoded}\n\n"

        except Exception as e:
            import traceback
            traceback.print_exc()
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"
            yield f"data: {json.dumps({'type': 'done'})}\n\n"

        # Save user + assistant messages to conversation store
        try:
            convs = _conversations_store()
            conv_id = payload.conversation_id
            existing = convs.get(conv_id, {
                "id": conv_id,
                "title": payload.message[:60] if payload.message else "New Pilgrimage",
                "messages": [],
                "created_at": _utc_now_iso(),
                "product_count": 0,
                "occasion": payload.occasion,
            })
            existing["messages"].append({"role": "user", "content": payload.message, "timestamp": _utc_now_iso()})
            if assistant_response:
                existing["messages"].append({"role": "assistant", "content": assistant_response, "timestamp": _utc_now_iso()})
            existing["updated_at"] = _utc_now_iso()
            convs[conv_id] = existing
            _persist_conversations(convs)
        except Exception:
            pass

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            "Access-Control-Allow-Origin": "*",
        },
    )


# ═══ POST /api/v1/auth/signup ═══

@app.post("/api/v1/auth/signup")
def auth_signup(payload: SignupPayload) -> Dict[str, Any]:
    _ensure_chat_data()
    users = _chat_users_store()

    email = payload.email.lower().strip()
    for uid, u in users.items():
        if u.get("email") == email:
            raise HTTPException(status_code=409, detail="A pilgrim with this email already exists")

    user_id = f"pilgrim_{secrets.token_hex(8)}"
    users[user_id] = {
        "id": user_id,
        "email": email,
        "name": payload.name.strip(),
        "password_hash": _hash_password(payload.password),
        "created_at": _utc_now_iso(),
        "preferences": {},
    }
    _persist_chat_users(users)

    token = _create_jwt(user_id, email, payload.name.strip())
    return {
        "user": {"id": user_id, "email": email, "name": payload.name.strip()},
        "token": token,
    }


# ═══ POST /api/v1/auth/login ═══

@app.post("/api/v1/auth/login")
def auth_login(payload: LoginPayload) -> Dict[str, Any]:
    _ensure_chat_data()
    users = _chat_users_store()

    email = payload.email.lower().strip()
    for uid, u in users.items():
        if u.get("email") == email:
            if _verify_password(payload.password, u.get("password_hash", "")):
                token = _create_jwt(uid, u["email"], u.get("name", ""))
                return {
                    "user": {"id": uid, "email": u["email"], "name": u.get("name", "")},
                    "token": token,
                }

    raise HTTPException(status_code=401, detail="Invalid email or password, pilgrim")


# ═══ GET /api/v1/chat/conversations ═══

@app.get("/api/v1/chat/conversations")
def chat_conversations() -> Dict[str, Any]:
    _ensure_chat_data()
    convs = _conversations_store()
    sorted_convs = sorted(
        convs.values(),
        key=lambda c: c.get("updated_at", c.get("created_at", "")),
        reverse=True,
    )
    return {"conversations": sorted_convs}


# ═══ GET /api/v1/chat/conversation/{conversation_id} ═══

@app.get("/api/v1/chat/conversation/{conversation_id}")
def chat_conversation(conversation_id: str) -> Dict[str, Any]:
    _ensure_chat_data()
    convs = _conversations_store()
    conv = convs.get(conversation_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conv


# ═══ Serve Chat UI (SPA) ═══

CHAT_DIST = ROOT / "chat-ui" / "dist"

@app.get("/chat")
@app.get("/chat/{full_path:path}")
async def serve_chat_spa(full_path: str = ""):
    if full_path and (CHAT_DIST / full_path).is_file():
        return FileResponse(CHAT_DIST / full_path)
    return FileResponse(CHAT_DIST / "index.html")


# ═══ Analytics endpoints ═══

@app.post("/api/v1/analytics/events")
def analytics_post_event(payload: AnalyticsEventPayload) -> Dict[str, Any]:
    """Accept a client-side analytics event and persist it."""
    event_id = log_event(
        event_type=payload.event_type,
        payload=payload.payload,
        session_id=payload.session_id,
        user_id=payload.user_id,
        path=payload.path,
        source=payload.source or "client",
    )
    return {"accepted": True, "event_id": event_id}


@app.get("/api/v1/analytics/summary")
def analytics_summary() -> Dict[str, Any]:
    """Return summary statistics from stored analytics events."""
    return compute_summary()
