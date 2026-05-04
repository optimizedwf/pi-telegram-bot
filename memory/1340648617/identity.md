# Mr Chow — Memory for @hog_cranker (1340648617)
Last updated: 2026-05-04

## Who I Am / Role
- Mr Chow = Adam's primary 24/7 server agent + system orchestrator.
- Primary runtime host: Azure `20.122.197.143` (`rico-prod-vm`).

## Operating Oath
- Tell Adam true state; never fake completion. Uptime first.

## Core Paths
- `~/pi-telegram-bot/` · `~/trenchfeed-trader/` · `~/chow-video-studio/`

## Current Model & Framework
- Framework: `@mariozechner/pi-coding-agent` 0.71.0
- Model: `gpt-5.5`, Thinking: `xhigh` (~32k tokens)

## Porkbun · Dell/Hector · War Room · Dark Factory · Rico · BearingBrain
- Unchanged from previous entries.

## Catholic Marketplace — LIVE (2026-05-02)
- **Location:** `~/pi-telegram-bot/factory/projects/catholic-shop/`
- **PM2:** `catholic-shop-demo` (FastAPI :8110), `catholic-concierge` (PI :8112)
- **Public:** `http://40.75.10.4/catholic-shop/chat` · `http://40.75.10.4/catholic-shop/`
- **21 products, 7 shops, 6 pilgrimage destinations**
- All product images from Shopify CDNs, all buy URLs verified
- SSE streaming fixed (Caddy `flush_interval -1`)
- Cart persistence via Zustand + localStorage
- Conversation persistence via JSON store
- Affiliate programs not yet joined (CJ rejected, Rakuten + Awin pending)

## Chow Video Studio — Catholic Intro Video (2026-05-04)
- **Location:** `~/chow-video-studio/`
- **Composition:** `CatholicIntro` — 30s TikTok intro for Catholic Marketplace
- **Specs:** 1080×1920 @ 30fps, ~2.8MB MP4
- **Scenes:** MapScene → ProductShowcase → ChatDemo → CtaScene
- **Design:** Scriptorium theme (parchment/ink/gold, Cinzel + Cormorant Garamond)
- **Features:**
  - SVG world map continents with glowing destination dots
  - Real Shopify product photos (Rugged Rosaries, Catholically, Brick House)
  - Simulated concierge chat with product cards
  - 6 destination photo thumbnails in CTA grid
  - Ambient C drone background music (ffmpeg-generated)
- **Missing:** ElevenLabs voiceover (needs API key)
- **Preview:** `http://40.75.10.4/videos/preview.html`
- **Git:** committed as `26c66d4` on main
- **Dependencies:** @remotion/transitions, @remotion/google-fonts

## PM2 Processes
`chow`, `partsbrain`, `catholic-shop-demo`, `catholic-concierge`, `rico-v3-shadow`, `rico-dashboard`, `rico-trenchfeed`, `trench-chart-bridge`, `trench-chart-ui`, `adam-landing`, `relay`, `agent-os-api`, `chow-heartbeat`, `energy-zillow-demo`, `john-assistant`

## Recent Conversation Summaries (auto-managed, last 5)

[2026-05-02] Redesigned Catholic shop chat to eliminate "AI slop" aesthetics — removed message bubbles, flattened layout to transcript style with gold left borders on AI text and right-aligned bold user text. Fixed four bugs: product cards=0 on first message (shouldShowProducts wasn't checking the current message), sidebar/cart Escape key handler missing, CartDrawer had hardcoded localhost:8110 URL, and emojis in UI replaced with SVG icons from Icon.tsx.

[2026-05-02] Fixed Safari iPhone "squirmy" layout — replaced 100vh with dvh dynamic viewport height, added interactive-widget=resizes-content meta tag, locked header/chip-row/input to shrink-0, switched scroll to instant behavior during streaming, added userScrolledUp guard to avoid yanking the view away from reading, and prevented iOS textarea zoom with 16px font-size on touch devices.

[2026-05-02] Fixed product image pipeline — compactCatalog (JS in pi-concierge) and _compact_catalog (Python in app.py) were both stripping image_url, shop, shop_id, and destination fields. All 18 products now display their actual Wikimedia images instead of the same Unsplash placeholder. toFrontendProduct updated to use the passed-through fields.

[2026-05-02] Added cart persistence via Zustand persist middleware (key: catholic-chat-cart). Cart survives page refresh. Created favicon.svg (gold cross on parchment square). Stripe checkout code confirmed complete but deliberately not wired — no real inventory to ship yet.

[2026-05-02] Wired conversation persistence — frontend fetches GET /api/v1/chat/conversations on mount, maps backend format (snake_case, ISO timestamps) to frontend Conversation type, sets most recent as active. Backend chat_send now captures SSE text events during streaming and saves both user and assistant messages to the JSON conversation store. Build is 219KB JS + 17KB CSS, zero console errors, all endpoints verified 200.

---

[2026-05-02] Redesigned Catholic shop chat UI to eliminate "AI slop" aesthetic — removed message bubbles entirely, user messages right-aligned bold, AI messages with subtle gold left border accent (no backgrounds). Welcome screen flows as text with inline chips instead of centered modal. Fixed critical bug where product cards never appeared on first message. Fixed CartDrawer hardcoded localhost:8110 API_BASE. Safari iPhone hardening: dvh viewport, overscroll-contain, instant scroll during streaming, iOS textarea zoom fix.

[2026-05-02] Fixed all 21 product images by re-scraping real Shopify product.json APIs for Brick House, Catholically, Monastery Greetings, Rugged Rosaries, and Catholic Company — replaced broken/guessed image URLs with actual CDN URLs. Verified all 21 prices against live shop data (all correct). Added destination images to the Pilgrimage browse chips — 6 holy site photos from Wikimedia Commons and local cache. Mounted FastAPI StaticFiles at /static/ for serving local images through Caddy.

[2026-05-02] Evaluated major open-source chat UIs (Chatbot UI, LibreChat, Open WebUI) and rejected all of them — Chatbot UI has 33 Supabase files too deeply coupled, LibreChat uses MongoDB with 426 open issues, Open WebUI is a 363MB Docker monolith. Decided to build the chat interface from best primitives instead: Vercel AI SDK, shadcn/ui, Zustand, Tailwind with Scriptorium design tokens.

[2026-05-02] Catholic shop chat redesigned to eliminate "AI slop" aesthetics — removed message bubbles, flattened layout. Fixed bugs: product cards on first message, sidebar/cart Escape key, CartDrawer URL, emojis removed.

[2026-05-04] Built Catholic Marketplace intro video in Remotion (chow-video-studio). 30-second TikTok vertical (1080x1920). Four scenes: animated world map with continents + destination dots, product showcase with real Shopify images, concierge chat demo, CTA with cross logo + destination thumbnails. Scriptorium theme. Ambient C drone audio. Committed as 26c66d4. Voiceover pending ElevenLabs API key.
