#!/bin/bash
# Budget app: one-shot server setup for an Oracle Cloud Always Free VM (Ubuntu 22.04/24.04, Arm or AMD).
# Paste this whole file into "Show advanced options -> Management -> Initialization script" when
# creating the instance. Fill in the values below first. They stay on your VM; never share them.
#
# After about 10 minutes the app is live at https://<your-public-ip-with-dashes>.sslip.io
# (for example 129.146.10.20 -> https://129-146-10-20.sslip.io). Setup log: /var/log/budget-setup.log

# ======================= fill these in =======================
REPO_URL="${REPO_URL:-https://github.com/RodHH/budget-app.git}"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"        # only if the repo is private: a fine-grained, read-only "Contents" token
SETUP_CODE="${SETUP_CODE:-}"          # make one up (8+ characters); you type it once to create your login
NOTIFY_EMAIL="${NOTIFY_EMAIL:-}"        # your email; Apple requires a contact address for push notifications
PLAID_ENV="${PLAID_ENV:-sandbox}"    # sandbox now; production later for real banks
PLAID_CLIENT_ID="${PLAID_CLIENT_ID:-}"     # optional now, can be added later with: sudo budget-config KEY=value
PLAID_SECRET="${PLAID_SECRET:-}"
# =============================================================

set -euo pipefail
exec > >(tee -a /var/log/budget-setup.log) 2>&1
echo "== budget setup started $(date -u)"
export DEBIAN_FRONTEND=noninteractive

if [ -z "$SETUP_CODE" ]; then SETUP_CODE=$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n' | tr a-f A-F); fi

# --- small servers (E2.1.Micro has 1 GB): add 2 GB swap so the build doesn't run out of memory
if [ "$(awk '/MemTotal/{print $2}' /proc/meminfo)" -lt 2000000 ] && [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi

# --- packages: Node 22, git, Caddy (automatic HTTPS), firewall persistence
apt-get update -y
apt-get install -y ca-certificates curl git gnupg iptables-persistent debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt >/etc/apt/sources.list.d/caddy-stable.list
apt-get update -y
apt-get install -y caddy
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
node --version

# --- open ports 80/443 in the VM's own firewall (Oracle images block them by default).
# You also need the matching Ingress rules in the VCN security list (see ORACLE.md).
iptables -I INPUT 1 -p tcp -m multiport --dports 80,443 -m conntrack --ctstate NEW -j ACCEPT
netfilter-persistent save

# --- public address via sslip.io (free DNS name that points at your IP)
IP=$(curl -fsS --max-time 10 https://ifconfig.me || curl -fsS --max-time 10 https://api.ipify.org)
HOSTNAME_PUBLIC="$(echo "$IP" | tr . -).sslip.io"
PUBLIC_URL="https://$HOSTNAME_PUBLIC"

# --- app user, code, build
id budget >/dev/null 2>&1 || useradd --system --create-home --home-dir /opt/budget --shell /usr/sbin/nologin budget
CLONE_URL="$REPO_URL"
if [ -n "$GITHUB_TOKEN" ]; then CLONE_URL="${REPO_URL/https:\/\//https://x-access-token:${GITHUB_TOKEN}@}"; fi
rm -rf /opt/budget/app
git clone --depth 1 "$CLONE_URL" /opt/budget/app
git -C /opt/budget/app remote set-url origin "$REPO_URL"   # don't leave the token in git config
cd /opt/budget/app
npm ci --no-audit --no-fund
node scripts/build.mjs
npm prune --omit=dev --no-audit --no-fund
mkdir -p /opt/budget/data

cat >/opt/budget/app/.env <<ENV
PUBLIC_URL=$PUBLIC_URL
HOST=127.0.0.1
PORT=8080
DATA_DIR=/opt/budget/data
TRUST_PROXY=1
SETUP_CODE=$SETUP_CODE
VAPID_SUBJECT=mailto:${NOTIFY_EMAIL:-owner@example.com}
PLAID_ENV=$PLAID_ENV
PLAID_CLIENT_ID=$PLAID_CLIENT_ID
PLAID_SECRET=$PLAID_SECRET
PLAID_REDIRECT_URI=$PUBLIC_URL/oauth-return
ENV
chmod 600 /opt/budget/app/.env
chown -R budget:budget /opt/budget

# --- run the app as a service
cat >/etc/systemd/system/budget.service <<'UNIT'
[Unit]
Description=Budget app
After=network-online.target
Wants=network-online.target

[Service]
User=budget
WorkingDirectory=/opt/budget/app
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning server/index.js
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/budget/data
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

# --- HTTPS in front of it
# Caddy gets a certificate from Let's Encrypt and falls back to ZeroSSL automatically.
cat >/etc/caddy/Caddyfile <<CADDY
{
  email ${NOTIFY_EMAIL:-owner@example.com}
}
$HOSTNAME_PUBLIC {
  encode gzip
  reverse_proxy 127.0.0.1:8080
}
CADDY

# --- helper: sudo budget-config KEY=value [KEY=value ...]   (edits .env and restarts)
#             sudo budget-update                             (pulls new code, rebuilds, restarts)
cat >/usr/local/bin/budget-config <<'HELPER'
#!/bin/bash
set -euo pipefail
ENVF=/opt/budget/app/.env
[ $# -gt 0 ] || { grep -vE 'SECRET|SETUP_CODE' "$ENVF"; exit 0; }
for kv in "$@"; do
  k="${kv%%=*}"; v="${kv#*=}"
  [[ "$k" =~ ^[A-Z0-9_]+$ ]] || { echo "bad key: $k"; exit 1; }
  grep -v "^$k=" "$ENVF" > "$ENVF.tmp" || true
  echo "$k=$v" >> "$ENVF.tmp"
  mv "$ENVF.tmp" "$ENVF"
done
chown budget:budget "$ENVF"; chmod 600 "$ENVF"
systemctl restart budget
echo "Saved and restarted."
HELPER
cat >/usr/local/bin/budget-update <<'HELPER'
#!/bin/bash
set -euo pipefail
cd /opt/budget/app
sudo -u budget git pull --ff-only
sudo -u budget npm ci --no-audit --no-fund
sudo -u budget node scripts/build.mjs
sudo -u budget npm prune --omit=dev --no-audit --no-fund
systemctl restart budget
echo "Updated."
HELPER
chmod 755 /usr/local/bin/budget-config /usr/local/bin/budget-update

systemctl daemon-reload
systemctl enable --now budget
systemctl restart caddy

echo "$PUBLIC_URL" >/opt/budget/URL.txt
echo "== budget setup finished $(date -u): $PUBLIC_URL"
