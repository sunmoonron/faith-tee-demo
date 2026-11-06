#!/usr/bin/env bash
# Builds the standalone site in docs/ from the three page sources:
#   index.html     -> docs/index.html            the shop
#   media.html     -> docs/media/index.html      flyers and videos
#   churches.html  -> docs/churches/index.html   church shirt requests
# The sources are artifact-ready: no doctype, everything inline. index.html owns the shared blocks
# (the lines between <!--shared:NAME--> and <!--/shared:NAME-->: head, header, footer, script).
# This script first copies those blocks into the other two sources, so edit shared code in index.html only.
set -euo pipefail
cd "$(dirname "$0")"

sync_shared() {
  awk -v src=index.html '
    BEGIN {
      name = ""
      while ((getline line < src) > 0) {
        if (line ~ /^<!--shared:[a-z]+-->$/) { name = substr(line, 12, length(line) - 14); block[name] = ""; continue }
        if (line ~ /^<!--\/shared:[a-z]+-->$/) { name = ""; continue }
        if (name != "") block[name] = block[name] line "\n"
      }
      close(src)
    }
    /^<!--shared:[a-z]+-->$/ {
      print
      key = substr($0, 12, length($0) - 14)
      if (!(key in block)) { print "no shared block named " key " in " src > "/dev/stderr"; failed = 1; exit 1 }
      printf "%s", block[key]
      skip = 1
      next
    }
    /^<!--\/shared:[a-z]+-->$/ { skip = 0; print; next }
    !skip { print }
    END { if (failed) exit 1 }
  ' "$1" > "$1.tmp"
  if cmp -s "$1" "$1.tmp"; then rm "$1.tmp"; else mv "$1.tmp" "$1"; echo "copied the shared blocks into $1"; fi
}

# The wrapper adds what an artifact host would add, plus a flag the pages read to know they are on the real site.
wrap() {
  mkdir -p "$(dirname "$2")"
  { printf '%s\n' '<!doctype html>' '<html lang="en">' '<head>' '<meta charset="utf-8">' '<meta name="viewport" content="width=device-width,initial-scale=1">' '<script>window.QV_STANDALONE=true</script>'; cat "$1"; printf '\n%s\n' '</html>'; } > "$2"
  echo "built $2 ($(wc -c < "$2" | tr -d ' ') bytes)"
}

sync_shared media.html
sync_shared churches.html
mkdir -p docs/img docs/media
wrap index.html docs/index.html
wrap media.html docs/media/index.html
wrap churches.html docs/churches/index.html
