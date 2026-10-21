#!/usr/bin/env bash
# Puts the site lunex.my on the server: builds site/public (home, privacy policy and support in
# Uzbek, Russian and English) and copies it into the Hestia web domain lunex.my of the lunex
# user, owned by that user.
#
#   deploy/site.sh
#
# Uses root@79.132.143.211 with the key ~/.ssh/lunex_deploy; LUNEX_SERVER and LUNEX_SSH_KEY
# override them. Ends by checking https://lunex.my/ru/privacy/.
set -euo pipefail

cd "$(dirname "$0")/.."
server="${LUNEX_SERVER:-root@79.132.143.211}"
key="${LUNEX_SSH_KEY:-$HOME/.ssh/lunex_deploy}"
dir=/home/lunex/web/lunex.my/public_html
ssh_opts=(-i "$key" -o IdentitiesOnly=yes -o BatchMode=yes)

echo "▸ Building the site"
python3 site/build.py

echo "▸ Copying to $server:$dir"
rsync -rlz --delete -e "ssh ${ssh_opts[*]}" site/public/ "$server:$dir/"
ssh "${ssh_opts[@]}" "$server" "chown -R lunex:lunex $dir && find $dir -type d -exec chmod 755 {} + && find $dir -type f -exec chmod 644 {} +"

echo "▸ Checking https://lunex.my/ru/privacy/"
curl -fsS -o /dev/null https://lunex.my/ru/privacy/
echo "✓ https://lunex.my"
