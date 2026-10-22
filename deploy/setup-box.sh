#!/usr/bin/env bash
# One-time setup of mailtrack on shotline-prod, run from your Mac:
#   bash deploy/setup-box.sh
# Sends one SSM command to the box that:
#   1. creates /var/www/mailtrack and its .env (Mongo URI copied from shotline's
#      backend .env on the box; session/encryption secrets generated there; Google
#      client id/secret read from this repo's local .env)
#   2. adds the nginx site for track.shotline.in (nginx -t before reload)
#   3. gets a Let's Encrypt cert with certbot --nginx
#   4. clones the (public) repo over HTTPS, builds it, starts pm2 app "mailtrack"
# Shotline's own nginx site, pm2 apps and .env files are not modified.
# Safe to re-run: an existing .env is left alone; the code is reset to origin/main.
set -euo pipefail
cd "$(dirname "$0")/.."

INSTANCE=i-02e37278036b76a67
REGION=ap-south-1
ID=$(grep '^GOOGLE_CLIENT_ID=' .env | cut -d= -f2-)
SEC=$(grep '^GOOGLE_CLIENT_SECRET=' .env | cut -d= -f2-)
EMAIL=$(grep '^ALLOWED_EMAIL=' .env | cut -d= -f2-)
[[ -n "$ID" && "$SEC" == GOCSPX-* && -n "$EMAIL" ]] || { echo "Google client id/secret or ALLOWED_EMAIL missing from .env" >&2; exit 1; }

PARAMS=$(mktemp)
trap 'rm -f "$PARAMS"' EXIT

ID="$ID" SEC="$SEC" EMAIL="$EMAIL" NGINX_FILE=deploy/nginx-track.shotline.in.conf python3 - "$PARAMS" <<'PYEOF'
import json, os, sys
nginx = open(os.environ['NGINX_FILE']).read()
script = r'''set -euo pipefail
install -d -o ubuntu -g ubuntu /var/www/mailtrack
if [ ! -f /var/www/mailtrack/.env ]; then
  MONGO=$(grep '^MONGODB_URI=' /var/www/shotline/backend/.env | head -1 | cut -d= -f2-)
  cat > /var/www/mailtrack/.env <<ENV
NODE_ENV=production
PORT=4100
PUBLIC_URL=https://track.shotline.in
MONGODB_URI=$MONGO
GOOGLE_CLIENT_ID=__ID__
GOOGLE_CLIENT_SECRET=__SEC__
ALLOWED_EMAIL=__EMAIL__
SESSION_SECRET=$(openssl rand -hex 32)
TOKEN_ENC_KEY=$(openssl rand -base64 32)
SELF_OPEN_GRACE_SEC=0
NOTIFY_ON_CLICK=true
NOTIFY_ON_OPEN=false
ENV
  chown ubuntu:ubuntu /var/www/mailtrack/.env
  chmod 600 /var/www/mailtrack/.env
  echo "[1] .env written"
else
  echo "[1] .env already exists, left alone"
fi
# 2026-10-22: the 60s "your Sent view" window hid real opens; turn it off on existing boxes.
sed -i 's/^SELF_OPEN_GRACE_SEC=60$/SELF_OPEN_GRACE_SEC=0/' /var/www/mailtrack/.env
# Gemini (Vertex): reuse shotline backend's Google workload-identity config.
if ! grep -q '^GOOGLE_APPLICATION_CREDENTIALS=' /var/www/mailtrack/.env; then
  CREDS=$(grep '^GOOGLE_APPLICATION_CREDENTIALS=' /var/www/shotline/backend/.env | head -1 || true)
  if [ -n "$CREDS" ]; then echo "$CREDS" >> /var/www/mailtrack/.env; echo "[1] Gemini credentials linked"; else echo "[1] WARNING: no GOOGLE_APPLICATION_CREDENTIALS in shotline backend .env; Gemini will be unavailable"; fi
fi

cat > /etc/nginx/sites-available/track.shotline.in <<'NGINX'
__NGINX__NGINX
ln -sf /etc/nginx/sites-available/track.shotline.in /etc/nginx/sites-enabled/track.shotline.in
nginx -t
systemctl reload nginx
echo "[2] nginx site added"

certbot --nginx -d track.shotline.in --non-interactive --agree-tos --redirect 2>&1 | tail -4
nginx -t && systemctl reload nginx
echo "[3] cert done"

sudo -u ubuntu -H bash -lc '
set -euo pipefail
cd /var/www/mailtrack
if [ ! -d .git ]; then git init -q -b main; git remote add origin https://github.com/mystry123/mailtrack.git; fi
git fetch -q origin
git checkout -q -B main origin/main
pnpm install --frozen-lockfile 2>&1 | tail -2
pnpm build 2>&1 | tail -2
if pm2 describe mailtrack >/dev/null 2>&1; then pm2 reload mailtrack --update-env; else pm2 start deploy/ecosystem.config.cjs; fi
pm2 save
for i in $(seq 1 20); do curl -fsS http://127.0.0.1:4100/health && echo && break; sleep 1; done
'
echo "[4] app started"
curl -s -o /dev/null -w 'https://track.shotline.in/app/: %{http_code}\n' https://track.shotline.in/app/ || true
curl -s -o /dev/null -w 'shotline.in still: %{http_code}\n' https://shotline.in/ || true
'''
script = script.replace('__ID__', os.environ['ID']).replace('__SEC__', os.environ['SEC']).replace('__EMAIL__', os.environ['EMAIL']).replace('__NGINX__', nginx)
# SSM runs commands with /bin/sh (dash), which lacks pipefail; hand the script
# to bash via a private temp file (not stdin, which pnpm etc. could swallow).
wrapped = (
    'f=$(mktemp)\n'
    "cat > \"$f\" <<'MAILTRACK_SCRIPT_EOF'\n" + script + '\nMAILTRACK_SCRIPT_EOF\n'
    'bash "$f"; rc=$?; rm -f "$f"; exit $rc\n'
)
json.dump({'commands': [wrapped]}, open(sys.argv[1], 'w'))
PYEOF

CMD=$(aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE" \
  --document-name AWS-RunShellScript --comment "mailtrack box setup" \
  --timeout-seconds 900 --parameters "file://$PARAMS" --query Command.CommandId --output text)
echo "SSM command $CMD sent; waiting (install + build take a few minutes)..."
# `aws ssm wait` gives up after ~100s; poll until the command finishes instead.
while true; do
  STATUS=$(aws ssm get-command-invocation --region "$REGION" --instance-id "$INSTANCE" --command-id "$CMD" \
    --query Status --output text 2>/dev/null || echo Pending)
  case "$STATUS" in Pending|InProgress|Delayed) sleep 10 ;; *) break ;; esac
done
aws ssm get-command-invocation --region "$REGION" --instance-id "$INSTANCE" --command-id "$CMD" \
  --query '[Status,StandardOutputContent,StandardErrorContent]' --output text
