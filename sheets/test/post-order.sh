#!/usr/bin/env bash
# Sends test orders to the deployed web app, one per delivery choice, plus a bad postal code and a promo.
# Usage:
#   SCRIPT_URL='https://script.google.com/macros/s/DEPLOYMENT_ID/exec' TOKEN='the token row in Settings' EMAIL='you@example.com' \
#     sheets/test/post-order.sh [gta|pickup|ship|badpostal|promo|catalog|all]
# Each order lands in the Orders tab and sends two emails (owners and EMAIL), so run it against a test sheet.
set -euo pipefail
: "${SCRIPT_URL:?set SCRIPT_URL to the web app URL ending in /exec}"
: "${TOKEN:=}"
: "${EMAIL:=test@example.com}"
what="${1:-all}"

post() {
  local label="$1" body="$2"
  echo "== $label"
  # A text/plain body avoids the CORS preflight that Apps Script cannot answer; -L follows its redirect.
  curl -sS -L -H 'Content-Type: text/plain' --data-binary "$body" "$SCRIPT_URL"
  echo
}

items='[{"id":"poweredbygod","colour":"White","range":"mens","size":"M","qty":2},{"id":"bestai","colour":"White","range":"youth","size":"YM","qty":1}]'
common="\"token\":\"$TOKEN\",\"name\":\"Test Person\",\"phone\":\"416 555 0199\",\"email\":\"$EMAIL\",\"consent\":true,\"website\":\"\",\"items\":$items"
ref() { printf 'test-%s-%s' "$1" "$(date +%s)"; }

case "$what" in
  catalog|all)
    echo "== catalog"; curl -sS -L "$SCRIPT_URL?action=catalog" | head -c 600; echo; echo "..."
    ;;&
  gta|all)
    post "GTA delivery" "{\"ref\":\"$(ref gta)\",$common,\"delivery\":\"gta\",\"postal\":\"M5V 2T6\",\"address\":\"12 Example St, Toronto\"}"
    ;;&
  pickup|all)
    post "Pickup" "{\"ref\":\"$(ref pickup)\",$common,\"delivery\":\"pickup\"}"
    ;;&
  ship|all)
    post "Shipping (needs ship_enabled yes in Settings)" "{\"ref\":\"$(ref ship)\",$common,\"delivery\":\"ship\",\"postal\":\"N2L 3G1\",\"address\":\"200 University Ave W, Waterloo\"}"
    ;;&
  badpostal|all)
    post "GTA delivery with an Ottawa postal code (should be rejected)" "{\"ref\":\"$(ref bad)\",$common,\"delivery\":\"gta\",\"postal\":\"K1A 0B1\",\"address\":\"1 Wellington St, Ottawa\"}"
    ;;&
  promo|all)
    post "Pickup with FAITH10 (total should drop by 10 percent)" "{\"ref\":\"$(ref promo)\",$common,\"delivery\":\"pickup\",\"promo\":\"FAITH10\"}"
    ;;
esac
