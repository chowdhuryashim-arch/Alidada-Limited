#!/usr/bin/env bash
# One-command deploy of the ALIDADA Limited Ledger Book to Cloudflare.
#
# Requires CLOUDFLARE_API_TOKEN (Workers Scripts:Edit, D1:Edit, Workers R2 Storage:Edit,
# Account Settings:Read) and CLOUDFLARE_ACCOUNT_ID in the environment, or `wrangler login`.
#
# Idempotent: re-running reuses the existing D1 database, bucket and secrets.
#   SESSION_SECRET / BOOTSTRAP_KEY: taken from the environment if set, otherwise generated
#   on first deploy and written to .deploy-secrets (git-ignored) so you can use the
#   bootstrap key on /setup.
set -euo pipefail
cd "$(dirname "$0")/.."

DB_NAME="alidada-ledger-db"
BUCKET="alidada-ledger-docs"
WR="npx --yes wrangler"

[ -d node_modules/wrangler ] || npm install --no-audit --no-fund

echo "▶ Checking Cloudflare credentials…"
$WR whoami

echo "▶ D1 database: $DB_NAME"
db_id() {
  $WR d1 list --json 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const list = JSON.parse(s.slice(s.indexOf("[")));
      const db = list.find((d) => d.name === process.argv[1]);
      process.stdout.write(db ? db.uuid : "");
    });' "$DB_NAME"
}
ID="$(db_id)"
if [ -z "$ID" ]; then
  $WR d1 create "$DB_NAME"
  ID="$(db_id)"
fi
[ -n "$ID" ] || { echo "✖ Could not determine the D1 database id"; exit 1; }
sed -i.bak -E "s/^database_id = \".*\"/database_id = \"$ID\"/" wrangler.toml && rm -f wrangler.toml.bak
echo "  database_id = $ID"

echo "▶ Applying schema"
$WR d1 execute "$DB_NAME" --remote --file=schema/schema.sql --yes

echo "▶ R2 bucket: $BUCKET"
if ! $WR r2 bucket list 2>/dev/null | grep -q "$BUCKET"; then
  if ! $WR r2 bucket create "$BUCKET"; then
    echo "  R2 is not available on this account — deploying without document storage."
    node -e '
      const fs = require("fs");
      const t = fs.readFileSync("wrangler.toml", "utf8").replace(/\n# Document[\s\S]*?bucket_name = "[^"]*"\n/, "\n");
      fs.writeFileSync("wrangler.toml", t);'
  fi
fi

echo "▶ Deploying Worker"
$WR deploy

echo "▶ Secrets"
touch .deploy-secrets && chmod 600 .deploy-secrets
existing="$($WR secret list 2>/dev/null || true)"
put_secret() {
  local name="$1" value="${!1:-}"
  if echo "$existing" | grep -q "\"$name\""; then
    echo "  $name already set — keeping it"
    return
  fi
  if [ -z "$value" ]; then
    value="$(node -e 'console.log(require("crypto").randomBytes(24).toString("base64url"))')"
    echo "$name=$value" >> .deploy-secrets
  fi
  printf '%s' "$value" | $WR secret put "$name"
}
put_secret SESSION_SECRET
put_secret BOOTSTRAP_KEY

echo
echo "✔ Deployed. Open https://alidada.<your-subdomain>.workers.dev (shown above) and go to /setup to create the Admin."
[ -s .deploy-secrets ] && echo "  Generated secrets were saved to .deploy-secrets (use BOOTSTRAP_KEY on /setup)."
