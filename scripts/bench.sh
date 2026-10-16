#!/usr/bin/env bash
# Benchmark matrix: rooms x a Memory.config switch on/off.
#   SWITCH=staticMiners (default) | earlyRoads | ...   config key toggled true/false
#   CODE=path/to/main.js   bundle to test (default dist/main.js, run `npm run compile` first)
#   TICKS=8000             ticks per run
# Summary in test-results/bench-summary.txt (one line per run).
cd "$(dirname "$0")/.."
mkdir -p test-results
SWITCH=${SWITCH:-staticMiners}
OUT=test-results/bench-summary.txt
: > "$OUT"
for room in W7N3 W9N5 W1N3; do
  for value in true false; do
    log="test-results/bench-$room-$SWITCH-$value.log"
    node scripts/pserver-test.mjs --ticks "${TICKS:-8000}" --room "$room" --code "${CODE:-dist/main.js}" \
      --memory "{\"config\":{\"$SWITCH\":$value}}" > "$log" 2>&1
    pts=$(grep -ao "total points [0-9]*" "$log" | grep -o "[0-9]*$")
    ext=$(grep -a " tick " "$log" | tail -1 | grep -ao "ext [0-9]*")
    errors=$(grep -ao "[0-9]* errors" "$log" | tail -1)
    spawned=$(grep -ao "'spawned:[a-z]*': [0-9]*" "$log" | tr '\n' ' ')
    echo "$room $SWITCH=$value points=$pts $ext $errors $spawned" | tee -a "$OUT"
  done
done
