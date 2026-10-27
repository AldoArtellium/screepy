/**
 * Offline check of military/roi: a target is only attacked automatically when what it brings (loot in
 * energy, remote income a stronghold blocks, a player's infamy) pays for the squad and its
 * replacements; the best return wins, the current target is kept unless another does clearly better.
 * Players that look stronger (playerThreat.ts) are left alone unless their creeps hurt us.
 *
 *   node tests/militaryRoi/run.mjs
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(tmpdir(), "screepy-militaryroi-build");
const require = createRequire(import.meta.url);

try {
    execFileSync(
        process.execPath,
        [
            join(ROOT, "node_modules", "typescript", "bin", "tsc"),
            "--outDir", OUT, "--rootDir", join(ROOT, "src"), "--module", "commonjs", "--target", "es2019", "--skipLibCheck",
            "--types", "screeps,lodash",
            join(ROOT, "src", "military", "roi.ts"),
            join(ROOT, "src", "military", "playerThreat.ts"),
            join(ROOT, "src", "military", "strategy.ts"),
        ],
        { stdio: "pipe" }
    );
} catch {
    // Type errors outside these files (global declarations) don't prevent emitting
}

const { squadCost, remoteValue, lootValue, targetValue, pickTarget, ATTRITION, MIN_ROI, CURRENT_BONUS } = require(join(OUT, "military", "roi.js"));

let failures = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
    if (!ok) failures++;
};

// Squad cost: every member's body, ATTRITION times (replacements of the creeps lost)
check("ATTRITION is 2", ATTRITION === 2);
check("squad cost: 4 members of 1000", squadCost([1000, 1000, 1000, 1000]) === 8000, squadCost([1000, 1000, 1000, 1000]));
// Boosts: the replacements are boosted too (12 HEAL parts of XLHO2 at ~50 energy each)
check("squad cost: boosts with the replacements", squadCost([1000, 1000, 1000, 1000], ATTRITION, 600) === 9200, squadCost([1000, 1000, 1000, 1000], ATTRITION, 600));

// Spawn time: the income a saturated spawn would have made in the ticks the squad takes (shard0 W29N7,
// 2026-10-25: one spawn 88% busy, ~50 energy per tick, quad of 40 + 40 + 16 + 16 parts)
const { spawnTimeCost, SPAWN_SATURATED } = require(join(OUT, "military", "roi.js"));
const quadParts = [40, 40, 16, 16];
const w29n7 = spawnTimeCost(quadParts, 1, 50, 0.88);
check("SPAWN_SATURATED is 0.8", SPAWN_SATURATED === 0.8);
check("W29N7 quad: 112 parts x 3 ticks x 2 x 50 energy", w29n7 === 33600, w29n7);
check("two spawns halve it", spawnTimeCost(quadParts, 2, 50, 0.88) === 16800, spawnTimeCost(quadParts, 2, 50, 0.88));
check("a spawn 40% busy pays half", spawnTimeCost(quadParts, 1, 50, 0.4) === 16800, spawnTimeCost(quadParts, 1, 50, 0.4));
check("no income: free", spawnTimeCost(quadParts, 1, 0, 0.9) === 0);
check("no spawn: free", spawnTimeCost(quadParts, 0, 50, 0.9) === 0);
// W27N9 (132k loot, roi 6.75 on spawn energy alone) still pays with W29N7's spawn time
const w27n9 = 132442 / (squadCost([2250, 2250, 2200, 2200]) + w29n7);
check("W27N9 still pays from W29N7", w27n9 > MIN_ROI && w27n9 < 3, w27n9.toFixed(2));
// RCL 7 quad (mockup W7N3 --preset rcl7, 5600 capacity): ~4000 per member
const quadRcl7 = squadCost([4000, 4000, 4000, 4000]);

// Loot in energy: market price ratio, 1 without prices
const prices = { energy: 1, purifier: 40, utrium_bar: 20 };
check("loot value with prices", lootValue({ purifier: 22, energy: 100 }, r => prices[r] ?? 1) === 22 * 40 + 100);
check("loot value without prices", lootValue({ purifier: 22 }, () => 1) === 22);

// Remote income a stronghold blocks: 3 energy/tick per source, until its collapse, at most 10000 ticks
check("remote value: 2 sources, collapse far", remoteValue(2, 70000) === 2 * 3 * 10000, remoteValue(2, 70000));
check("remote value: collapse in 1000 ticks", remoteValue(2, 1000) === 6000);
check("remote value: no source", remoteValue(0, 70000) === 0);
check("remote value: already collapsed", remoteValue(2, -50) === 0);

// Level 1 stronghold with no source around (only its loot): not worth a quad
const lone = targetValue({ loot: 100, remote: 0, infamy: 0 }) / quadRcl7;
check("L1 stronghold without remote: ROI < 1", lone < MIN_ROI, lone.toFixed(3));
// Same stronghold in a two-source room next to ours, collapse far away: worth it (mockup W7N4)
const blocking = targetValue({ loot: 100, remote: remoteValue(2, 70000), infamy: 0 }) / quadRcl7;
check("L1 stronghold blocking 2 sources: ROI >= 1", blocking >= MIN_ROI, blocking.toFixed(2));
// Collapsing soon: the remote frees itself
const collapsing = targetValue({ loot: 100, remote: remoteValue(2, 1000), infamy: 0 }) / quadRcl7;
check("stronghold collapsing in 1000 ticks: ROI < 1", collapsing < MIN_ROI, collapsing.toFixed(2));

// Squad CPU (mockup W7N3 --preset rcl7 --stronghold W7N4:1: ~1900 official CPU for 12 quad creeps spawned)
const { squadCpu, SQUAD_CREEP_CPU, freedSources } = require(join(OUT, "military", "roi.js"));
check("SQUAD_CREEP_CPU is 160", SQUAD_CREEP_CPU === 160);
check("squad CPU: 4 members with their replacements", squadCpu(4) === 4 * ATTRITION * 160, squadCpu(4));
// Under CPU pressure the CPU is priced at a neutral remote source's energy per CPU (neutralEnergyPerCpu
// at 50 tiles: 8.4 at 1300 capacity, 9.8 at 1800, 10.9 at 2300, 11.2 at 5600)
const quadWithCpu = quadRcl7 + squadCpu(4) * 11.2;
const blockingCpu = targetValue({ loot: 100, remote: remoteValue(2, 70000), infamy: 0 }) / quadWithCpu;
check("CPU priced: the quad costs ~45% more at RCL 7", quadWithCpu / quadRcl7 > 1.4 && quadWithCpu / quadRcl7 < 1.5, (quadWithCpu / quadRcl7).toFixed(2));
check("CPU priced: L1 stronghold blocking 2 sources still pays", blockingCpu >= MIN_ROI, blockingCpu.toFixed(2));
// A small player target worth its loot alone no longer pays once the CPU is priced
const smallLoot = targetValue({ loot: 30000, remote: 0, infamy: 4000 });
check("player loot 34k: pays on energy alone", smallLoot / quadRcl7 >= MIN_ROI, (smallLoot / quadRcl7).toFixed(2));
check("player loot 34k: doesn't pay with the CPU priced", smallLoot / quadWithCpu < MIN_ROI, (smallLoot / quadWithCpu).toFixed(2));

// Sources a player's room frees when it falls: its own and the rooms it reserves (closest room of that
// player, strictly), within reach of our rooms. shard0 2026-10-25 around W28N7 (doorknobnob)
const coords = name => {
    const m = /^([WE])(\d+)([NS])(\d+)$/.exec(name);
    return [m[1] === "W" ? -1 - +m[2] : +m[2], m[3] === "N" ? -1 - +m[4] : +m[4]];
};
const dist = (a, b) => {
    const [ax, ay] = coords(a);
    const [bx, by] = coords(b);
    return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
};
const T0 = 78559200;
const shard0 = [
    { room: "W28N8", owner: "doorknobnob", sources: 2, scouted: T0 - 7000 },
    { room: "W27N9", owner: "doorknobnob", sources: 2, scouted: T0 - 7000 },
    { room: "W27N7", reserver: "doorknobnob", sources: 2, scouted: T0 - 100 },
    { room: "W27N8", reserver: "doorknobnob", sources: 1, scouted: T0 - 100 },
    { room: "W28N9", reserver: "doorknobnob", sources: 2 },
    { room: "W25N8", reserver: "asdpof", sources: 2, scouted: T0 - 100 },
];
const ours = ["W28N7", "W29N7", "W27N5", "W24N8"];
// W28N8: its 2 sources and W27N7 (closest to it); W27N8 and W28N9 are as close to W27N9: still reserved
check("freed by W28N8: its sources and W27N7", freedSources("W28N8", "doorknobnob", shard0, ours, dist, T0) === 4, freedSources("W28N8", "doorknobnob", shard0, ours, dist, T0));
// W27N9 alone: 2 rooms from W28N7, its sources count; W27N8 and W28N9 tie with W28N8
check("freed by W27N9: its own sources", freedSources("W27N9", "doorknobnob", shard0, ours, dist, T0) === 2, freedSources("W27N9", "doorknobnob", shard0, ours, dist, T0));
// Once W28N8 has fallen, W27N9 frees every room it reserves
const after = shard0.filter(r => r.room !== "W28N8");
check("freed by W27N9 once alone: everything around", freedSources("W27N9", "doorknobnob", after, ours, dist, T0) === 2 + 2 + 1 + 2, freedSources("W27N9", "doorknobnob", after, ours, dist, T0));
check("another player's reservations never count", freedSources("W28N8", "asdpof", shard0, ours, dist, T0) === 0);
check("a room out of our reach frees nothing", freedSources("W28N8", "doorknobnob", shard0, ["W20N1"], dist, T0) === 0);
// A reservation seen more than 5000 ticks ago may have run out (a reservation lasts at most 5000 ticks)
const stale = shard0.map(r => (r.room === "W27N7" ? { ...r, scouted: T0 - 5001 } : r));
check("a stale reservation frees nothing", freedSources("W28N8", "doorknobnob", stale, ours, dist, T0) === 2, freedSources("W28N8", "doorknobnob", stale, ours, dist, T0));
check("a reservation seen 5000 ticks ago still counts", freedSources("W28N8", "doorknobnob", shard0.map(r => (r.room === "W27N7" ? { ...r, scouted: T0 - 5000 } : r)), ours, dist, T0) === 4);

// Picking: best ROI at least MIN_ROI, the current target kept unless another beats it x CURRENT_BONUS
check("CURRENT_BONUS is 1.5", CURRENT_BONUS === 1.5);
const a = { room: "A", roi: 1.5 };
const b = { room: "B", roi: 2.0 };
const c = { room: "C", roi: 2.5 };
check("nothing pays: no target", pickTarget([{ room: "X", roi: 0.4 }], undefined) === null);
check("best ROI wins", pickTarget([a, b, c], undefined)?.room === "C");
check("current kept against a slightly better one", pickTarget([a, b], "A")?.room === "A");
check("current replaced by a clearly better one", pickTarget([a, c], "A")?.room === "C");
check("current below MIN_ROI dropped", pickTarget([{ room: "A", roi: 0.8 }], "A") === null);
// Engaged (squad creeps alive or spawning): kept while still a candidate (shard0 W27N5: a forming duo
// against W29N3 was recycled when W27N9 scored 6.75)
check("engaged current kept against a clearly better one", pickTarget([a, c], "A", true)?.room === "A");
check("engaged current kept below MIN_ROI", pickTarget([{ room: "A", roi: 0.8 }, c], "A", true)?.room === "A");
check("engaged current no longer a candidate: replaced", pickTarget([b, c], "A", true)?.room === "C");

// --- Raids: rooms with loot and no defense, looted without a squad ---
const { isRaidable, lootersNeeded, raidCost, RAID_MIN_LOOT, RAID_INTEL_AGE } = require(join(OUT, "military", "roi.js"));
const NOW = 100000;
const MAX_BARRIER = 200000;
const abandoned = { t: NOW - 100, loot: 50000, towers: 0, spawns: 0, barrier: 0, damage: 0, heal: 0 };
check("RAID_MIN_LOOT is 10000", RAID_MIN_LOOT === 10000);
check("raid: abandoned storage, no tower", isRaidable(abandoned, NOW, MAX_BARRIER));
check("raid: towers with energy", !isRaidable({ ...abandoned, towers: 1, towerEnergy: 500 }, NOW, MAX_BARRIER));
check("raid: empty tower", isRaidable({ ...abandoned, towers: 1, towerEnergy: 0 }, NOW, MAX_BARRIER));
check("raid: armed creeps seen", !isRaidable({ ...abandoned, damage: 30 }, NOW, MAX_BARRIER));
check("raid: safe mode", !isRaidable({ ...abandoned, safeMode: NOW + 10 }, NOW, MAX_BARRIER));
check("raid: stronghold", !isRaidable({ ...abandoned, coreLevel: 1 }, NOW, MAX_BARRIER));
check("raid: rampart too strong to dismantle", !isRaidable({ ...abandoned, lootBarrier: 300000 }, NOW, MAX_BARRIER));
check("raid: rampart a dismantler opens", isRaidable({ ...abandoned, lootBarrier: 100000 }, NOW, MAX_BARRIER));
check("raid: too little loot", !isRaidable({ ...abandoned, loot: 5000 }, NOW, MAX_BARRIER));
check("raid: stale intel", !isRaidable({ ...abandoned, t: NOW - RAID_INTEL_AGE - 1 }, NOW, MAX_BARRIER));

// Looters (Overmind DirectiveHaul): amount x 2 x route tiles / (1500 x capacity), 1 to 3
check("looters: 50k one room away, 1250 capacity", lootersNeeded(50000, 1, 1250) === 3, lootersNeeded(50000, 1, 1250));
check("looters: 1000 units", lootersNeeded(1000, 1, 1250) === 1);
check("looters: nothing left", lootersNeeded(0, 1, 1250) === 0);
// Cost: looters + a dismantler when ramparts cover the loot
check("raid cost with ramparts", raidCost(50000, 1, 2500, 1250, 3750, true) === 3 * 2500 + 3750, raidCost(50000, 1, 2500, 1250, 3750, true));
check("raid cost without ramparts", raidCost(50000, 1, 2500, 1250, 3750, false) === 3 * 2500);

// Player size (playerThreat.ts): rooms seen owned. shard0 2026-10-26: Blindfold (GCL ~9) with 6 rooms
// seen, we own 4.
const {
    playerRoomCounts, looksStronger, aggressionFromEvents, decayAggression, AGGRESSION_HOSTILE, ROOMS_SEEN_AGE
} = require(join(OUT, "military", "playerThreat.js"));
const T = 78581400;
const blindfold = ["W28N3", "W26N3", "W24N3", "W23N4", "W27N2", "W25N7"].map(room => ({ room, owner: "Blindfold", seen: T - 2000 }));
const seenRooms = [
    ...blindfold,
    // The static intel lists the same room: counted once
    { room: "W25N7", owner: "Blindfold", seen: T - 100 },
    { room: "W28N8", owner: "doorknobnob", seen: T - 500 },
    { room: "W27N9", owner: "doorknobnob", seen: T - 500 },
    // Seen too long ago
    { room: "W20N1", owner: "doorknobnob", seen: T - ROOMS_SEEN_AGE - 1 },
    // Lost since: the freshest record wins
    { room: "W29N3", owner: "doorknobnob", seen: T - 9000 },
    { room: "W29N3", owner: undefined, seen: T - 100 },
];
const counts = playerRoomCounts(seenRooms, T);
check("Blindfold: 6 distinct rooms", counts.Blindfold === 6, JSON.stringify(counts));
check("doorknobnob: 2 rooms (stale and lost ones left out)", counts.doorknobnob === 2, JSON.stringify(counts));
check("6 rooms against our 4: stronger", looksStronger(6, 4));
check("equal rooms: not stronger (mockup enemy bot, 1 against 1)", !looksStronger(1, 1));

// Aggression from the event log: their creeps' damage on ours, hits back and unknown attackers left out
const owners = { a1: "Blindfold", a2: "doorknobnob" };
const ourIds = new Set(["c1", "s1"]);
const events = [
    { event: 1, objectId: "a1", data: { targetId: "c1", damage: 120, attackType: 1 } },
    { event: 1, objectId: "a1", data: { targetId: "s1", damage: 50, attackType: 4 } },
    // Our melee creep hit theirs and took the hit back: our aggression
    { event: 1, objectId: "a2", data: { targetId: "c1", damage: 60, attackType: 5 } },
    // Their creep on someone else's creep
    { event: 1, objectId: "a2", data: { targetId: "x1", damage: 90, attackType: 2 } },
    // Our creep attacking theirs (we are not in the owner table)
    { event: 1, objectId: "c1", data: { targetId: "a1", damage: 300, attackType: 1 } },
    // Not an attack (harvest)
    { event: 5, objectId: "a2", data: { targetId: "c1", amount: 10 } },
];
const damage = aggressionFromEvents(events, id => owners[id], id => ourIds.has(id));
check("aggression: melee + dismantle on ours", damage.Blindfold === 170, JSON.stringify(damage));
check("aggression: hit back and other targets ignored", damage.doorknobnob === undefined, JSON.stringify(damage));
const aggression = { Blindfold: 400, doorknobnob: 1.02 };
decayAggression(aggression);
check("decay x0.95", Math.abs(aggression.Blindfold - 380) < 1e-9, aggression.Blindfold);
check("decay drops players below 1", aggression.doorknobnob === undefined, JSON.stringify(aggression));

// --- Strategic interest (strategy.ts): a player's room is only attacked for a reason that serves our
// growth. shard0 2026-10-26 (tick 78586437): 5 missions in ~25000 ticks, 17 creeps lost, no player had
// hurt us (aggression empty) and the remote budget was full (6 of 6 rooms), so no freed source was usable.
const {
    spareRemoteRooms, usableSources, isAggressor, blocksExpansion, playerReason, AGGRESSION_RETALIATE, SOURCES_PER_ROOM
} = require(join(OUT, "military", "strategy.js"));
check("AGGRESSION_RETALIATE is 3000", AGGRESSION_RETALIATE === 3000);
check("SOURCES_PER_ROOM is 2", SOURCES_PER_ROOM === 2);

// Remote budget room left for freed sources
check("budget uncapped: no limit", spareRemoteRooms(undefined, 7) === Infinity);
check("shard0 budget full (6 of 6): no room", spareRemoteRooms(6, 6) === 0);
check("budget dropped below the rooms mined: no room", spareRemoteRooms(5, 6) === 0);
check("one free room", spareRemoteRooms(7, 6) === 1);
check("usable: budget full", usableSources(4, 0) === 0);
check("usable: one free room takes at most 2 sources", usableSources(4, 1) === 2);
check("usable: uncapped", usableSources(4, Infinity) === 4);
check("usable: nothing freed", usableSources(0, Infinity) === 0);

// Aggressors: AGGRESSION_HOSTILE for a player no stronger than us, AGGRESSION_RETALIATE for a stronger one
check("weaker player: aggressor from AGGRESSION_HOSTILE", isAggressor(AGGRESSION_HOSTILE, false));
check("weaker player: not below", !isAggressor(AGGRESSION_HOSTILE - 1, false));
check("stronger player: not at AGGRESSION_HOSTILE", !isAggressor(AGGRESSION_HOSTILE, true));
check("stronger player: not just below AGGRESSION_RETALIATE", !isAggressor(AGGRESSION_RETALIATE - 1, true));
check("stronger player: from AGGRESSION_RETALIATE", isAggressor(AGGRESSION_RETALIATE, true));

// Expansion: the player reserves our expansion target from its closest room (strictly), or claimed it
check("W28N8 reserves the expansion target W27N7", blocksExpansion("W28N8", "doorknobnob", "W27N7", shard0, dist, T0));
check("W27N9 is farther from W27N7 than W28N8", !blocksExpansion("W27N9", "doorknobnob", "W27N7", shard0, dist, T0));
check("no expansion target", !blocksExpansion("W28N8", "doorknobnob", undefined, shard0, dist, T0));
check("another player's reservation", !blocksExpansion("W28N8", "doorknobnob", "W25N8", shard0, dist, T0));
check("stale reservation", !blocksExpansion("W28N8", "doorknobnob", "W27N7", stale, dist, T0));
const claimed = [...shard0, { room: "W26N6", owner: "doorknobnob", sources: 2, scouted: T0 - 100 }];
check("the player claimed our expansion target", blocksExpansion("W26N6", "doorknobnob", "W26N6", claimed, dist, T0));
check("W28N8 tied with W27N9 for W28N9: not alone to blame", !blocksExpansion("W28N8", "doorknobnob", "W28N9", shard0.map(r => (r.room === "W28N9" ? { ...r, scouted: T0 } : r)), dist, T0));

// Reasons
const facts = { aggression: 0, stronger: false, usableSources: 0, blocksExpansion: false };
check("W29N3 (DoctorCat92) with the budget full: no reason", playerReason(facts) === null);
check("free budget room for its sources: territory", playerReason({ ...facts, usableSources: 2 }) === "territory");
check("reserving our expansion target: expansion", playerReason({ ...facts, blocksExpansion: true }) === "expansion");
check("hurt us: aggressor first", playerReason({ ...facts, aggression: AGGRESSION_HOSTILE, usableSources: 2 }) === "aggressor");
check("Blindfold W25N7 (stronger), sources usable: no reason", playerReason({ ...facts, stronger: true, usableSources: 2 }) === null);
check("Blindfold blocking our expansion: no reason", playerReason({ ...facts, stronger: true, blocksExpansion: true }) === null);
check("Blindfold after 300 hits: no reason", playerReason({ ...facts, stronger: true, aggression: AGGRESSION_HOSTILE }) === null);
check("Blindfold after 3000 hits: aggressor", playerReason({ ...facts, stronger: true, aggression: AGGRESSION_RETALIATE }) === "aggressor");

// Encroachers (strategy.ts isEncroacher): shard0 2026-10-27, Blindfold (8 rooms, GCL 8) rebuilt W25N7 (RCL 3,
// 1 tower, unarmed creeps) next to W24N8 and took W24N7, W24N8's only reachable remote
const { isEncroacher, ENCROACHER_RANGE, ENCROACHER_MAX_RCL, ENCROACHER_MAX_TOWERS } = require(join(OUT, "military", "strategy.js"));
const w25n7 = { distance: 1, rcl: 3, towers: 1, damage: 0 };
check("W25N7 next to W24N8 is an encroacher", isEncroacher(w25n7));
check("range 2 still counts", isEncroacher({ ...w25n7, distance: ENCROACHER_RANGE }));
check("3 rooms away: no", !isEncroacher({ ...w25n7, distance: ENCROACHER_RANGE + 1 }));
check("RCL 4: no", !isEncroacher({ ...w25n7, rcl: ENCROACHER_MAX_RCL + 1 }));
check("2 towers: no", !isEncroacher({ ...w25n7, towers: ENCROACHER_MAX_TOWERS + 1 }));
check("armed creeps seen: no", !isEncroacher({ ...w25n7, damage: 30 }));
check("rebuilding at RCL 1 without tower", isEncroacher({ ...w25n7, rcl: 1, towers: 0 }));
check("Blindfold W25N7 (stronger), encroacher: encroacher", playerReason({ ...facts, stronger: true, encroacher: true }) === "encroacher");
check("weaker encroacher with usable sources: encroacher", playerReason({ ...facts, usableSources: 2, encroacher: true }) === "encroacher");
// Phase 4: once the player answers (AGGRESSION_HOSTILE), no more encroacher attacks on a stronger player
check("stronger encroacher that hit back 300: left alone", playerReason({ ...facts, stronger: true, encroacher: true, aggression: AGGRESSION_HOSTILE }) === null);
check("stronger encroacher that hit back 3000: aggressor", playerReason({ ...facts, stronger: true, encroacher: true, aggression: AGGRESSION_RETALIATE }) === "aggressor");

// Rooms released by a player's fallen room (roi.ts releasedRooms): the target and the rooms reserved from it
const { releasedRooms } = require(join(OUT, "military", "roi.js"));
const blindfoldRooms = [
    { room: "W25N7", owner: "Blindfold", sources: 1, scouted: T0 - 100 },
    { room: "W24N7", reserver: "Blindfold", sources: 1, scouted: T0 - 400 },
    { room: "W24N3", owner: "Blindfold", sources: 2, scouted: T0 - 100 },
    { room: "W24N4", reserver: "Blindfold", sources: 1, scouted: T0 - 100 },
    { room: "W25N8", reserver: "asdpof", sources: 2, scouted: T0 - 100 },
];
check("W25N7 releases itself and W24N7", releasedRooms("W25N7", "Blindfold", blindfoldRooms, dist, T0).join() === "W25N7,W24N7", releasedRooms("W25N7", "Blindfold", blindfoldRooms, dist, T0).join());
check("not another player's reservation", !releasedRooms("W25N7", "Blindfold", blindfoldRooms, dist, T0).includes("W25N8"));
check("not a room closer to another of their rooms", !releasedRooms("W25N7", "Blindfold", blindfoldRooms, dist, T0).includes("W24N4"));
check("a stale reservation is not released", releasedRooms("W25N7", "Blindfold", blindfoldRooms.map(r => (r.room === "W24N7" ? { ...r, scouted: T0 - 6000 } : r)), dist, T0).join() === "W25N7");

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
