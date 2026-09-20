#!/bin/sh
# The upstream's code at the manifest's pinned revision, and a pinned Python to run it, both under
# `.reference/`, which git ignores: the code is Apache-2.0 and somebody else's, and the parity
# checks read it rather than this repository carrying it.
#
#     sh tools/capture-weights/reference/setup.sh
#
# Run the checks with `env -u LD_LIBRARY_PATH`: a machine with a system libtorch on that path loads
# it in place of the wheel's, and the import fails on a missing symbol.
set -eu
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
revision() {
  python3 -c "import json,sys; print(next(m['code']['revision'] for m in json.load(open(sys.argv[1]))['models'] if m['name'] == sys.argv[2]))" "$ROOT/tools/capture-weights/manifest.json" "$1"
}
DA3=$(revision depth-anything-3-small)
mkdir -p "$ROOT/.reference/da3"
curl -sL "https://codeload.github.com/ByteDance-Seed/Depth-Anything-3/tar.gz/$DA3" |
  tar xz -C "$ROOT/.reference/da3" --strip-components=1 --wildcards '*/src/*'
MOBILESAM=$(revision mobilesam)
mkdir -p "$ROOT/.reference/mobilesam"
curl -sL "https://codeload.github.com/ChaoningZhang/MobileSAM/tar.gz/$MOBILESAM" |
  tar xz -C "$ROOT/.reference/mobilesam" --strip-components=1 --wildcards '*/mobile_sam/*'
python3 -m venv "$ROOT/.reference/venv-da3"
"$ROOT/.reference/venv-da3/bin/pip" install --quiet -r "$ROOT/tools/capture-weights/reference/requirements.txt"
echo "Depth Anything 3 at $DA3, MobileSAM at $MOBILESAM, and their Python, are under .reference/"
