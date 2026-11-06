#!/usr/bin/env bash
# Sends a church request with a small artwork file to the deployed web app, and one with a file type that is refused.
# Usage:
#   SCRIPT_URL='https://script.google.com/macros/s/DEPLOYMENT_ID/exec' TOKEN='the token row in Settings' EMAIL='you@example.com' \
#     sheets/test/post-church.sh [ok|badtype|all]
# The good request lands in the Church requests tab, saves the file to the "Church artwork" folder in the
# owner's Drive and sends two emails (owners and EMAIL), so run it against a test sheet.
set -euo pipefail
: "${SCRIPT_URL:?set SCRIPT_URL to the web app URL ending in /exec}"
: "${TOKEN:=}"
: "${EMAIL:=test@example.com}"
what="${1:-all}"

# A one-pixel PNG, and a date 30 days from now (BSD date first, GNU date second).
png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
needed="$(date -v+30d +%F 2>/dev/null || date -d '+30 days' +%F)"

post() {
  local label="$1" file="$2"
  echo "== $label"
  curl -sS -L -H 'Content-Type: text/plain' --data-binary @- "$SCRIPT_URL" <<JSON
{"type":"church","token":"$TOKEN","ref":"test-church-$(date +%s)-$RANDOM","website":"",
 "church":"Test Community Church","contact":"Test Person","email":"$EMAIL","phone":"905 555 0144","colour":"Navy",
 "sizes":{"mens":{"M":10,"L":8},"womens":{"S":4},"youth":{"YL":2}},"date":"$needed","delivery":"gta",
 "notes":"Test request. Please ignore.","rights":true,"file":{"name":"$file","type":"image/png","data":"$png"}}
JSON
  echo
}

case "$what" in
  ok|all) post "Church request with a small PNG" "test-logo.png" ;;&
  badtype|all) post "Church request with a file type that is not allowed (should be rejected)" "test-logo.exe" ;;
esac
