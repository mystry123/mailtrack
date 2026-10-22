#!/usr/bin/env bash
# One-time setup of mailtrack on shotline-prod, run from your Mac:
#   bash deploy/setup-box.sh
# Sends one SSM command to the box that:
#   1. creates /var/www/mailtrack and its .env (Mongo URI copied from shotline's
#      backend .env on the box; session/encryption secrets generated there; Google
#      client id/secret read from this repo's local .env)
#   2. creates a GitHub deploy key for the mailtrack repo (prints the public key)
#   3. adds the nginx site for track.shotline.in (nginx -t before reload)
#   4. gets a Let's Encrypt cert with certbot --nginx
# Shotline's own nginx site, pm2 apps and .env files are not modified.
# Safe to re-run: an existing .env and deploy key are left alone.
set -euo pipefail
cd "$(dirname "$0")/.."

INSTANCE=i-02e37278036b76a67
REGION=ap-south-1
ID=$(grep '^GOOGLE_CLIENT_ID=' .env | cut -d= -f2-)
SEC=$(grep '^GOOGLE_CLIENT_SECRET=' .env | cut -d= -f2-)
[[ -n "$ID" && "$SEC" == GOCSPX-* ]] || { echo "Google client id/secret missing from .env" >&2; exit 1; }

PARAMS=$(mktemp)
trap 'rm -f "$PARAMS"' EXIT

ID="$ID" SEC="$SEC" NGINX_FILE=deploy/nginx-track.shotline.in.conf python3 - "$PARAMS" <<'PYEOF'
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
ALLOWED_EMAIL=04ritikpatel@gmail.com
SESSION_SECRET=$(openssl rand -hex 32)
TOKEN_ENC_KEY=$(openssl rand -base64 32)
SELF_OPEN_GRACE_SEC=60
NOTIFY_ON_CLICK=true
NOTIFY_ON_OPEN=false
ENV
  chown ubuntu:ubuntu /var/www/mailtrack/.env
  chmod 600 /var/www/mailtrack/.env
  echo "[1] .env written"
else
  echo "[1] .env already exists, left alone"
fi

if [ ! -f /home/ubuntu/.ssh/mailtrack_deploy ]; then
  sudo -u ubuntu ssh-keygen -q -t ed25519 -N '' -C mailtrack-deploy@shotline-prod -f /home/ubuntu/.ssh/mailtrack_deploy
  printf '\nHost github-mailtrack\n  HostName github.com\n  User git\n  IdentityFile ~/.ssh/mailtrack_deploy\n  IdentitiesOnly yes\n  StrictHostKeyChecking accept-new\n' >> /home/ubuntu/.ssh/config
fi
echo "[2] DEPLOY KEY (add to GitHub repo, read-only): $(cat /home/ubuntu/.ssh/mailtrack_deploy.pub)"

cat > /etc/nginx/sites-available/track.shotline.in <<'NGINX'
__NGINX__NGINX
ln -sf /etc/nginx/sites-available/track.shotline.in /etc/nginx/sites-enabled/track.shotline.in
nginx -t
systemctl reload nginx
echo "[3] nginx site added"

certbot --nginx -d track.shotline.in --non-interactive --agree-tos --redirect 2>&1 | tail -4
nginx -t && systemctl reload nginx
echo "[4] cert done"
curl -s -o /dev/null -w 'track.shotline.in /health: %{http_code} (502 expected until the app runs)\n' https://track.shotline.in/health || true
curl -s -o /dev/null -w 'shotline.in still: %{http_code}\n' https://shotline.in/ || true
'''
script = script.replace('__ID__', os.environ['ID']).replace('__SEC__', os.environ['SEC']).replace('__NGINX__', nginx)
json.dump({'commands': [script]}, open(sys.argv[1], 'w'))
PYEOF

CMD=$(aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE" \
  --document-name AWS-RunShellScript --comment "mailtrack box setup" \
  --parameters "file://$PARAMS" --query Command.CommandId --output text)
echo "SSM command $CMD sent; waiting..."
aws ssm wait command-executed --region "$REGION" --instance-id "$INSTANCE" --command-id "$CMD" || true
aws ssm get-command-invocation --region "$REGION" --instance-id "$INSTANCE" --command-id "$CMD" \
  --query '[Status,StandardOutputContent,StandardErrorContent]' --output text
