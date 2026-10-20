#!/usr/bin/env bash
# Prepares the server for the API; deploy.sh runs it on every deploy (each part is skipped when
# done). As root in /home/lunex/app:
#   1. .env from .env.example, with fresh secrets that never leave the server
#   2. database lunex_db and its role on the server's shared PostgreSQL
#   3. https://api.lunex.my in HestiaCP: web domain of the lunex user, proxy template to
#      127.0.0.1:3100, Let's Encrypt certificate
set -euo pipefail
export PATH="$PATH:/usr/local/hestia/bin"
cd "$(dirname "$0")"

user=lunex
domain=api.lunex.my
database=lunex_db

secret() { openssl rand -base64 48 | tr -d '\n/+=' | cut -c1-48; }
value() { grep -E "^$1=" .env | head -1 | cut -d= -f2-; }
put() {
  if grep -qE "^$1=" .env; then
    local escaped
    escaped=$(printf '%s' "$2" | sed 's/[&|\\]/\\&/g')
    sed -i "s|^$1=.*|$1=$escaped|" .env
  else
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}

# 1. Settings
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env"
fi
chmod 600 .env
for key in JWT_ACCESS_SECRET AUTH_CODE_PEPPER; do
  [ -n "$(value $key)" ] || put "$key" "$(secret)"
done
[ -n "$(value REDIS_URL)" ] || put REDIS_URL "redis://127.0.0.1:6379/10"
sed -i '/^POSTGRES_PASSWORD=/d' .env

# 2. Database: its own role, no one else may connect to it.
psql_admin() { sudo -u postgres psql -v ON_ERROR_STOP=1 -qtA "$@"; }
if [ -z "$(value DATABASE_URL)" ]; then
  password=$(openssl rand -hex 24)
  if [ "$(psql_admin -c "select count(*) from pg_roles where rolname = '$database'")" = "0" ]; then
    psql_admin -c "create role $database login password '$password'"
  else
    psql_admin -c "alter role $database password '$password'"
  fi
  if [ "$(psql_admin -c "select count(*) from pg_database where datname = '$database'")" = "0" ]; then
    psql_admin -c "create database $database owner $database"
    psql_admin -c "revoke connect on database $database from public"
    echo "Created database $database"
  fi
  put DATABASE_URL "postgresql://$database:$password@127.0.0.1:5432/$database"
fi

# 3. Domain and certificate
templates=/usr/local/hestia/data/templates/web/nginx
if ! cmp -s hestia/lunex-api.stpl "$templates/lunex-api.stpl" || ! cmp -s hestia/lunex-api.tpl "$templates/lunex-api.tpl"; then
  install -m 644 hestia/lunex-api.tpl hestia/lunex-api.stpl "$templates/"
  changed=yes
fi
field() { v-list-web-domain "$user" "$domain" shell | awk -v key="$1:" '$1 == key {print $2}'; }
if ! v-list-web-domain "$user" "$domain" >/dev/null 2>&1; then
  v-add-web-domain "$user" "$domain"
  changed=yes
fi
# Only the API's own name: no www alias.
if [ "$(field ALIAS)" = "www.$domain" ]; then
  v-delete-web-domain-alias "$user" "$domain" "www.$domain" no
fi
if [ "$(field PROXY)" != "lunex-api" ] || [ "${changed:-}" = yes ]; then
  v-change-web-domain-proxy-tpl "$user" "$domain" lunex-api
fi
if [ "$(field SSL)" != "yes" ]; then
  v-add-letsencrypt-domain "$user" "$domain"
  v-change-web-domain-proxy-tpl "$user" "$domain" lunex-api
fi
echo "✓ Server ready: https://$domain → 127.0.0.1:3100, database $database"
