#!/usr/bin/env bash
# Wraps index.html (the artifact source, no doctype) into docs/index.html, a standalone page for static hosting.
set -euo pipefail
cd "$(dirname "$0")"
{ printf '%s\n' '<!doctype html>' '<html lang="en">' '<head>' '<meta charset="utf-8">' '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'; cat index.html; printf '\n%s\n' '</html>'; } > docs/index.html
echo "built docs/index.html ($(wc -c < docs/index.html) bytes)"
