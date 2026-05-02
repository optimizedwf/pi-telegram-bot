# Mr Chow — Core Identity & Memory

## Identity
- Name: Mr Chow
- Role: coding/research/operator assistant in Telegram bot
- Scope rule: Chow and Jose are separate; never repoint Chow when troubleshooting Jose

## Company Progress (2026-05-02)
- Phase 1: DONE — 6 repos pushed to github.com/BAGWATCHER
- Phase 2: 70% — agent fabric live (heartbeat, queue, dashboard), blocked on Dell SSH activation
- Phase 3-5: pending

### Agent OS v1.1
- Path: `/home/ubuntu/agent-os/`
- PM2: `agent-os-api` (8200), `chow-heartbeat`
- Endpoints: GET/POST registry, heartbeat, queue, agent status, task dispatch/complete
- Dashboard: `http://40.75.10.4/agent-os/` — live heartbeat + queue per agent
- Chow SSH key for Dell: `~/.ssh/chow_hector_ed25519`
- Reverse SSH tunnel from Dell: `localhost:2222` (authentication blocked)
- Dell needs: `sudo apt install openssh-server -y && sudo systemctl enable --now ssh` + add chow key to authorized_keys

## Active Projects

### BearingBrain / PartsBrain
- Path: `/home/ubuntu/partsbrain` (web: `/home/ubuntu/partsbrain/web`)
- Stack: Next.js 16 + TypeScript + Postgres/pgvector + Docker
- PM2: `partsbrain` (3001), domain `https://bearingbrain.com`
- DB: `partsbrain-db` (`partsbrain/partsbrain/partsbrain_dev_pw`)
- UI rules: warm paper `#f9f7f4`, text `#1a1a1a`, brown `#7a3b10`, link blue `#2e5ea3`
- Scale: ~31,702 parts, ~25,718 cross-refs, ~31,767 sitemap URLs
- External API: `/api/v1/{capabilities,search,stats,feeds/health,quotes,agentic/checkout-intents}`
- OAuth/MCP/developer onboarding scaffolds live

### DemandGrid
- Path: `/home/ubuntu/pi-telegram-bot/factory/projects/energy-zillow`
- PM2: `energy-zillow-demo` (`127.0.0.1:8099`)
- Public: `http://20.122.197.143/energy-zillow/`
- Board: 64 ZIPs, 66,941 scored sites, 1,000 H3 cells
- Lanes EZ-001..EZ-028, DG-001..DG-011 shipped; eval PASS

### Catholic Shop
- Path: `/home/ubuntu/pi-telegram-bot/factory/projects/catholic-shop`
- PM2: `catholic-shop-demo`, `catholic-concierge`
- Public: `/catholic-shop/` + `/catholic-shop/ops`
- Lanes CS-001..CS-018 shipped; eval PASS 9/9
- Stripe: restricted live key at `/home/ubuntu/.chow-secrets/stripe.env`

### Rico (trading)
- Path: `/home/ubuntu/trenchfeed-trader`
- PM2: `rico-v3`, `rico-trenchfeed`, `rico-dashboard`, `rico-chart-ui`, `rico-chart-bridge`

## Server / Infra
- Host: Azure `40.75.10.4`, Ubuntu 22.04, SSH key `~/.ssh/azure_rico_key`
- PM2 core: partsbrain, rico-*, chow, hive, relay, energy-zillow-demo, catholic-shop-demo, catholic-concierge, agent-os-api, chow-heartbeat, adam-landing
- Caddy reverse proxy for all web services
- Secrets: `/home/ubuntu/.chow-secrets/` (Cloudflare, Porkbun, Stripe), `/home/ubuntu/.vault/keys/` (GitHub PAT)
- Archon CLI v0.3.6; Pi `openai-codex/gpt-5.4`; Bun installed
- Dell console: RDP via XRDP+XFCE, user `rdpuser`, NSG allowlist `38.7.155.99/32`

## User Preferences
- Fast, direct, action-first; low hype
- AI-first engineering by default (agentic, automated, not manual)
- Dark-factory parallel lanes for throughput
- DemandGrid → most advanced AI sales system across verticals
- Catholic Shop: mobile-first, clean UI, no nested boxes
