#!/usr/bin/env bash
# Compare bundles on the same rooms (clean rooms, same harness).
#   CODES="before=path/to/a.js after=dist/main.js"   name=bundle pairs (required)
#   ROOMS="W7N3 W9N5 W1N3"   RUNS=2   TICKS=8000
# One line per run in test-results/compare-summary.txt, then the mean per (room, bundle).
cd "$(dirname "$0")/.."
mkdir -p test-results
: "${CODES:?set CODES=\"name=bundle.js ...\"}"
ROOMS=${ROOMS:-"W7N3 W9N5 W1N3"}
RUNS=${RUNS:-2}
TICKS=${TICKS:-8000}
OUT=test-results/compare-summary.txt
: > "$OUT"
for room in $ROOMS; do
  for run in $(seq 1 "$RUNS"); do
    for pair in $CODES; do
      name=${pair%%=*}; code=${pair#*=}
      log="test-results/compare-$room-$name-$run.log"
      node scripts/pserver-test.mjs --ticks "$TICKS" --room "$room" --code "$code" > "$log" 2>&1
      pts=$(grep -ao "total points [0-9]*" "$log" | grep -o "[0-9]*$")
      cpu=$(grep -ao "Avg CPU <= [0-9]* *[0-9.]*" "$log" | awk '{print $NF}')
      errors=$(grep -ao "[0-9]* errors" "$log" | head -1)
      ext=$(grep -a " tick " "$log" | tail -1 | grep -ao "ext [0-9]*")
      echo "$room $name run=$run points=${pts:-0} cpu=${cpu:-n/a} $ext $errors" | tee -a "$OUT"
    done
  done
done
echo "--- mean points" | tee -a "$OUT"
awk '/points=/ { split($4,p,"="); k=$1" "$2; s[k]+=p[2]; n[k]++ } END { for (k in s) printf "%s %d\n", k, s[k]/n[k] }' "$OUT" | sort | tee -a "$OUT"
