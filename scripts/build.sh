#!/usr/bin/env bash
# Build both apps into dist/ as pbws the Pebble app runs plugins for.
#
#   scripts/build.sh [build-number]
#
# With a build number (CI passes its run number) each build gets its own
# version. The Pebble app keeps the watch binary it already has when a
# sideload carries the same version, so every build needs a new one.
set -euo pipefail
cd "$(dirname "$0")/.."

build=${1:-}
mkdir -p dist
for app in tester face; do
  if [ -n "$build" ]; then
    # Pebble versions are major.minor, each below 256
    version="$((1 + build / 250)).$((build % 250)).0"
    python3 - "$app/package.json" "$version" <<'PY'
import json, sys
path, version = sys.argv[1], sys.argv[2]
with open(path) as f:
    pkg = json.load(f)
pkg["version"] = version
with open(path, "w") as f:
    json.dump(pkg, f, indent=2)
    f.write("\n")
PY
  fi
  (cd "$app" && rm -f "build/$app.pbw" && pebble build)
  python3 scripts/manifest_v2.py "$app/build/$app.pbw" "dist/ha-plugin-$app.pbw"
done
ls -l dist
