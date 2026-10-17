#!/usr/bin/env bash
# Mockup equivalent of scripts/compare.sh: bundles x rooms x runs in the in-process engine.
#   CODES="before=path/to/a.js after=dist/main.js"   name=bundle pairs (required)
#   ROOMS="W7N3 W9N5 W1N3"   RUNS=2   TICKS=8000   JOBS=3 (parallel containers)
# One line per run in test-results/mockup-compare-summary.txt, then the mean per (room, bundle).
cd "$(dirname "$0")/../.."
mkdir -p test-results
: "${CODES:?set CODES=\"name=bundle.js ...\"}"
ROOMS=${ROOMS:-"W7N3 W9N5 W1N3"}
RUNS=${RUNS:-2}
TICKS=${TICKS:-8000}
JOBS=${JOBS:-3}
OUT=test-results/mockup-compare-summary.txt
: > "$OUT"

summarize() { # room name run log
  local log=$4 pts cpu errors ext speed
  pts=$(grep -ao "total points [0-9]*" "$log" | tail -1 | grep -o "[0-9]*$")
  cpu=$(grep -ao "Avg CPU [0-9][0-9.]*" "$log" | tail -1 | awk '{print $NF}')
  errors=$(grep -ao "Module errors [0-9]*" "$log" | awk '{print $NF}')
  ext=$(grep -ao "| ext [0-9]*" "$log" | tail -1 | awk '{print $NF}')
  speed=$(grep -ao "Speed [0-9.]*" "$log" | awk '{print $NF}')
  echo "$1 $2 run=$3 points=${pts:-0} cpu=${cpu:-n/a} ext=${ext:-?} errors=${errors:-?} ticks/s=${speed:-?}"
}

# Build the image (if needed) once before the parallel runs, with a 1-tick run
first=${CODES%% *}
node scripts/mockup/run.mjs --code "${first#*=}" --ticks 1 > /dev/null 2>&1
rm -f "$(ls -t test-results/mockup-[0-9]*.json 2>/dev/null | head -1)"


for room in $ROOMS; do
  for run in $(seq 1 "$RUNS"); do
    for pair in $CODES; do
      name=${pair%%=*}; code=${pair#*=}
      log="test-results/mockup-compare-$room-$name-$run.log"
      (
        node scripts/mockup/run.mjs --ticks "$TICKS" --room "$room" --code "$code" --log-every 1000 > "$log" 2>&1
        summarize "$room" "$name" "$run" "$log" | tee -a "$OUT"
      ) &
      while [ "$(jobs -rp | wc -l)" -ge "$JOBS" ]; do sleep 1; done
    done
  done
done
wait
echo "--- mean points" | tee -a "$OUT"
awk '/points=/ { split($4,p,"="); k=$1" "$2; s[k]+=p[2]; n[k]++ } END { for (k in s) printf "%s %d\n", k, s[k]/n[k] }' "$OUT" | sort | tee -a "$OUT"
