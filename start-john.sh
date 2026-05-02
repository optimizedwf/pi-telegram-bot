#!/bin/bash
set -a
source /home/ubuntu/pi-telegram-bot/.env          # base config
source /home/ubuntu/pi-telegram-bot/.env.john     # John overrides
set +a

export PATH=/home/ubuntu/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:$PATH
export NODE_PATH=/home/ubuntu/.npm-global/lib/node_modules

# Ensure John has Codex auth
python3 /home/ubuntu/pi-telegram-bot/scripts/rebuild_pi_auth_from_codex.py >/dev/null 2>&1 || true

cd /home/ubuntu/pi-telegram-bot
exec npx tsx src/bot.ts
