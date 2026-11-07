#!/usr/bin/env sh
# Builds the agents from macOS or Linux. Output:
#   agent/dist/homeydeck-agent.exe    Windows
#   agent/dist/homeydeck-agent-linux  Linux x86-64 (Bazzite and other systemd desktops)
set -eu
cd "$(dirname "$0")"
VERSION="${1:-$(git describe --tags --always 2>/dev/null || echo dev)}"
mkdir -p dist
# The Windows icon comes from rsrc_windows_amd64.syso (see icon/README.md).
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath \
  -ldflags "-s -w -H windowsgui -X main.version=$VERSION" \
  -o dist/homeydeck-agent.exe .
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath \
  -ldflags "-s -w -X main.version=$VERSION" \
  -o dist/homeydeck-agent-linux .
echo "built dist/homeydeck-agent.exe and dist/homeydeck-agent-linux ($VERSION)"
