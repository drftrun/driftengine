#!/usr/bin/env bash
#
# Delete the term a check claims to measure, and see whether the check notices.
#
#     scripts/claimAudit.sh <check> <page> <file> <old-line> <new-line> [wgsl]
#     scripts/claimAudit.sh emissive emissive.html \
#       packages/core/src/render/shaders/flat/main.ts \
#       'lit += emissiveTint * emissiveMapped' 'lit += 0.0 * emissiveTint * emissiveMapped' wgsl
#
# **Why this exists.** Twice on 2026-09-04 a green check was measuring nothing. An area-light
# capture would have passed with the whole specular term deleted, because the page's floor was matte
# and `vSpecular` was zero; the claim written to replace it then passed with the term multiplied by
# 0.02, because a threshold is not a band. Neither was visible from outside the script.
#
# **A fresh dev server for every run, and that is the point rather than caution.** A vite server
# that has been up across an edit serves a stale transform. Measured: the identical ORM mutation
# read 12-of-12 green on a server that had been running, and 5-of-12 on one started after the edit.
# A run against a stale server is not a weak result, it is a wrong one.
#
# **Reading the output.** A survivor is not automatically a defect. Four kinds survive honestly:
#
#   - **smoke** — "draws without a validation error"
#   - **negative controls** — "the control has no direction of its own", "the undeclared half
#     reflects in nothing"
#   - **safety claims** — "nothing is blown out by the term"
#   - **claims about another term** — a script's claims often span two, and one mutation only
#     speaks to one of them. `ibl-check.mjs` read 6-of-7 surviving until the mutation was aimed at
#     the irradiance it names rather than at the environment image beside it.
#
# Two kinds do not:
#
#   - **parity claims** — "the backends agree". Two backends agreeing on nothing is not agreement,
#     and `|0 - 0| <= 0 * PARITY` is true. Found in `ssr-check.mjs` and `decal-check.mjs`.
#   - **shape claims** — "glows evenly", "is flat". Absence is even. Found in `emissive-check.mjs`.
#
# Both are repaired the same way: say what you are agreeing about, or even about, against the floor
# the positive claim beside it already uses.
#
# Restores the tree and re-runs, so the chain it prints is green -> mutated -> green. It needs a dev
# server and a real GPU, which is why it is not a `*.test.mjs`.
#
# audit.sh <check-name> <page> <file> <old> <new> [wgsl]
# Runs the chain a claim has to survive: green -> mutated -> restored green,
# on a FRESHLY started dev server for every run. A server that has been up
# across an edit serves a stale transform and reads green either way.
set -u
CHECK=$1; PAGE=$2; FILE=$3; OLD=$4; NEW=$5; WGSL=${6:-no}
PORT=5210
# Results go outside the repository: this writes three files per run and none of them is a
# deliverable. Named per check so a batch leaves a readable trail.
A="${TMPDIR:-/tmp}/driftengine-claim-audit"; mkdir -p "$A"
cd "$(dirname "$0")/.." || exit 1

serve() {
  lsof -ti:$PORT 2>/dev/null | xargs -r kill 2>/dev/null
  sleep 2
  (setsid npx vite demo/dev --port $PORT > "$A/vite.log" 2>&1 < /dev/null &)
  for _ in $(seq 1 20); do
    sleep 1
    [ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:$PORT/$PAGE)" = "200" ] && return 0
  done
  echo "server never came up"; exit 1
}

# Scripts print "PASS  name: detail", "ok    name — detail", and names that contain a colon of
# their own. Rather than guess where a name ends, keep the whole line and match claims by
# position: every script prints its claims in a fixed order, so line N of one run is line N of
# the next. Only the verdict is normalised.
run() {
  node "scripts/$CHECK-check.mjs" --base=http://localhost:$PORT 2>&1 \
    | grep -E "^[[:space:]]*(PASS|ok  |FAIL)" \
    | sed -e 's/^[[:space:]]*//' -e 's/^ok  /PASS/'
}

apply() { python3 - "$FILE" "$1" "$2" <<'PY'
import sys
from pathlib import Path
p = Path(sys.argv[1]); s = p.read_text()
assert sys.argv[2] in s, 'pattern not found: ' + sys.argv[2][:60]
p.write_text(s.replace(sys.argv[2], sys.argv[3], 1))
PY
  [ "$WGSL" = "wgsl" ] && npm run wgsl > /dev/null 2>&1
  return 0
}

serve; run > "$A/$CHECK.base.txt"
BASE_FAIL=$(grep -c '^FAIL' "$A/$CHECK.base.txt")
TOTAL=$(grep -c . "$A/$CHECK.base.txt")
if [ "$TOTAL" = "0" ]; then echo "$CHECK: no claims parsed — its output format is not one this reads"; exit 4; fi
if [ "$BASE_FAIL" != "0" ]; then echo "$CHECK: BASELINE NOT GREEN ($BASE_FAIL failing) — not auditable"; exit 2; fi

apply "$OLD" "$NEW" || { echo "$CHECK: mutation did not apply"; exit 3; }
serve; run > "$A/$CHECK.mut.txt"

git checkout -- "$FILE"
# Every directory `npm run wgsl` writes into. `@driftengine/ui2d` authors programs too, so a
# core-only restore leaves one backend mutated and reads as a parity failure that is the
# harness's own doing.
[ "$WGSL" = "wgsl" ] && git checkout -- \
  packages/core/src/render/shaders/generated/ \
  packages/ui2d/src/shaders/generated/
serve; run > "$A/$CHECK.restored.txt"
REST_FAIL=$(grep -c '^FAIL' "$A/$CHECK.restored.txt")

SURV=$(grep -c '^PASS' "$A/$CHECK.mut.txt")
echo "== $CHECK =="
echo "claims: $TOTAL   surviving the mutation: $SURV   restored green: $([ "$REST_FAIL" = 0 ] && echo yes || echo NO)"
echo "-- survivors, named from the baseline run --"
paste -d'\t' "$A/$CHECK.mut.txt" "$A/$CHECK.base.txt" \
  | awk -F'\t' '$1 ~ /^PASS/ { sub(/^PASS[ ]*/, "", $2); print "   " $2 }'
