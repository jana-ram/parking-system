#!/usr/bin/env bash
# Deploys the backend + owner-web to /srv/smart-parking on this host. Run on
# the VPS itself (as the smart-parking deploy user), not on a dev machine —
# it resets each repo's working tree to origin/main, which is exactly what a
# deploy target should do and exactly what you don't want on a dev checkout.
#
# Usage: infra/deploy.sh
# Assumes infra/provision.sh has already run once on this host (Node, PM2,
# MongoDB replica set, nginx sites, /srv/smart-parking layout all in place).
set -euo pipefail

# backend/ and owner-web/ are subdirectories of one repo (parking-system) —
# a single clone at REPO_DIR, fetched/reset once, not two separate repos.
REPO_DIR="/srv/smart-parking/parking-system"
BACKEND_DIR="$REPO_DIR/backend"
OWNER_WEB_DIR="$REPO_DIR/owner-web"

log() { echo "[deploy] $1"; }

log "Fetching origin/main..."
git -C "$REPO_DIR" fetch origin main
git -C "$REPO_DIR" reset --hard origin/main

deploy_backend() {
  if [ ! -f "$BACKEND_DIR/.env" ]; then
    echo "[deploy] ERROR: $BACKEND_DIR/.env is missing. Copy from .env.example and fill in real secrets before deploying." >&2
    exit 1
  fi

  log "Backend: npm ci (production deps only)..."
  (cd "$BACKEND_DIR" && npm ci --omit=dev)

  log "Backend: verifying model indexes build cleanly against the live DB..."
  (cd "$BACKEND_DIR" && NODE_ENV=production node -e "
    require('dotenv').config();
    const { connectDb } = require('./src/config/db');
    require('./src/server');
    connectDb().then(() => { console.log('index check OK'); process.exit(0); })
      .catch((e) => { console.error(e); process.exit(1); });
  ")

  log "Backend: reloading via PM2 (zero-downtime)..."
  pm2 startOrReload "$REPO_DIR/infra/ecosystem.config.js" --env production
}

deploy_owner_web() {
  log "owner-web: npm ci + build..."
  (cd "$OWNER_WEB_DIR" && npm ci && npm run build)
  # dist/ is what nginx serves directly (infra/nginx/owner-web.conf) — no
  # process to restart, nginx just picks up the new files on the next request.
}

deploy_backend
deploy_owner_web

log "Reloading nginx (picks up any config changes)..."
sudo nginx -t && sudo systemctl reload nginx

log "Done. pm2 status:"
pm2 status
