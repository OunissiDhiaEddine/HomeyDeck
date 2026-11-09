#!/usr/bin/env bash
# Builds the panel and packs the plugin the way Decky installs it:
#   out/HomeyDeck.zip → HomeyDeck/{plugin.json, package.json, main.py, dist/index.js, README.md}
set -euo pipefail
cd "$(dirname "$0")"
npm ci --no-audit --no-fund
npm run build
rm -rf out && mkdir -p out/HomeyDeck/dist
cp plugin.json package.json main.py README.md out/HomeyDeck/
cp dist/index.js out/HomeyDeck/dist/
(cd out && zip -qr HomeyDeck.zip HomeyDeck)
echo "out/HomeyDeck.zip"
