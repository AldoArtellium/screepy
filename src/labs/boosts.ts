/**
 * Boosts: creeps marked at spawn time get their parts boosted at a lab reserved for each compound
 * before they start working. Ported from Hivemind (MIT), src/boost-manager.ts, spawn-manager.ts
 * (markForBoosting) and spawn-role/spawn-role.ts (generateCreepBoosts / getBestBoost).
 * Rules: docs/hivemind/hivemind-labs.md.
 *
 * Deviations: a boost request expires BOOST_TIMEOUT ticks after the creep is out of the spawn
 * (Hivemind: once ticksToLive < 70% of the lifetime, ~450 ticks), so a squad never waits long; the
 * best TOUGH boost is the lowest damage multiplier (Hivemind's getBestBoost picks the highest).
 * Economy creeps (upgraders) get partial boosts and keep working until a lab is ready (`working`).
 */

import { whenInRange } from "../core/movement";
import { structuresOfType, tickCache } from "../core/roomState";
import { countStat } from "../utils/stats";
import { log } from "../utils/logger";
import { BoostTable, pickBoost } from "./boostChoice";

declare global {
    interface Memory {
        /**
         * Hivemind Memory.boost: compounds and part counts per creep, compound per boost lab. `working`:
         * the creep does its job until a lab holds its compound and energy (economy roles).
         */
        boost?: {
            creeps: { [creepName: string]: { boosts: { [compound: string]: number }; until?: number; working?: boolean } };
            labs: { [labId: string]: ResourceConstant };
        };
    }
}

/** Boost effect name by body part (BOOSTS[part][compound][effect]) */
export type BoostEffect = "attack" | "heal" | "rangedAttack" | "damage" | "fatigue" | "repair" | "build" | "harvest" | "upgradeController" | "capacity" | "dismantle";

/** Compound and number of parts per body part type to boost */
export type BoostPlan = Partial<Record<BodyPartConstant, { compound: ResourceConstant; parts: number }>>;

/** Ticks a fresh creep waits for its boosts at most */
const BOOST_TIMEOUT = 150;
/**
 * Ticks a working creep (boosted while working) keeps its request: the helper is only spawned once
 * a boost lab is assigned, then brings compound and energy (~100-200 ticks)
 */
const WORKING_BOOST_TIMEOUT = 400;
/** Hivemind: no boost while storage + terminal hold less energy */
const MIN_ENERGY = 2500;

function memory(): NonNullable<Memory["boost"]> {
    if (!Memory.boost) Memory.boost = { creeps: {}, labs: {} };
    return Memory.boost;
}

/** Our active labs (cached for the tick) */
export function operationalLabs(room: Room): StructureLab[] {
    return tickCache(`labs:${room.name}`, () =>
        structuresOfType<StructureLab>(room, STRUCTURE_LAB).filter(l => l.my && l.isActive())
    );
}

export function isLabUsedForBoosting(labId: string): boolean {
    return !!Memory.boost?.labs[labId];
}

export function requiredBoostType(labId: string): ResourceConstant | undefined {
    return Memory.boost?.labs[labId];
}

/** Parts to boost per compound for the creeps in this room (Hivemind getAllRequestedBoosts) */
export function requestedBoosts(room: Room): { [compound: string]: number } {
    return tickCache(`requestedBoosts:${room.name}`, () => {
        const result: { [compound: string]: number } = {};
        const creeps = Memory.boost?.creeps ?? {};
        for (const name in creeps) {
            if (Game.creeps[name]?.room.name !== room.name) continue;
            for (const compound in creeps[name].boosts) result[compound] = (result[compound] ?? 0) + creeps[name].boosts[compound];
        }
        return result;
    });
}

/** Compound and energy a boost lab needs (Hivemind getRequiredBoostAmount / getRequiredEnergyAmount) */
export function labNeeds(lab: StructureLab): { compound: ResourceConstant; amount: number; energy: number } | null {
    const compound = requiredBoostType(lab.id);
    if (!compound) return null;
    const parts = requestedBoosts(lab.room)[compound] ?? 0;
    return { compound, amount: parts * LAB_BOOST_MINERAL, energy: parts * LAB_BOOST_ENERGY };
}

export function boostLabs(room: Room): StructureLab[] {
    return operationalLabs(room).filter(l => isLabUsedForBoosting(l.id));
}

/** Storage + terminal amount of a compound */
function stock(room: Room, resourceType: ResourceConstant): number {
    return (room.storage?.store[resourceType] ?? 0) + (room.terminal?.store[resourceType] ?? 0);
}

/**
 * Best compound for `parts` parts of a type with this effect (Hivemind getAvailableBoosts +
 * getBestBoost, boostChoice.ts): enough in storage + terminal (+ labs) beyond what other creeps asked
 * for every part (for at least `minParts` with partial boosts), tier (name length) at most `maxTier`.
 * `countRequested = false` ignores what other creeps asked (squad sizing: a squad's own pending requests
 * would otherwise make its target look infeasible again while it is being boosted)
 */
export function bestBoost(
    room: Room,
    part: BodyPartConstant,
    effect: BoostEffect,
    parts: number,
    maxTier?: number,
    minParts?: number,
    countRequested = true
): { compound: ResourceConstant; parts: number } | null {
    if (parts === 0 || operationalLabs(room).length === 0) return null;
    if ((room.storage?.store.energy ?? 0) + (room.terminal?.store.energy ?? 0) < MIN_ENERGY) return null;
    const requested = countRequested ? requestedBoosts(room) : {};
    const available = (compound: ResourceConstant) => {
        const inLabs = _.sum(operationalLabs(room), l => (l.mineralType === compound ? l.store[compound] ?? 0 : 0));
        return Math.floor((stock(room, compound) + inLabs) / LAB_BOOST_MINERAL) - (requested[compound] ?? 0);
    };
    return pickBoost(BOOSTS as unknown as BoostTable, part, effect, parts, available, maxTier, minParts);
}

/**
 * Compound and parts per part type for a body (Hivemind generateCreepBoosts), for several part types
 * at once; `minParts`: partial boosts (see bestBoost)
 */
export function boostsFor(
    room: Room,
    body: BodyPartConstant[],
    wanted: [BodyPartConstant, BoostEffect][],
    maxTier?: number,
    minParts?: number
): BoostPlan {
    const result: BoostPlan = {};
    const counts = _.countBy(body);
    for (const [part, effect] of wanted) {
        const pick = bestBoost(room, part, effect, counts[part] ?? 0, maxTier, minParts);
        if (pick) result[part] = pick;
    }
    return result;
}

/** Hivemind markForBoosting: parts per compound, from the boosts per part type */
export function markForBoosting(creepName: string, body: BodyPartConstant[], plan: BoostPlan, working = false): void {
    const parts: { [compound: string]: number } = {};
    for (const part in plan) {
        const pick = plan[part as BodyPartConstant]!;
        parts[pick.compound] = (parts[pick.compound] ?? 0) + pick.parts;
    }
    if (_.size(parts) === 0) return;
    // Out of the spawn after 3 ticks per part, then the timeout to get boosted
    const timeout = working ? WORKING_BOOST_TIMEOUT : BOOST_TIMEOUT;
    memory().creeps[creepName] = { boosts: parts, until: Game.time + body.length * CREEP_SPAWN_TIME + timeout, working: working || undefined };
    countStat("boost:requested");
}

export function needsBoosting(creep: Creep): boolean {
    return !!Memory.boost?.creeps[creep.name];
}

/** Hivemind ensureBoostsHaveLabAssigned: a lab per requested compound, never a source lab */
function assignLabs(room: Room): void {
    const labs = operationalLabs(room);
    const mem = memory();
    const layout = room.memory.labs;
    for (const compound in requestedBoosts(room)) {
        if (labs.some(l => mem.labs[l.id] === compound)) continue;
        let best: StructureLab | null = null;
        let bestScore = 0;
        for (const lab of labs) {
            if (lab.id === layout?.source1 || lab.id === layout?.source2 || mem.labs[lab.id]) continue;
            const other = lab.mineralType && lab.mineralType !== compound ? lab.store[lab.mineralType] ?? 0 : 0;
            const score = 1 - other / LAB_MINERAL_CAPACITY + lab.store.energy / LAB_ENERGY_CAPACITY;
            if (!best || score > bestScore) {
                best = lab;
                bestScore = score;
            }
        }
        if (best) mem.labs[best.id] = compound as ResourceConstant;
    }
}

/** Hivemind ensureLabIsStillNeededForBoosting, for every boost lab of the room */
function releaseLabs(room: Room): void {
    const mem = memory();
    const requested = requestedBoosts(room);
    for (const lab of operationalLabs(room)) {
        const compound = mem.labs[lab.id];
        if (compound && !requested[compound]) delete mem.labs[lab.id];
    }
}

/** Hivemind cleanBoostMemory, every 100 ticks (Hivemind: 758): dead creeps, gone labs */
function cleanMemory(): void {
    const mem = memory();
    for (const name in mem.creeps) if (!Game.creeps[name]) delete mem.creeps[name];
    for (const id in mem.labs) if (!Game.getObjectById(id as Id<StructureLab>)) delete mem.labs[id];
}

/** Every owned room with labs, every tick (Hivemind manageBoostLabs) */
export function manageBoostLabs(room: Room): void {
    if (Game.time % 100 === 0) cleanMemory();
    if (!Memory.boost) return;
    assignLabs(room);
    releaseLabs(room);
}

/** The lab holds the compound and the energy for `parts` parts */
function isLabReady(lab: StructureLab, compound: ResourceConstant, parts: number): boolean {
    if (lab.mineralType !== compound || (lab.store[compound] ?? 0) < parts * LAB_BOOST_MINERAL) return false;
    return lab.store.energy >= parts * LAB_BOOST_ENERGY;
}

const boostedThisTick: Set<string> = new Set();
let boostedTick = -1;

/** Drop a creep's request (timeout, boosted, or nothing left to do) */
function finishBoosting(creep: Creep, reason: string): void {
    const request = Memory.boost?.creeps[creep.name];
    if (!request) return;
    delete Memory.boost!.creeps[creep.name];
    countStat(`boost:${reason}`);
    if (reason === "timeout") log.info("Boosts", `${creep.name}: gave up waiting for ${Object.keys(request.boosts).join(", ")}`);
}

/**
 * Hivemind overrideCreepLogic: while the creep has boosts to get, walk to the best prepared lab and
 * get boosted there once it holds the compound and energy for every part. True while it overrides
 * the creep's own logic.
 */
export function overrideForBoosting(creep: Creep): boolean {
    const request = Memory.boost?.creeps[creep.name];
    if (!request) return false;
    if (creep.spawning) return true;
    if ((request.until !== undefined && Game.time > request.until) || creep.getActiveBodyparts(CLAIM) > 0) {
        finishBoosting(creep, "timeout");
        return false;
    }
    if (boostedTick !== Game.time) {
        boostedThisTick.clear();
        boostedTick = Game.time;
    }
    const mem = memory();
    // Hivemind getMostPreparedLab: energy share + 3 x compound share
    let best: StructureLab | null = null;
    let bestScore = 0;
    for (const lab of boostLabs(creep.room)) {
        const compound = mem.labs[lab.id];
        const parts = request.boosts[compound];
        if (!parts) continue;
        // A working creep only leaves its job for a lab ready to boost it
        if (request.working && !isLabReady(lab, compound, parts)) continue;
        const score =
            Math.min(lab.store.energy / LAB_BOOST_ENERGY / parts, 1) +
            3 * Math.min((lab.mineralType === compound ? lab.store[compound] ?? 0 : 0) / LAB_BOOST_MINERAL / parts, 1);
        if (!best || score > bestScore) {
            best = lab;
            bestScore = score;
        }
    }
    if (!best) {
        if (request.working) return false;
        // Labs not ready yet: wait out of the way (Hivemind: range 5 of the controller)
        if (creep.room.controller) whenInRange(creep, 5, creep.room.controller);
        return true;
    }
    const lab = best;
    const compound = mem.labs[lab.id];
    const parts = request.boosts[compound];
    whenInRange(creep, 1, lab, () => {
        if (!isLabReady(lab, compound, parts) || boostedThisTick.has(lab.id)) return;
        // Exactly the requested parts: partial boosts leave the others to later creeps
        if (lab.boostCreep(creep, parts) !== OK) return;
        boostedThisTick.add(lab.id);
        countStat(`boosted:${compound}`, parts);
        log.info("Boosts", `${creep.name}: ${parts} parts boosted with ${compound}`);
        delete request.boosts[compound];
        if (_.size(request.boosts) === 0) finishBoosting(creep, "done");
    });
    return true;
}
