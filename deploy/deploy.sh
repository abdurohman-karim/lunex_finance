#!/usr/bin/env bash
# Deploys the backend to the production server: copies backend/ and this folder to
# /home/lunex/app, runs setup.sh there (settings, database, domain; each part only once),
# rebuilds the image and restarts the API.
#
#   deploy/deploy.sh
#
# Uses root@79.132.143.211 with the key ~/.ssh/lunex_deploy; LUNEX_SERVER and LUNEX_SSH_KEY
# override them. Ends by checking https://api.lunex.my/health/ready.
set -euo pipefail

cd "$(dirname "$0")/.."
server="${LUNEX_SERVER:-root@79.132.143.211}"
key="${LUNEX_SSH_KEY:-$HOME/.ssh/lunex_deploy}"
dir=/home/lunex/app
ssh_opts=(-i "$key" -o IdentitiesOnly=yes -o BatchMode=yes)

echo "▸ Copying to $server:$dir"
ssh "${ssh_opts[@]}" "$server" "mkdir -p $dir"
rsync -az --delete -e "ssh ${ssh_opts[*]}" \
  --exclude node_modules --exclude dist --exclude coverage --exclude 'src/generated' \
  --exclude '.env' --exclude '.env.*' --exclude '*.tsbuildinfo' \
  backend/ "$server:$dir/backend/"
rsync -az -e "ssh ${ssh_opts[*]}" \
  deploy/compose.yaml deploy/.env.example deploy/setup.sh deploy/hestia "$server:$dir/"

echo "▸ Preparing the server, building and starting"
ssh "${ssh_opts[@]}" "$server" bash -s <<REMOTE
set -euo pipefail
cd $dir
bash setup.sh
docker compose up -d --build --remove-orphans
docker image prune -f >/dev/null
REMOTE

echo "▸ Waiting for https://api.lunex.my/health/ready"
for _ in $(seq 1 40); do
  if curl -fsS https://api.lunex.my/health/ready >/dev/null 2>&1; then
    echo "✓ Deployed: https://api.lunex.my/v1"
    exit 0
  fi
  sleep 5
done
echo "✗ Not ready yet; see: ssh -i $key $server 'cd $dir && docker compose logs --tail 100 api'" >&2
exit 1
