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
    reservationValue, reserverCpu, reserverClaimParts, reserverCost, sourceCpu, cpuPressure,
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

// shard0 W27N5, second dump: 15/20 CPU, bucket full, capped at 7
const capped = { cpuAvg: 15, limit: 20, bucket: 10000, fullBucketTicks: 0, maxRooms: 7, currentRooms: 7, possibleRooms: 9 };
check("75% CPU with a fresh full bucket keeps the cap", budgetRooms(capped) === 7);
check("a bucket full for 1000 ticks allows one more room", budgetRooms({ ...capped, fullBucketTicks: 1000 }) === 8);
check("below 75% one more room", budgetRooms({ ...capped, cpuAvg: 14.9 }) === 8);
check("one more than possible lifts the cap", budgetRooms({ ...capped, maxRooms: 9, fullBucketTicks: 2000 }) === undefined);
check("above 95% drops a room even with a full bucket", budgetRooms({ ...capped, cpuAvg: 19.1, fullBucketTicks: 5000 }) === 6);
check("a low bucket drops a room", budgetRooms({ ...capped, cpuAvg: 10, bucket: 4000 }) === 6);
check("uncapped stays uncapped below 95%", budgetRooms({ ...capped, maxRooms: undefined, cpuAvg: 18 }) === undefined);

// Reservations under CPU pressure: energy added per CPU added, against a neutral source's energy per CPU
const fmt = v => `+${v.energy.toFixed(2)} energy for ${v.cpu.toFixed(3)} CPU = ${v.perCpu.toFixed(1)}/CPU vs ${v.alternative.toFixed(1)}`;
const room = (distance, roads = false) => ({ generation: 10, distance, roads, maintenanceWork: 0 });
for (const [capacity, distance, n] of [[650, 50, 1], [650, 50, 2], [1300, 50, 1], [1300, 50, 2], [1300, 120, 1], [1950, 80, 1], [1800, 50, 1]]) {
    console.log(`reservation ${n} source(s), ${distance} tiles, ${capacity} capacity: ${fmt(reservationValue(room(distance), n, capacity))}`);
}
const oneSmall = reservationValue(room(50), 1, 650);
const twoSmall = reservationValue(room(50), 2, 650);
const oneBig = reservationValue(room(50), 1, 1300);
check("1-CLAIM reservers: a one-source room doesn't pay per CPU", !oneSmall.pays, fmt(oneSmall));
check("1-CLAIM reservers: a two-source room pays per CPU", twoSmall.pays, fmt(twoSmall));
check("2-CLAIM reservers, one at a time: a one-source room still doesn't pay per CPU", !oneBig.pays, fmt(oneBig));
check("2-CLAIM reservers: a two-source room pays per CPU", reservationValue(room(50), 2, 1300).pays);
check("a far one-source room pays even less", !reservationValue(room(120), 1, 1300).pays);
check("a second source doubles the reservation's energy", twoSmall.energy > 2 * oneSmall.energy);
check("a 2-CLAIM reserver costs half the CPU per tick of a 1-CLAIM one", Math.abs(reserverCpu(2, 50) * 2 - reserverCpu(1, 50)) < 1e-9);
check("reserver CPU: 600 x (code + reserve intent) over 550 ticks", Math.abs(reserverCpu(1, 50) - (600 * 0.26) / 550) < 1e-9, reserverCpu(1, 50).toFixed(3));
check("claim parts by capacity", reserverClaimParts(649) === 0 && reserverClaimParts(1300) === 2 && reserverClaimParts(1800) === 2 && reserverClaimParts(10000) === 8);
check("bigger haulers: fewer CPU per energy", sourceCpu(room(50), 26) < sourceCpu(room(50), 6));

// The score of a reserved room under pressure: the CPU-priced reserver brings a one-source room close to its neutral income
const neutral = sourceNet({ ...room(50), generation: 5 });
const reservedScore = sourceNet(room(50)) - reserverCost(50, true);
const plainScore = sourceNet(room(50)) - reserverCost(50, false);
console.log(`one source at 50 tiles: neutral ${neutral.toFixed(2)}, reserved ${plainScore.toFixed(2)}, reserved with CPU priced ${reservedScore.toFixed(2)}`);
check("no pressure: the reserver costs its energy only", Math.abs(reserverCost(50, false) - 650 / 550) < 1e-9);
check("under pressure the reserved score of a one-source room drops near its neutral income", reservedScore < plainScore && Math.abs(reservedScore - neutral) < 1.5, `${reservedScore.toFixed(2)} vs ${neutral.toFixed(2)}`);
check("no Memory: no pressure", cpuPressure() === false);

process.exit(failures ? 1 : 0);
