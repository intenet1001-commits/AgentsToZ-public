#!/bin/sh
# Xcode build phase: copy the bundled portal (built by scripts/build-portal-web.ts) into App.app/web.
# Missing build → warn and ship without it; the app then opens the web portal as before.
set -eu
SRC="${SRCROOT}/build/portal-web"
DEST="${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}/web"
rm -rf "$DEST"
if [ ! -f "$SRC/remote/index.html" ]; then
  echo "warning: bundled portal not built (bun mobile/ios/scripts/build-portal-web.ts); the app will use the web portal."
  exit 0
fi
mkdir -p "$DEST"
# Service workers do not run on a custom scheme, and source maps stay out of the app.
rsync -a --delete --exclude '*.map' --exclude 'sw.js' "$SRC/" "$DEST/"
echo "bundled portal: $(find "$DEST" -type f | wc -l | tr -d ' ') files"
