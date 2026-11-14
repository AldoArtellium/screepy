/**
 * Offline check of military/drainForecast: the towers' net drain rate measured by a drainer, the
 * detection of towers that never fire at the exit tile, the quad's lead time and the decision to spawn
 * the quad (or to give up) from the predicted time to empty towers.
 *
 *   node tests/drainForecast/run.mjs
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(tmpdir(), "screepy-drain-forecast-build");
const require = createRequire(import.meta.url);

try {
    execFileSync(
        process.execPath,
        [
            join(ROOT, "node_modules", "typescript", "bin", "tsc"),
            "--outDir", OUT, "--rootDir", join(ROOT, "src"), "--module", "commonjs", "--target", "es2019", "--skipLibCheck",
            "--types", "screeps,lodash",
            join(ROOT, "src", "military", "drainForecast.ts"),
        ],
        { stdio: "pipe" }
    );
} catch {
    // Type errors outside this file (global declarations) don't prevent emitting
}

Object.assign(globalThis, { CREEP_SPAWN_TIME: 3 });

const {
    sampleEnergy, recordPoke, wasHit, etaToEmpty, quadLeadTime, drainDecision,
    RATE_WINDOW, NO_FIRE_TICKS, FORECAST_PATIENCE, MIN_RATE, SAMPLE_GAP,
} = require(join(OUT, "military", "drainForecast.js"));

let failures = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail !== undefined ? `: ${detail}` : ""}`);
    if (!ok) failures++;
};

// Rate: none before a full window, then the energy lost per tick, averaged with the previous window
// Samples come every other tick in play: `seenAt` stands for them (last sample 2 ticks before `now`)
const seenAt = (forecast, now) => ({ ...forecast, seen: now - 2 });
{
    const first = sampleEnergy(undefined, 1000, 3000);
    check("first sample: checkpoint, no rate", first.since === 1000 && first.at === 1000 && first.energy === 3000 && first.rate === undefined);
    const early = sampleEnergy(seenAt(first, 1000 + RATE_WINDOW - 1), 1000 + RATE_WINDOW - 1, 2600);
    check("before a full window: unchanged", early.rate === undefined && early.at === 1000);
    const one = sampleEnergy(seenAt(first, 1000 + RATE_WINDOW), 1000 + RATE_WINDOW, 2500);
    check("one window: 500 in 100 ticks = 5 a tick", one.rate === 5 && one.at === 1100 && one.energy === 2500, one.rate);
    const two = sampleEnergy(seenAt(one, 1100 + RATE_WINDOW), 1100 + RATE_WINDOW, 2400);
    check("two windows: smoothed (5 + 1) / 2", two.rate === 3, two.rate);
    const refilled = sampleEnergy(seenAt(one, 1100 + RATE_WINDOW), 1100 + RATE_WINDOW, 2700);
    check("refilled window: negative rate pulls it down", refilled.rate === (5 - 2) / 2, refilled.rate);
}

// A gap without samples (drainer dead, resting off sight) restarts the window: refills in the gap don't count
{
    const one = sampleEnergy(seenAt(sampleEnergy(undefined, 1000, 3000), 1100), 1100, 2500);
    const near = sampleEnergy(one, 1110, 2450);
    check("samples within the gap limit: window kept", near.at === 1100 && near.seen === 1110, JSON.stringify(near));
    const after = sampleEnergy(near, 1110 + SAMPLE_GAP + 1, 3000);
    check("after a gap: new window from now, rate kept", after.at === 1110 + SAMPLE_GAP + 1 && after.energy === 3000 && after.rate === 5,
        JSON.stringify(after));
}

// Hit detection from the drainer's hits across its tick in the target room
check("no damage, no heal: not hit", !wasHit(5000, 5000, 0, 5000));
check("full hits, healed nothing: 4550 after = hit", wasHit(5000, 4550, 0, 5000));
check("hurt, healed 180, back to 4180: not hit", !wasHit(4000, 4180, 180, 5000));
check("hurt, healed 180, only 4000: hit", wasHit(4000, 4000, 180, 5000));
check("heal capped at hitsMax: not hit", !wasHit(4950, 5000, 180, 5000));
{
    let f = sampleEnergy(undefined, 0, 3000);
    for (let i = 0; i < 3; i++) f = recordPoke(f, i === 1);
    check("pokes counted, hits counted", f.inTicks === 3 && f.hitTicks === 1, JSON.stringify(f));
}

// Time to empty towers
check("empty towers: 0", etaToEmpty(0, 5) === 0);
check("3000 at 5 a tick: 600", etaToEmpty(3000, 5) === 600);
check("no rate: never", etaToEmpty(3000, undefined) === Infinity);
check("refilled faster than drained: never", etaToEmpty(3000, -2) === Infinity);

// Quad lead time: spawn ticks spread over the spawns (at most one per member), boosts, travel
{
    const lead = quadLeadTime({ spawnParts: 200, spawns: 3, boosted: false, routeRooms: 3 });
    const more = quadLeadTime({ spawnParts: 200, spawns: 8, boosted: false, routeRooms: 3 });
    const boosted = quadLeadTime({ spawnParts: 200, spawns: 3, boosted: true, routeRooms: 3 });
    const far = quadLeadTime({ spawnParts: 200, spawns: 3, boosted: false, routeRooms: 6 });
    check("600 spawn ticks over 3 spawns: 200 + travel", lead >= 200 + 3 * 50 && lead < 200 + 3 * 50 + 100, lead);
    check("more than 4 spawns don't help (4 members)", more === quadLeadTime({ spawnParts: 200, spawns: 4, boosted: false, routeRooms: 3 }), more);
    check("boosts add time", boosted > lead, `${boosted} vs ${lead}`);
    check("a longer route adds time", far > lead, `${far} vs ${lead}`);
}

// Decision
{
    const base = { since: 0, at: 0, energy: 3000, inTicks: 0, hitTicks: 0 };
    check("no rate yet: wait", drainDecision(base, 50, 3000, 400) === "wait");
    check("towers empty: spawn", drainDecision(base, 50, 0, 400) === "spawn");
    check("ETA 600 > lead 400: wait", drainDecision({ ...base, rate: 5 }, 200, 3000, 400) === "wait");
    check("ETA 400 <= lead 400: spawn", drainDecision({ ...base, rate: 5 }, 200, 2000, 400) === "spawn");
    // shard0 W29N4 / W28N3 2026-11-14: the towers repaired walls instead of shooting the drainer
    check("no hit in NO_FIRE_TICKS pokes: noFire", drainDecision({ ...base, inTicks: NO_FIRE_TICKS, hitTicks: 0 }, 100, 3000, 400) === "noFire");
    check("one hit: still waiting", drainDecision({ ...base, inTicks: NO_FIRE_TICKS, hitTicks: 1 }, 100, 3000, 400) === "wait");
    check("refills beat the drain after the patience: noProgress",
        drainDecision({ ...base, inTicks: 100, hitTicks: 50, rate: MIN_RATE / 2 }, FORECAST_PATIENCE, 2900, 400) === "noProgress");
    check("no rate after the patience: noProgress",
        drainDecision({ ...base, inTicks: 100, hitTicks: 50 }, FORECAST_PATIENCE, 2900, 400) === "noProgress");
    check("slow but real drain after the patience: wait",
        drainDecision({ ...base, inTicks: 100, hitTicks: 50, rate: MIN_RATE * 2 }, FORECAST_PATIENCE, 2900, 400) === "wait");
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
