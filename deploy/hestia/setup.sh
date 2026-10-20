#!/usr/bin/env bash
# One-time setup of https://api.lunex.my in HestiaCP, run on the server as root (safe to repeat):
# the web domain under the lunex user, the proxy template to the API on 127.0.0.1:3100 and a
# Let's Encrypt certificate. From the repository root:
#
#   scp deploy/hestia/lunex-api.* deploy/hestia/setup.sh root@79.132.143.211:/tmp/ && \
#     ssh root@79.132.143.211 bash /tmp/setup.sh
set -euo pipefail
export PATH="$PATH:/usr/local/hestia/bin"

user=lunex
domain=api.lunex.my
templates=/usr/local/hestia/data/templates/web/nginx
here="$(cd "$(dirname "$0")" && pwd)"

install -m 644 "$here/lunex-api.tpl" "$here/lunex-api.stpl" "$templates/"

if ! v-list-web-domain "$user" "$domain" >/dev/null 2>&1; then
  v-add-web-domain "$user" "$domain"
fi
# Only the API's own name: no www alias.
field() { v-list-web-domain "$user" "$domain" shell | awk -v key="$1:" '$1 == key {print $2}'; }
if [ "$(field ALIAS)" = "www.$domain" ]; then
  v-delete-web-domain-alias "$user" "$domain" "www.$domain" no
fi
v-change-web-domain-proxy-tpl "$user" "$domain" lunex-api
if [ "$(field SSL)" != "yes" ]; then
  v-add-letsencrypt-domain "$user" "$domain"
fi
v-change-web-domain-proxy-tpl "$user" "$domain" lunex-api
echo "✓ https://$domain → 127.0.0.1:3100"
