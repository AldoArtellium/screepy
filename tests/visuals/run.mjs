/**
 * Offline check of visuals/settings: which layers are drawn and how often the world map is redrawn,
 * with and without CPU pressure (remote CPU budget cap, CPU average above 85% of the limit), against
 * a mocked Memory and Game.
 *
 *   node tests/visuals/run.mjs
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(tmpdir(), "screepy-visuals-build");
const require = createRequire(import.meta.url);

try {
    execFileSync(
        process.execPath,
        [
            join(ROOT, "node_modules", "typescript", "bin", "tsc"),
            "--outDir", OUT, "--module", "commonjs", "--target", "es2019", "--skipLibCheck",
            "--types", "screeps,lodash", "--rootDir", join(ROOT, "src"),
            join(ROOT, "src", "visuals", "settings.ts"),
        ],
        { stdio: "pipe" }
    );
} catch {
    // Type errors outside this file (global declarations) don't prevent emitting
}

// Game constants read at load by remote/remoteIncome (cpuPressure)
Object.assign(globalThis, {
    MOVE: "move", WORK: "work", CARRY: "carry", CLAIM: "claim",
    BODYPART_COST: { move: 50, work: 100, carry: 50, claim: 600 },
    CONTAINER_DECAY: 5000, CONTAINER_DECAY_TIME: 100, REPAIR_POWER: 100,
});

const { layerEnabled, mapInterval, panelInterval } = require(join(OUT, "visuals", "settings.js"));

let failures = 0;
function check(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failures++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}

function memory({ visuals, maxRooms, cpuAvg } = {}) {
    globalThis.Memory = { visuals, remoteMining: { maxRooms }, stats: { cpuAvg } };
    globalThis.Game = { cpu: { limit: 20 } };
}

const MAP_LAYERS = ["mapRemotes", "mapStrategy", "mapThreats"];

memory();
check("uncapped: every layer on", ["plan", "panel", "spawn", "mapCreeps", "mapPanel", ...MAP_LAYERS].map(layerEnabled), Array(8).fill(true));
check("uncapped: map redrawn every 20 ticks", typeof mapInterval === "function" ? mapInterval() : undefined, 20);
check("uncapped: panel redrawn every 5 ticks", typeof panelInterval === "function" ? panelInterval() : undefined, 5);

memory({ cpuAvg: 17 });
check("uncapped at 85% CPU: every layer on", ["plan", "mapCreeps", "panel"].map(layerEnabled), [true, true, true]);

memory({ cpuAvg: 17.5 });
check("uncapped above 85% CPU: plan overlay and map creeps off", ["plan", "mapCreeps", "panel", ...MAP_LAYERS].map(layerEnabled), [false, false, true, true, true, true]);
check("uncapped above 85% CPU: map every 200, panel every 20 ticks", [mapInterval(), panelInterval()], [200, 20]);

memory({ cpuAvg: 17.5, visuals: { plan: true, mapCreeps: true } });
check("above 85% CPU: explicit settings win", ["plan", "mapCreeps"].map(layerEnabled), [true, true]);

memory({ maxRooms: 6 });
check("capped: remote, strategy and threat map layers stay on", MAP_LAYERS.map(layerEnabled), [true, true, true]);
check("capped: map panel, room panel and spawn overlay stay on", ["mapPanel", "panel", "spawn"].map(layerEnabled), [true, true, true]);
check("capped: plan overlay and map creeps off", ["plan", "mapCreeps"].map(layerEnabled), [false, false]);
check("capped: map redrawn every 200 ticks", typeof mapInterval === "function" ? mapInterval() : undefined, 200);
check("capped: panel redrawn every 20 ticks", typeof panelInterval === "function" ? panelInterval() : undefined, 20);

memory({ maxRooms: 0 });
check("capped at 0 rooms counts as capped", layerEnabled("plan"), false);

memory({ maxRooms: 6, visuals: { plan: true, mapCreeps: true, mapThreats: false } });
check("capped: explicit settings win", ["plan", "mapCreeps", "mapThreats", "mapRemotes"].map(layerEnabled), [true, true, false, true]);

memory({ visuals: false, maxRooms: 6 });
check("visuals false: nothing drawn", ["panel", ...MAP_LAYERS].map(layerEnabled), [false, false, false, false]);

if (failures) {
    console.log(`${failures} check(s) failed`);
    process.exit(1);
}
console.log("all checks passed");
