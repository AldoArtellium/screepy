/**
 * Offline check of visuals/settings: which layers are drawn and how often the world map is redrawn,
 * with and without the remote CPU budget cap, against a mocked Memory.
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
            "--types", "screeps,lodash",
            join(ROOT, "src", "visuals", "settings.ts"),
        ],
        { stdio: "pipe" }
    );
} catch {
    // Type errors outside this file (global declarations) don't prevent emitting
}

const { layerEnabled, mapInterval } = require(join(OUT, "settings.js"));

let failures = 0;
function check(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failures++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}

function memory({ visuals, maxRooms } = {}) {
    globalThis.Memory = { visuals, remoteMining: { maxRooms } };
}

const MAP_LAYERS = ["mapRemotes", "mapStrategy", "mapThreats"];

memory();
check("uncapped: every layer on", ["plan", "panel", "spawn", "mapCreeps", "mapPanel", ...MAP_LAYERS].map(layerEnabled), Array(8).fill(true));
check("uncapped: map redrawn every 20 ticks", typeof mapInterval === "function" ? mapInterval() : undefined, 20);

memory({ maxRooms: 6 });
check("capped: remote, strategy and threat map layers stay on", MAP_LAYERS.map(layerEnabled), [true, true, true]);
check("capped: map panel, room panel and spawn overlay stay on", ["mapPanel", "panel", "spawn"].map(layerEnabled), [true, true, true]);
check("capped: plan overlay and map creeps off", ["plan", "mapCreeps"].map(layerEnabled), [false, false]);
check("capped: map redrawn every 200 ticks", typeof mapInterval === "function" ? mapInterval() : undefined, 200);

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
