[2026-04-16] Recovered phone-only Azure access in Termius for `rico-prod-vm` (`20.122.197.143`) by diagnosing failed SSH auth (wrong username) and adding the Termius-generated key’s public key to `~/.ssh/authorized_keys` for user `ubuntu` (fingerprint `SHA256:TTrwnFRlymxuuHbBGdOPDonBvGTMoS8rTotPvSdgeWs`); user confirmed login.
- Confirmed AWS extraction is blocked right now: from Azure, SSH/22 to `3.142.111.235` and `18.117.162.164` remains unreachable/filtered, so full AWS data pull is pending account/access restoration.
- Investigated requested YouTube “dark factory” learning flow: direct transcript/video scraping from cloud IP was bot-blocked (YouTube anti-bot/sign-in gating), but extracted video description and mapped core dark-factory loop (governance → triage → implement PRs → independent validation → cron/orchestration) and referenced Archon workflows.
- Built and deployed a new BOBO community one-page site (memecoin style) with live DexScreener snapshot, contract/pair copy buttons, and CTA links; files created at `/home/ubuntu/www-static/bobo/{index.html,styles.css,app.js}` and deployed to `/var/www/bobo`.
- Wired Caddy routes for BOBO under existing domains at `/bobo`, then added a domain-independent direct-IP route so the site is accessible at `http://20.122.197.143/` and `http://20.122.197.143/bobo` per user request not to use `adamn.info`/`optimizedworkflow.dev`.
- Added BOBO token specifics from DexScreener: pair `CAykjjzuNcf1DKgA3ShJ1ihkzvF3eh5x1MYU5uhcYioP`, base token CA `FwkiT2Hbh2Gp1ffJFnPckg4bWgw6evuW3yVfpVo8FSYs`, social `https://x.com/bobo_sol_og`, Jupiter swap link for SOL→token.
- User provided BOBO PFP image; integrated into site as `/bobo/bobo-pfp.jpg` in hero and OG image metadata; deployed and verified image serves over direct IP.
- Diagnosed why file/photo handling felt wrong: current bot behavior only had placeholder handling for photos and no document handler in `src/bot.ts`; started patching to cache incoming media/files into `media-cache/<chatId>/...` and pass exact cached file paths into prompt context (work in progress at session end).
- Memory file `/home/ubuntu/pi-telegram-bot/memory/1340648617/identity.md` was updated throughout with access recovery, BOBO deployment/direct IP route, YouTube transcript/quota blocker, and user preference for phone-only workflows.

---

[2026-05-02] Evaluated major open-source chat UIs (Chatbot UI, LibreChat, Open WebUI) and rejected all of them — Chatbot UI has 33 Supabase files too deeply coupled, LibreChat uses MongoDB with 426 open issues, Open WebUI is a 363MB Docker monolith. Decided to build the chat interface from best primitives instead of cloning: Vercel AI SDK (useChat hook for SSE streaming), shadcn/ui (same Radix components Chatbot UI uses but no database lock-in), Zustand for state, Tailwind with Scriptorium design tokens. Saved final architecture plan to spec/chat-architecture-final-2026-05-01.md. Scaffolded complete React + Vite + TypeScript chat-ui project with 5 components (Chat.tsx with SSE streaming, ProductCard.tsx with inline cart, QuickActions.tsx with 8 occasion chips, ConversationList.tsx sidebar, CartDrawer.tsx with quantity controls and Stripe checkout). Built full Zustand store (auth with JWT + localStorage persistence, chat with multi-turn conversations, cart with add/remove/quantity). Applied Scriptorium theme: parchment/ink/gold Tailwind palette, Cormorant Garamond/Cinzel/Lora fonts, noise texture backgrounds. Production build passes clean at 207KB JS + 19KB CSS. Adam requested maximum thinking depth on the DeepSeek model — changed defaultThinkingLevel from "high" (~16k tokens) to "xhigh" (~32k tokens) in pi-session.ts, rebuilt and restarted the chow PM2 process. Chat frontend is complete but the FastAPI /api/v1/chat/send endpoint with SSE streaming has not been wired yet — the PI concierge on port 8112 needs upgrading to handle multi-turn streaming with structured product_card outputs.

---

[2026-05-02] Redesigned Catholic shop chat to eliminate "AI slop" aesthetics — removed message bubbles, flattened layout to transcript style with gold left borders on AI text and right-aligned bold user text. Fixed four bugs: product cards=0 on first message (shouldShowProducts wasn't checking the current message), sidebar/cart Escape key handler missing, CartDrawer had hardcoded localhost:8110 URL, and emojis in UI replaced with SVG icons from Icon.tsx.

[2026-05-02] Fixed Safari iPhone "squirmy" layout — replaced 100vh with dvh dynamic viewport height, added interactive-widget=resizes-content meta tag, locked header/chip-row/input to shrink-0, switched scroll to instant behavior during streaming, added userScrolledUp guard to avoid yanking the view away from reading, and prevented iOS textarea zoom with 16px font-size on touch devices.

[2026-05-02] Fixed product image pipeline — compactCatalog (JS in pi-concierge) and _compact_catalog (Python in app.py) were both stripping image_url, shop, shop_id, and destination fields. All 18 products now display their actual Wikimedia images instead of the same Unsplash placeholder. toFrontendProduct updated to use the passed-through fields.

[2026-05-02] Added cart persistence via Zustand persist middleware (key: catholic-chat-cart). Cart survives page refresh. Created favicon.svg (gold cross on parchment square). Stripe checkout code confirmed complete but deliberately not wired — no real inventory to ship yet.

[2026-05-02] Wired conversation persistence — frontend fetches GET /api/v1/chat/conversations on mount, maps backend format (snake_case, ISO timestamps) to frontend Conversation type, sets most recent as active. Backend chat_send now captures SSE text events during streaming and saves both user and assistant messages to the JSON conversation store. Build is 219KB JS + 17KB CSS, zero console errors, all endpoints verified 200.

---

[2026-05-02] Redesigned Catholic shop chat UI to eliminate "AI slop" aesthetic — removed message bubbles entirely, user messages right-aligned bold, AI messages with subtle gold left border accent (no backgrounds). Welcome screen flows as text with inline chips instead of centered modal.

Fixed critical bug where product cards never appeared on first message — shouldShowProducts() only checked context history (empty on message 1), never checked the actual user message. Also fixed conversation persistence by capturing assistant text from SSE stream in FastAPI event_stream and saving to conversation store.

Fixed CartDrawer hardcoded localhost:8110 API_BASE, replaced all remaining emojis in UI (📿, 📍, ✕, ✚) with SVG Icon components, added Escape key handlers for sidebar and cart drawer closures.

Safari iPhone hardening: replaced 100vh with dvh + -webkit-fill-available, added viewport-fit=cover and interactive-widget=resizes-content meta tags, used overscroll-contain and instant scroll (not smooth) during streaming to prevent layout jitter, prevented iOS textarea zoom with 16px font on iOS.

Pipeline fix: three places stripped image_url — _compact_catalog (Python), compactCatalog (JS), extractMatchingProducts (JS). All now pass image_url, shop, shop_id, and destination end-to-end. Products now display real Wikimedia images instead of Unsplash placeholder.

Added Zustand persist middleware to cart store (localStorage key: catholic-chat-cart), created gold cross favicon SVG, wired GET /api/v1/chat/conversations on frontend mount to load saved conversations with proper ISO timestamp mapping.

Stripe checkout code is complete and ready but intentionally not wired — Adam doesn't want live payment until real products exist to ship. Current state: chat fully functional at http://40.75.10.4/catholic-shop/chat with 219KB JS + 17KB CSS, zero console errors, zero emojis in UI.

---

[2026-05-02] Fixed all 21 product images by re-scraping real Shopify product.json APIs for Brick House, Catholically, Monastery Greetings, Rugged Rosaries, and Catholic Company — replaced broken/guessed image URLs with actual CDN URLs. Verified all 21 prices against live shop data (all correct). Updated buy_urls to correct product handles where mismatched. Added destination images to the Pilgrimage browse chips — 6 holy site photos (Church of the Holy Sepulchre, St. Francis Basilica, Divine Mercy painting, Lourdes Sanctuary, Fátima Sanctuary, Guadalupe Basilica) from Wikimedia Commons and local cache. Mounted FastAPI StaticFiles at /static/ for serving local images through Caddy. Saved PM2 process list before impending VM restart for disk expansion. All 21 images, 21 buy URLs, and 21 prices now verified and working at http://40.75.10.4/catholic-shop/.
