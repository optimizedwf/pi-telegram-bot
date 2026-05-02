# Mr Chow — Memory for @hog_cranker (1340648617)
Last updated: 2026-05-02

## Who I Am / Role
- Mr Chow = Adam's primary 24/7 server agent + system orchestrator.
- Primary runtime host: Azure `20.122.197.143` (`rico-prod-vm`).

## Operating Oath
- Tell Adam true state; never fake completion. Uptime first.

## Core Paths
- `~/pi-telegram-bot/` · `~/trenchfeed-trader/` · `/backup/cua-selfhost/`

## Current Model & Framework
- Framework: `@mariozechner/pi-coding-agent` 0.71.0
- Model: `gpt-5.5`, Thinking: `xhigh` (~32k tokens)

## Porkbun · Dell/Hector · War Room · Dark Factory · Rico · BearingBrain
- Unchanged from previous entries.

## Catholic Marketplace — LIVE (2026-05-02)
- **Location:** `~/pi-telegram-bot/factory/projects/catholic-shop/`
- **PM2:** `catholic-shop-demo` (FastAPI :8110), `catholic-concierge` (PI :8112)
- **Public:** `http://40.75.10.4/catholic-shop/chat` · `http://40.75.10.4/catholic-shop/`

### STATE: ALL 21 PRODUCTS VERIFIED
- 21/21 images load from real Shopify CDNs
- 21/21 buy URLs point to actual shop product pages
- 21/21 prices verified against live shop data
- 7 shops, 6 pilgrimage destinations
- Static files mounted at `/static/` for local images

### DESTINATION IMAGES
6 pilgrimage destination chips now show real photos:
- Jerusalem: Church of the Holy Sepulchre (Wikimedia)
- Assisi: Basilica of St. Francis (Wikimedia)
- Kraków: Divine Mercy image painting (local)
- Lourdes: Sanctuary basilica (Wikimedia)
- Fátima: Sanctuary of Fátima (Wikimedia)
- Guadalupe: Basilica of Our Lady of Guadalupe (local)

### DIRECT-TO-SHOP CHECKOUT
Every product has "Buy from [Shop Name]" button → opens actual shop page in new tab.
Order intents tracked in DB. No Stripe needed.

### AFFILIATE OPPORTUNITIES (not yet joined)
Rugged Rosaries (Rakuten) · Catholically (Rakuten) · Brick House (Awin) · Catholic Company (CJ/Impact)

### DATABASE
SQLite WAL mode, `data/catholic_shop.db`. Columns: buy_url, affiliate_program, affiliate_id.

### BUILD WAVES: ALL COMPLETE
Lane A (analytics) · B (storefront) · C (SQLite) · D (concierge eval) · E (real shops)
+ Image fixes · Buy URL wiring · Static files · Destination images

## PM2 Processes
`chow`, `partsbrain`, `catholic-shop-demo`, `catholic-concierge`, `rico-v3-shadow`, `rico-dashboard`, `rico-trenchfeed`, `trench-chart-bridge`, `trench-chart-ui`, `adam-landing`, `relay`, `agent-os-api`, `chow-heartbeat`, `energy-zillow-demo`, `john-assistant`
