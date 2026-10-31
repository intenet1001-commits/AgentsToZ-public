#!/bin/sh
# Xcode build phase: copy the bundled portal (built by scripts/build-portal-web.ts) into App.app/web.
# A mobile app without its workspace is an incomplete build, never a successful install artifact.
set -eu
SRC="${SRCROOT}/build/portal-web"
DEST="${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}/web"
if [ ! -s "$SRC/remote/index.html" ] || [ ! -s "$SRC/portal.html" ] || [ ! -d "$SRC/assets" ]; then
  echo "error: bundled portal missing. Run bun mobile/ios/scripts/build-portal-web.ts before building the app."
  exit 1
fi
rm -rf "$DEST"
mkdir -p "$DEST"
# Service workers do not run on a custom scheme, and source maps stay out of the app.
rsync -a --delete --exclude '*.map' --exclude 'sw.js' "$SRC/" "$DEST/"
echo "bundled portal: $(find "$DEST" -type f | wc -l | tr -d ' ') files"
