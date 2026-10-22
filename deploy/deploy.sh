#!/usr/bin/env bash
# On the box, as ubuntu:  /var/www/mailtrack/deploy/deploy.sh
set -euo pipefail
cd /var/www/mailtrack
git fetch origin
git checkout -B main origin/main
pnpm install --frozen-lockfile
pnpm build
pm2 reload mailtrack --update-env || pm2 start deploy/ecosystem.config.cjs
pm2 save
for i in $(seq 1 20); do
  curl -fsS http://127.0.0.1:4100/health && echo && exit 0
  sleep 1
done
echo "mailtrack did not become healthy" >&2
exit 1
