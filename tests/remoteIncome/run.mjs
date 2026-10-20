/**
 * Offline check of remote/remoteIncome: creeps a remote source keeps alive for homes of different
 * energy capacities, and the energy per creep the CPU budget ranks remote rooms by.
 *
 *   node tests/remoteIncome/run.mjs
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(tmpdir(), "screepy-remoteincome-build");
const require = createRequire(import.meta.url);

try {
    execFileSync(
        process.execPath,
        [
            join(ROOT, "node_modules", "typescript", "bin", "tsc"),
            "--outDir", OUT, "--rootDir", join(ROOT, "src"), "--module", "commonjs", "--target", "es2019", "--skipLibCheck",
            "--types", "screeps,lodash",
            join(ROOT, "src", "remote", "remoteIncome.ts"),
        ],
        { stdio: "pipe" }
    );
} catch {
    // Type errors outside this file (global declarations) don't prevent emitting
}

Object.assign(globalThis, {
    MOVE: "move", WORK: "work", CARRY: "carry", CLAIM: "claim",
    BODYPART_COST: { move: 50, work: 100, carry: 50, claim: 600 },
    MAX_CREEP_SIZE: 50, HARVEST_POWER: 2, CARRY_CAPACITY: 50, CREEP_LIFE_TIME: 1500, CREEP_CLAIM_LIFE_TIME: 600,
    CONTAINER_DECAY: 5000, CONTAINER_DECAY_TIME: 100, REPAIR_POWER: 100, CONTAINER_CAPACITY: 2000,
});

const { sourceCreeps, sourceNet, roomEnergyPerCreep } = require(join(OUT, "remote", "remoteIncome.js"));

let failures = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
    if (!ok) failures++;
};

// shard0 W28N8:24:32 from W28N7 (450 capacity, 43 tiles, neutral) vs W29N6:29:29 from W29N7 (1800, 54, reserved)
const small = { generation: 5, distance: 43, roads: false, maintenanceWork: 0 };
const big = { generation: 10, distance: 54, roads: false, maintenanceWork: 0 };
const smallCrew = sourceCreeps(small, 450, 3);
const bigCrew = sourceCreeps(big, 1800, 5);
console.log("450 capacity:", JSON.stringify(smallCrew), "1800 capacity:", JSON.stringify(bigCrew));

check("a big home mines a source with one harvester", bigCrew.harvesters > 0.99 && bigCrew.harvesters < 1.1, bigCrew.harvesters.toFixed(2));
check("a big home harvests the whole source", bigCrew.harvested === 1);
check("a small home needs several harvesters", smallCrew.harvesters >= 2, smallCrew.harvesters.toFixed(2));
check("a small home needs more haulers per energy", smallCrew.haulers / small.generation > bigCrew.haulers / big.generation);

// Free spots cap the harvesters: at 300 capacity one 1-WORK harvester on a single free tile mines 2 of 5 energy per tick
const cramped = sourceCreeps(small, 300, 1);
check("one free tile limits a small home's harvest", cramped.harvested === 0.4 && cramped.harvesters < 1.1, cramped.harvested.toFixed(2));

const perSmall = roomEnergyPerCreep([{ net: sourceNet(small), crew: smallCrew }], 0, 0);
const perBig = roomEnergyPerCreep([{ net: sourceNet(big), crew: bigCrew }], 1.1, 1);
console.log(`energy per creep: 450 home ${perSmall.toFixed(2)}, 1800 home ${perBig.toFixed(2)}`);
check("the big home's remote pays more energy per creep", perBig > perSmall * 1.5);

// Two sources share one reserver: better per creep than either alone
const two = roomEnergyPerCreep(
    [{ net: sourceNet(big), crew: bigCrew }, { net: sourceNet(big), crew: bigCrew }], 1.1, 1);
check("a two-source room pays more per creep than a one-source room", two > perBig);

process.exit(failures ? 1 : 0);
