#!/bin/bash
# Build CCHv2.app for macOS with a native NW.js runtime (arm64 or x64).
#
#   scripts/build-mac.sh            # build into build/CCHv2.app
#   scripts/build-mac.sh --install  # also copy it to /Applications
#
# Environment: NW_VERSION (default below), OUT (default <repo>/build).
set -euo pipefail

NW_VERSION="${NW_VERSION:-v0.119.2}"
case "$(uname -m)" in
	arm64) NW_ARCH=arm64 ;;
	x86_64) NW_ARCH=x64 ;;
	*) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${OUT:-$ROOT/build}"
CACHE="$OUT/cache"
NAME="nwjs-$NW_VERSION-osx-$NW_ARCH"
ZIP="$NAME.zip"
APP="$OUT/CCHv2.app"

mkdir -p "$CACHE"
if [ ! -f "$CACHE/$ZIP" ]; then
	echo "Downloading $ZIP"
	curl -fL --retry 3 -o "$CACHE/$ZIP.part" "https://dl.nwjs.io/$NW_VERSION/$ZIP"
	mv "$CACHE/$ZIP.part" "$CACHE/$ZIP"
fi
curl -fsSL "https://dl.nwjs.io/$NW_VERSION/SHASUMS256.txt" | grep " $ZIP\$" > "$CACHE/$ZIP.sha256"
(cd "$CACHE" && shasum -a 256 -c "$ZIP.sha256")

rm -rf "$CACHE/$NAME" "$APP"
unzip -q "$CACHE/$ZIP" -d "$CACHE"
cp -R "$CACHE/$NAME/nwjs.app" "$APP"

# app sources
RES="$APP/Contents/Resources"
mkdir -p "$RES/app.nw"
for f in package.json index.html problem.html contest.html favicon.png css js mathjax2.7 webfonts; do
	cp -R "$ROOT/$f" "$RES/app.nw/"
done

# icon
ICONSET="$CACHE/app.iconset"
rm -rf "$ICONSET" && mkdir -p "$ICONSET"
for s in 16 32 64 128 256 512; do
	sips -z $s $s "$ROOT/favicon.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
	d=$((s * 2))
	sips -z $d $d "$ROOT/favicon.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$RES/app.icns"

# names shown by Finder, Dock and the menu bar
PLIST="$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName CCHv2" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName CCHv2" "$PLIST" 2>/dev/null ||
	/usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string CCHv2" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier io.github.codeforcescontesthelper.cchv2" "$PLIST"
find "$RES" -name InfoPlist.strings -path "*.lproj/*" -delete

# ad-hoc signature so the modified bundle still launches on Apple Silicon
codesign --force --deep --sign - "$APP"

echo "Built $APP"
if [ "${1:-}" = "--install" ]; then
	rm -rf /Applications/CCHv2.app
	cp -R "$APP" /Applications/CCHv2.app
	echo "Installed /Applications/CCHv2.app"
fi
