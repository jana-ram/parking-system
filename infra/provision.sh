#!/usr/bin/env bash
# Fresh-VPS bootstrap for the Smart Parking OS backend + owner-web dashboard.
# Target: a clean Ubuntu 22.04 LTS host, run as a sudo-capable user.
#
# What this script automates end-to-end, no manual steps: OS packages, Node,
# MongoDB (single-node replica set — required for the transactional writes,
# see backend/README.md), PM2, nginx site configs, firewall rules, cloning
# the repo, generating strong random secrets for anything that doesn't need
# a human-chosen value, and running the first deploy.
#
# What is deliberately left as one manual step at the end, and why: TLS
# certificate issuance via certbot. Let's Encrypt validates domain ownership
# by making an HTTP request to the hostname you're requesting a cert for —
# that only succeeds once your DNS A/AAAA records already point at this
# server's IP, which this script has no way to verify or wait for safely.
# Scripting past that would either silently skip TLS or hang indefinitely on
# a network condition outside this host's control.
#
# Usage:
#   REPO_URL=https://github.com/jana-ram/parking-system.git \
#   API_HOSTNAME=api.example.com \
#   ADMIN_HOSTNAME=admin.example.com \
#   ./provision.sh
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/jana-ram/parking-system.git}"
API_HOSTNAME="${API_HOSTNAME:-api.example.com}"
ADMIN_HOSTNAME="${ADMIN_HOSTNAME:-admin.example.com}"
DEPLOY_USER="${DEPLOY_USER:-smartparking}"
REPO_DIR="/srv/smart-parking/parking-system"

log() { echo "[provision] $1"; }

if [ "$EUID" -eq 0 ]; then
  echo "Run as a sudo-capable non-root user, not directly as root." >&2
  exit 1
fi

# ── OS packages ─────────────────────────────────────────────────────────
log "Updating apt and installing base packages..."
sudo apt-get update -y
sudo apt-get install -y curl git build-essential gnupg ufw nginx

# ── Node.js 20 (NodeSource) ────────────────────────────────────────────
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  log "Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

# ── PM2 ─────────────────────────────────────────────────────────────────
if ! command -v pm2 >/dev/null; then
  log "Installing PM2..."
  sudo npm install -g pm2
fi

# ── MongoDB 7, configured as a single-node replica set ─────────────────
# A standalone mongod cannot run the multi-document transactions this app
# depends on for every entry/exit/shift-close write (§1.1) — a single-node
# replica set is the smallest configuration that supports them.
if ! command -v mongod >/dev/null; then
  log "Installing MongoDB 7..."
  curl -fsSL https://pgp.mongodb.com/server-7.0.asc | sudo gpg --dearmor -o /usr/share/keyrings/mongodb-server-7.0.gpg
  echo "deb [signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/7.0 multiverse" | \
    sudo tee /etc/apt/sources.list.d/mongodb-org-7.0.list
  sudo apt-get update -y
  sudo apt-get install -y mongodb-org
fi

if ! grep -q "^replication:" /etc/mongod.conf; then
  log "Enabling replica set mode in /etc/mongod.conf..."
  echo -e "\nreplication:\n  replSetName: rs0" | sudo tee -a /etc/mongod.conf
fi
sudo systemctl enable mongod
sudo systemctl restart mongod
sleep 3
mongosh --quiet --eval "rs.status().ok" >/dev/null 2>&1 || mongosh --quiet --eval "rs.initiate()"
log "MongoDB replica set rs0 is up."

# ── certbot (for the manual TLS step later) ─────────────────────────────
sudo apt-get install -y certbot python3-certbot-nginx

# ── Firewall ─────────────────────────────────────────────────────────────
log "Configuring ufw (22, 80, 443)..."
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw --force enable

# ── Deploy user + directory layout ──────────────────────────────────────
if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  log "Creating deploy user '$DEPLOY_USER'..."
  sudo useradd -m -s /bin/bash "$DEPLOY_USER"
fi
sudo mkdir -p /srv/smart-parking /var/log/smart-parking
sudo chown -R "$DEPLOY_USER":"$DEPLOY_USER" /srv/smart-parking /var/log/smart-parking

# ── Clone the repo ───────────────────────────────────────────────────────
if [ ! -d "$REPO_DIR/.git" ]; then
  log "Cloning $REPO_URL..."
  sudo -u "$DEPLOY_USER" git clone "$REPO_URL" "$REPO_DIR"
else
  log "Repo already present at $REPO_DIR, skipping clone."
fi

# ── Backend .env: generate strong secrets for anything that doesn't need
#    a human-chosen value; require the operator to set the platform admin
#    credentials deliberately rather than accept a fixed default (server.js's
#    seedPlatformAdmin() refuses to seed at all in production without them).
BACKEND_ENV="$REPO_DIR/backend/.env"
if [ ! -f "$BACKEND_ENV" ]; then
  log "Generating $BACKEND_ENV with fresh random secrets..."
  GENERATED_ADMIN_PASSWORD="$(openssl rand -base64 24)"
  sudo -u "$DEPLOY_USER" bash -c "cat > '$BACKEND_ENV'" <<EOF
PORT=5100
NODE_ENV=production
MONGO_URI=mongodb://localhost:27017/smart_parking?replicaSet=rs0
JWT_SECRET=$(openssl rand -hex 32)
JWT_EXPIRE=12h
JWT_REFRESH_EXPIRE=30d
PLATFORM_JWT_SECRET=$(openssl rand -hex 32)
DEVICE_SECRET_ENC_KEY=$(openssl rand -hex 32)
ALLOWED_ORIGINS=https://${ADMIN_HOSTNAME}
PLATFORM_ADMIN_EMAIL=owner@${API_HOSTNAME#api.}
PLATFORM_ADMIN_PASSWORD=${GENERATED_ADMIN_PASSWORD}
EOF
  echo ""
  echo "=================================================================="
  echo " Generated platform admin credentials — save these now, they are"
  echo " only ever printed this one time:"
  echo "   email:    owner@${API_HOSTNAME#api.}"
  echo "   password: ${GENERATED_ADMIN_PASSWORD}"
  echo "=================================================================="
  echo ""
else
  log "$BACKEND_ENV already exists, leaving it untouched."
fi

# ── nginx sites ───────────────────────────────────────────────────────────
log "Installing nginx site configs for $API_HOSTNAME and $ADMIN_HOSTNAME..."
sed "s/api.example.com/${API_HOSTNAME}/" "$REPO_DIR/infra/nginx/backend.conf" | sudo tee /etc/nginx/sites-available/smart-parking-backend.conf >/dev/null
sed "s/admin.example.com/${ADMIN_HOSTNAME}/" "$REPO_DIR/infra/nginx/owner-web.conf" | sudo tee /etc/nginx/sites-available/smart-parking-owner-web.conf >/dev/null
sudo ln -sf /etc/nginx/sites-available/smart-parking-backend.conf /etc/nginx/sites-enabled/
sudo ln -sf /etc/nginx/sites-available/smart-parking-owner-web.conf /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

# ── First deploy ─────────────────────────────────────────────────────────
log "Running first deploy..."
sudo -u "$DEPLOY_USER" bash "$REPO_DIR/infra/deploy.sh"
sudo -u "$DEPLOY_USER" pm2 save
# pm2 startup prints a systemd command that must run as root once — surface
# it rather than silently trying to self-execute a copy-pasted sudo command.
sudo -u "$DEPLOY_USER" pm2 startup systemd -u "$DEPLOY_USER" --hp "/home/$DEPLOY_USER" | tail -1

echo ""
echo "=================================================================="
echo " Provisioning complete. Remaining manual steps:"
echo "  1. Point DNS A/AAAA records for $API_HOSTNAME and $ADMIN_HOSTNAME"
echo "     at this host's IP, and wait for propagation."
echo "  2. Run the 'sudo env PATH=... pm2 startup ...' command printed"
echo "     above (if any) so PM2 survives a reboot."
echo "  3. Once DNS resolves, issue TLS certificates:"
echo "       sudo certbot --nginx -d $API_HOSTNAME -d $ADMIN_HOSTNAME"
echo "  4. Save the platform admin credentials printed above, if this was"
echo "     a first-time .env generation."
echo "=================================================================="
