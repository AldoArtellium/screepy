/**
 * Offline check of remote/remoteIncome: creeps a remote source keeps alive for homes of different
 * energy capacities, the energy per creep the CPU budget ranks remote rooms by, and the budget's
 * CPU average and cap decisions.
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
    CONTROLLER_RESERVE_MAX: 5000, SOURCE_ENERGY_CAPACITY: 3000, SOURCE_ENERGY_NEUTRAL_CAPACITY: 1500, ENERGY_REGEN_TIME: 300,
});

const {
    sourceCreeps, sourceNet, roomEnergyPerCreep, cpuAverage, budgetRooms,
    reserverCost, cpuPressure, expansionCpuFits,
} = require(join(OUT, "remote", "remoteIncome.js"));

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

// CPU budget: the average of every tick, a global reset spike barely moves it
let avg;
for (let i = 0; i < 40; i++) avg = cpuAverage(avg, 20 * 16.5, 20);
const spiked = cpuAverage(avg, 19 * 16.5 + 93, 20);
check("the CPU average is the tick average", Math.abs(avg - 16.5) < 1e-9, avg.toFixed(2));
check("a 93 CPU tick moves the average by less than 0.3", spiked - avg < 0.3, (spiked - avg).toFixed(3));
let longAvg = 10;
for (let i = 0; i < 20; i++) longAvg = cpuAverage(longAvg, 20 * 20, 20);
check("400 ticks at a new level cover most of the way", longAvg > 16 && longAvg < 17, longAvg.toFixed(2));
check("no sample keeps the average", cpuAverage(12, 0, 0) === 12);

// shard0 W27N5, second dump: 15/20 CPU, bucket full, capped at 7 (it used to stay capped there)
const capped = { cpuAvg: 15, limit: 20, bucket: 10000, maxRooms: 7, currentRooms: 7, possibleRooms: 9 };
check("75% CPU with a full bucket allows one more room", budgetRooms(capped) === 8);
check("a bucket below 9000 keeps the cap", budgetRooms({ ...capped, bucket: 8900 }) === 7);
check("one more than possible lifts the cap", budgetRooms({ ...capped, maxRooms: 9 }) === undefined);
check("above 95% keeps the cap while the bucket holds 8000", budgetRooms({ ...capped, cpuAvg: 19.1 }) === 7);
check("above 95% keeps the cap on a dip to 8900 (hysteresis)", budgetRooms({ ...capped, cpuAvg: 19.1, bucket: 8900 }) === 7);
check("above 95% drops a room once the bucket is below 8000", budgetRooms({ ...capped, cpuAvg: 19.1, bucket: 7900 }) === 6);
check("above the limit drops a room whatever the bucket", budgetRooms({ ...capped, cpuAvg: 20.1 }) === 6);
check("a low bucket drops a room", budgetRooms({ ...capped, cpuAvg: 10, bucket: 4000 }) === 6);
check("uncapped stays uncapped below 95%", budgetRooms({ ...capped, maxRooms: undefined, cpuAvg: 18 }) === undefined);

// One more room must fit under 95% of the limit with its measured CPU (shard0 2026-10-25: a room 0.86 with its moves)
check("18.0 + a measured 0.86 room fits", budgetRooms({ ...capped, cpuAvg: 18, roomCpu: 0.86 }) === 8);
check("18.46 + a measured 0.86 room does not fit", budgetRooms({ ...capped, cpuAvg: 18.46, roomCpu: 0.86 }) === 7);
check("a measured room of 0.5 CPU still counts 0.8", budgetRooms({ ...capped, cpuAvg: 18.3, roomCpu: 0.5 }) === 7);
check("a room that fits is added", budgetRooms({ ...capped, limit: 10, cpuAvg: 7.4, roomCpu: 1.5 }) === 8);
check("a room that does not fit is not", budgetRooms({ ...capped, limit: 10, cpuAvg: 7.4, roomCpu: 2.2 }) === 7);
// Hysteresis after a drop
check("no room added within 5000 ticks of a drop", budgetRooms({ ...capped, cpuAvg: 12, ticksSinceDrop: 4999 }) === 7);
check("a room added 5000 ticks after a drop", budgetRooms({ ...capped, cpuAvg: 12, ticksSinceDrop: 5000 }) === 8);
check("the hold never delays a drop", budgetRooms({ ...capped, cpuAvg: 19.5, bucket: 7500, ticksSinceDrop: 10 }) === 6);
check("the hold keeps an uncapped budget uncapped", budgetRooms({ ...capped, maxRooms: undefined, cpuAvg: 12, ticksSinceDrop: 10 }) === undefined);
check("the reserver costs its energy over its time on station", Math.abs(reserverCost(50) - 650 / 550) < 1e-9);
check("no Memory: no pressure", cpuPressure() === false);

// Expansion CPU gate (Hivemind getCpuStats): 80% of the limit below 5 remote rooms, the whole limit from 5
// (the remote budget then drops remote rooms to make room for the new one)
check("expansion: few remotes, under 80%", expansionCpuFits(15.9, 20, 4));
check("expansion: few remotes, over 80%", !expansionCpuFits(16.1, 20, 4));
// shard0 2026-10-25: 8 remote rooms, ~18 of 20 CPU, blocked by the 80% rule taken from the owned room count
check("expansion: 8 remotes at 18/20 (shard0)", expansionCpuFits(18, 20, 8));
check("expansion: 5 remotes, over the limit", !expansionCpuFits(20.5, 20, 5));
check("expansion: no CPU average yet", !expansionCpuFits(undefined, 20, 8));

process.exit(failures ? 1 : 0);
