/**
 * Offline check of visuals/militaryRows: the military section of the world map panel built from
 * Memory.military and the remote seizes (missions, drainer probe, sieges, seizes, baits, loot, nukes in
 * flight, boost demand, recent results), against plain objects.
 *
 *   node tests/militaryVisuals/run.mjs
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(tmpdir(), "screepy-military-visuals-build");
const require = createRequire(import.meta.url);

try {
    execFileSync(
        process.execPath,
        [
            join(ROOT, "node_modules", "typescript", "bin", "tsc"),
            "--outDir", OUT, "--module", "commonjs", "--target", "es2019", "--skipLibCheck",
            "--types", "screeps,lodash", "--rootDir", join(ROOT, "src"),
            join(ROOT, "src", "visuals", "militaryRows.ts"),
        ],
        { stdio: "pipe" }
    );
} catch {
    // Type errors outside this file (global declarations) don't prevent emitting
}

const { militaryRows, boostTier } = require(join(OUT, "visuals", "militaryRows.js"));

let failures = 0;
function check(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failures++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}

const TIME = 100000;
const texts = rows => rows.map(row => row.map(cell => cell.text));
const alive = names => name => names.includes(name);

check("no military memory: no row", militaryRows(undefined, undefined, TIME, alive([])), []);
check("empty military memory: no row", militaryRows({ duos: {} }, {}, TIME, alive([])), []);

check("boost tier: none, T1, T2, T3", [boostTier(undefined), boostTier({}), boostTier({ heal: "LO" }), boostTier({ heal: "LHO2", attack: "UH" }), boostTier({ tough: "XGHO2", heal: null })], ["max", "plain", "T1", "T2", "T3"]);

const quad = {
    spawnRoom: "W27N5", bases: ["W27N5"], energy: 5600, targetRoom: "W28N3", stagingRoom: "W28N4",
    state: "wait", members: ["q1", "q2", "q3", "q4"], losses: 1, boosts: { heal: "XLHO2", tough: "XGHO2", attack: null },
    probeEnergy: 3400, probeTowers: 3, probe: { since: 99000, at: 99500, energy: 3400, rate: 12.5 }
};
check(
    "quad waiting for the drainer: mission row and probe row",
    texts(militaryRows({ duos: {}, quads: { Q: quad }, targets: [{ room: "W28N3", reason: "aggressor", since: 88000, roi: 2.14 }] }, {}, TIME, alive(["q1", "q2", "q3"]))),
    [
        ["quad", "W28N3", "wait 3/4 -1", "aggressor · roi 2.1 · T3 · 12.0k"],
        ["", "", "towers 3 · 3400e", "drain 12.5/t"]
    ]
);
check(
    "towers refilled faster than drained",
    texts(militaryRows({ duos: {}, quads: { Q: { ...quad, probe: { ...quad.probe, rate: -4 } } }, targets: [{ room: "W28N3", reason: "aggressor", since: 88000 }] }, {}, TIME, alive(["q1"])))[1],
    ["", "", "towers 3 · 3400e", "refill 4.0/t"]
);
check(
    "refill shown as a warning",
    militaryRows({ duos: {}, quads: { Q: { ...quad, probe: { ...quad.probe, rate: -4 } } } }, {}, TIME, alive([]))[1][3].color,
    "#e8a23a"
);

const duo = { spawnRoom: "W27N5", bases: [], energy: 2300, targetRoom: "W26N3", stagingRoom: "W26N4", state: "advance", members: ["a", "h"], losses: 0 };
check(
    "manual duo without losses, strongest boosts",
    texts(militaryRows({ attack: "W26N3", duos: { D: duo } }, {}, TIME, alive(["a", "h"]))),
    [["duo", "W26N3", "advance 2/2", "manual · max"]]
);
check(
    "target without a squad yet",
    texts(militaryRows({ duos: {}, targets: [{ room: "W25N3", reason: "encroacher", since: 99500, roi: 1.5 }] }, {}, TIME, alive([]))),
    [["attack", "W25N3", "no squad", "encroacher · roi 1.5 · 500"]]
);

check(
    "siege, seize, bait, loot, nuke, boost demand",
    texts(
        militaryRows(
            {
                duos: {},
                sieges: { W29N3: { owner: "Foe", since: 90000, bases: ["W27N5"], rally: "W27N5", losses: 0, attacks: 4, level: 3, downgrade: 112000 } },
                baits: { W24N7: { failures: 1, since: 99800, base: "W25N8", sent: true }, W20N1: { failures: 2 } },
                loot: { W28N3: { home: "W27N5", since: 95000, until: 110000, rooms: 2, amount: 45000, looted: 12000 } },
                nukes: { W28N3: { x: 25, y: 20, landTime: 140000, from: "W27N5", value: 1 } },
                boostDemand: { home: "W27N5", target: "W28N3", compounds: { XGHO2: 600, XLHO2: 900 }, since: 99000, credits: 20000 }
            },
            { W24N8: { player: "Blindfold", since: 95000, until: 104000, seize: true }, W23N8: { player: "Other", since: 95000, until: 104000 } },
            TIME,
            alive([])
        )
    ),
    [
        ["siege", "W29N3", "Foe", "RCL 3 · 4 attacks · 12.0k to downgrade"],
        ["seize", "W24N8", "Blindfold", "4000 left"],
        ["bait", "W24N7", "from W25N8", "sent · 1 failed"],
        ["loot", "W28N3", "45.0k left", "12.0k home"],
        ["nuke", "W28N3", "25,20", "lands in 40.0k"],
        ["boosts", "W28N3", "W27N5 · 1500", "XGHO2 XLHO2"]
    ]
);

const many = {};
for (let i = 0; i < 20; i++) many[`W${i}N1`] = { home: "W27N5", since: 95000, until: 110000, rooms: 2, amount: 100, looted: 0 };
const capped = texts(militaryRows({ duos: {}, loot: many }, {}, TIME, alive([])));
check("section capped at 12 rows, the rest counted", [capped.length, capped[11]], [12, ["", "+9 more", "", ""]]);

check(
    "the 3 latest results of the last 20k ticks, newest first",
    texts(
        militaryRows(
            {
                duos: {},
                log: [
                    { room: "W1N1", result: "success", time: 70000, losses: 0 },
                    { room: "W2N2", result: "abandoned", time: 90000, losses: 4 },
                    { room: "W3N3", result: "success", time: 95000, losses: 1 },
                    { room: "W4N4", result: "safeMode", time: 97000, losses: 0 },
                    { room: "W5N5", result: "taken", time: 99000, losses: 2 }
                ]
            },
            {},
            TIME,
            alive([])
        )
    ),
    [
        ["taken", "W5N5", "lost 2", "1000 ago"],
        ["safeMode", "W4N4", "", "3000 ago"],
        ["success", "W3N3", "lost 1", "5000 ago"]
    ]
);

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
