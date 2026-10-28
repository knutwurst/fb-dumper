#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
CONFIG="${1:-release}"
APP="$ROOT/FB Dumper.app"
RES="$APP/Contents/Resources"

echo "▶ npm ci …"
(cd "$ROOT" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)

if [ ! -f "$ROOT/Resources/AppIcon.icns" ]; then
  echo "▶ rendering icon …"
  ICONSET="$ROOT/.build/AppIcon.iconset"
  rm -rf "$ICONSET"
  swift "$ROOT/scripts/makeicon.swift" "$ICONSET"
  iconutil -c icns "$ICONSET" -o "$ROOT/Resources/AppIcon.icns"
fi

echo "▶ swift build ($CONFIG) …"
swift build -c "$CONFIG" --package-path "$ROOT"
BIN="$(swift build -c "$CONFIG" --package-path "$ROOT" --show-bin-path)/FBDumper"

echo "▶ assembling $APP …"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$RES/dumper"
cp "$BIN" "$APP/Contents/MacOS/FBDumper"
cp "$ROOT/Resources/Info.plist" "$APP/Contents/Info.plist"
cp "$ROOT/Resources/AppIcon.icns" "$RES/AppIcon.icns"
cp -R "$ROOT/src" "$ROOT/package.json" "$ROOT/node_modules" "$RES/dumper/"

echo "▶ ad-hoc code signing …"
codesign --force --sign - "$APP"
codesign --verify --verbose "$APP"

echo "✅ built $APP"
