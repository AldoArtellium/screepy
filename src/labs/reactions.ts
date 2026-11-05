/**
 * Lab reactions: which labs are the 2 sources and which react (Hivemind labs.position.ts), which
 * compound to make (The International's reverse-chain targeting, chain.ts, with our targets: upgrade
 * compounds, military ones under threat) and running the reactions (Hivemind labs.ts). Hivemind (MIT)
 * and The International (MIT). Rules: docs/hivemind/hivemind-labs.md.
 */

import { tickCache } from "../core/roomState";
import { ENEMY_STRENGTH_NORMAL, enemyStrength, roomThreat } from "../defense/RoomDefense";
import { currentTarget } from "../military/military";
import { log } from "../utils/logger";
import { countStat } from "../utils/stats";
import { isLabUsedForBoosting, operationalLabs } from "./boosts";
import { chainDeficits, DemandTarget, demandTargets, findChainReaction, importableFrom, productOf, reagentsOf } from "./chain";

export { productOf, reagentsOf };

declare global {
    interface RoomMemory {
        /** Source labs and reactors (Hivemind memory.labs); `n`: number of labs it was computed for */
        labs?: { source1: Id<StructureLab>; source2: Id<StructureLab>; reactor: Id<StructureLab>[]; n: number; at: number };
        /** Reagents of the reaction under way (Hivemind currentReaction) */
        currentReaction?: [ResourceConstant, ResourceConstant];
        /** Stop the reaction once the product reaches this amount (TI targetAmount); chosen at `reactionAt` */
        reactionTarget?: number;
        reactionAt?: number;
    }
}

/**
 * Targets of a room: upgrade compounds first; military ones after them while a player threatened us
 * (room threat, infamy) and automatic attacks are on, before them during an attack mission or with
 * NORMAL+ enemies at home. Before (2026-10-25) the military list always came first: shard0 made UH2O,
 * LHO2, GHO2... that nothing used, 20000 ticks without a single boost. Before 2026-11-04 the threat
 * stock was made with `Memory.military.auto = false` too (no squad to use it); without it, the smaller
 * defense stock (chain.ts DEFENSE_TARGETS: guardians, emergency builders, boosted remote defenders).
 * An attack mission's compounds are `offense` (bought above the offensive credit floor only, boostDemand.ts),
 * enemies at home keep `military` (bought whatever the credits): shard0 2026-11-05, the quads on W26N3 and
 * W28N3 took the credits from 271k to 174k in 1300 ticks with forced buys in every lab room.
 */
export function demandTargetsOf(room: Room): DemandTarget[] {
    const homeThreat = enemyStrength(room) >= ENEMY_STRENGTH_NORMAL;
    const mission = currentTarget() !== undefined;
    const militaryWanted = Memory.military?.auto !== false && roomThreat(room) > 0;
    const targets = demandTargets(room.controller?.level ?? 0, homeThreat || mission, militaryWanted).map(t =>
        t.kind === "military" && !homeThreat ? { ...t, kind: "offense" as const } : t
    );
    // The compounds a target blocked only by the stock needs (military/boostDemand.ts), in its origin first
    const demand = Memory.military?.boostDemand;
    if (demand?.home !== room.name) return targets;
    const offense = Object.entries(demand.compounds).map(([compound, amount]) => ({
        compound: compound as ResourceConstant,
        amount,
        kind: "offense" as const
    }));
    return [...offense, ...targets.filter(t => !(t.compound in demand.compounds))];
}

function targetsOf(room: Room): [ResourceConstant, number][] {
    return demandTargetsOf(room).map(t => [t.compound, t.amount]);
}

/** At most this much of a product per reaction cycle (TI reactionCycleAmount: 5000) */
const CYCLE_AMOUNT = 3000;
const MIN_CYCLE_AMOUNT = 1000;
/** Hivemind: layout every 3000 ticks, reaction every 1500 (TI: replan after 3000 at the latest) */
const LAYOUT_EVERY = 3000;
const REPLAN_EVERY = 1500;
/** A finished reaction is replaced at the next check */
const CHECK_EVERY = 50;

/**
 * Resources of the room for reactions: storage, terminal, labs and transporters' cargo (Hivemind
 * getResourceState + labs; TI resourceAmount)
 */
export function labResources(room: Room): { [resourceType: string]: number } {
    return tickCache(`labResources:${room.name}`, () => {
        const result: { [resourceType: string]: number } = {};
        const add = (store: StoreDefinition | Store<ResourceConstant, false> | undefined) => {
            if (!store) return;
            for (const key in store) {
                if (key === RESOURCE_ENERGY) continue;
                result[key] = (result[key] ?? 0) + (store[key as ResourceConstant] ?? 0);
            }
        };
        add(room.storage?.store);
        add(room.terminal?.store);
        for (const lab of operationalLabs(room)) add(lab.store);
        for (const creep of room.find(FIND_MY_CREEPS)) if (creep.memory.role === "transporter" || creep.memory.role === "helper") add(creep.store);
        return result;
    });
}

/** Two source labs within range 2 of the most other labs (Hivemind labs.position.ts) */
function updateLayout(room: Room, labs: StructureLab[]): void {
    let best: { source1: Id<StructureLab>; source2: Id<StructureLab>; reactor: Id<StructureLab>[] } | null = null;
    for (const lab of labs) {
        const close = labs.filter(other => other.id !== lab.id && lab.pos.getRangeTo(other) <= 2);
        if (close.length < 2) continue;
        for (const lab2 of close) {
            const reactor = close.filter(r => r.id !== lab2.id && r.pos.getRangeTo(lab2) <= 2).map(r => r.id);
            if (reactor.length === 0) continue;
            if (!best || best.reactor.length < reactor.length) best = { source1: lab.id, source2: lab2.id, reactor };
        }
    }
    if (best) room.memory.labs = { ...best, n: labs.length, at: Game.time };
    else delete room.memory.labs;
}

/** Storage + terminal amounts of the other owned rooms with a terminal: what the terminal transfers can bring */
function importable(room: Room): (resourceType: ResourceConstant) => number {
    if (!room.terminal?.my) return () => 0;
    const others = _.filter(Game.rooms, r => r.name !== room.name && !!r.controller?.my && !!r.terminal?.my);
    return importableFrom(
        others.map(r => ({
            amount: (resourceType: ResourceConstant) => (r.storage?.store[resourceType] ?? 0) + (r.terminal?.store[resourceType] ?? 0),
            reaction: r.memory.currentReaction
        }))
    );
}

/** Next compound to make: targets in priority order (TI: by deficit) */
export function chooseReaction(room: Room, reactors: number): { product: ResourceConstant; amount: number } | null {
    const resources = labResources(room);
    const have = (resourceType: ResourceConstant) => resources[resourceType] ?? 0;
    const imported = importable(room);
    const targets = targetsOf(room);
    const deficit = chainDeficits(targets, have);
    for (const [compound] of targets) {
        const missing = deficit[compound] ?? 0;
        if (missing <= 0) continue;
        const product = findChainReaction(compound, missing, reactors, have, imported);
        // Not in TI: at least MIN_CYCLE_AMOUNT (a few boosted parts left tiny batches, mostly hauling)
        if (product) return { product, amount: Math.min(CYCLE_AMOUNT, Math.max(MIN_CYCLE_AMOUNT, deficit[product] ?? 0, missing)) };
    }
    return null;
}

/** TI isCurrentReactionFinished: a reagent ran out or the product reached its target */
function isFinished(room: Room): boolean {
    const reaction = room.memory.currentReaction;
    if (!reaction) return true;
    const have = labResources(room);
    if (reaction.some(r => (have[r] ?? 0) < LAB_REACTION_AMOUNT)) return true;
    return (have[productOf(reaction)] ?? 0) >= (room.memory.reactionTarget ?? 0);
}

/**
 * Heap: last tick each room checked whether its reaction is finished. Elapsed ticks, not
 * Game.time % CHECK_EVERY: the Labs module is throttled (shard0 at 16-19 of 20 CPU ran it about every
 * other tick), so the modulo could miss every multiple and a finished reaction waited REPLAN_EVERY.
 */
const checkedAt: Map<string, number> = new Map();

function updateReaction(room: Room): void {
    const memory = room.memory;
    const due = memory.reactionAt === undefined || Game.time - memory.reactionAt >= REPLAN_EVERY;
    if (!due) {
        if (Game.time - (checkedAt.get(room.name) ?? -Infinity) < CHECK_EVERY) return;
        checkedAt.set(room.name, Game.time);
        if (!isFinished(room)) return;
    }
    memory.reactionAt = Game.time;
    const next = chooseReaction(room, memory.labs?.reactor.length ?? 1);
    const previous = memory.currentReaction ? productOf(memory.currentReaction) : null;
    if (!next) {
        if (memory.currentReaction) log.info("Labs", `${room.name}: no reaction (was ${previous})`);
        delete memory.currentReaction;
        delete memory.reactionTarget;
        return;
    }
    memory.currentReaction = reagentsOf(next.product);
    memory.reactionTarget = (labResources(room)[next.product] ?? 0) + next.amount;
    if (next.product !== previous) log.info("Labs", `${room.name}: now producing ${next.amount} ${next.product}`);
}

/** Ticks before looking again at labs with nothing to do, or source labs still waiting for their reagents */
export const IDLE_WAIT = CHECK_EVERY;
const REAGENT_WAIT = 5;

/**
 * Hivemind runReactions: every free reactor reacts once the source labs hold the reagents. Returns the
 * ticks until a reactor can act again: the shortest cooldown, REAGENT_WAIT while reagents are missing,
 * at most the next finished-reaction check.
 */
function runReactions(room: Room): number {
    const memory = room.memory;
    const layout = memory.labs;
    const reaction = memory.currentReaction;
    const nextCheck = Math.max(1, CHECK_EVERY - (Game.time - (checkedAt.get(room.name) ?? Game.time)));
    if (!layout || !reaction) return nextCheck;
    const source1 = Game.getObjectById(layout.source1);
    const source2 = Game.getObjectById(layout.source2);
    if (!source1 || !source2) return nextCheck;
    if (source1.mineralType !== reaction[0] || source2.mineralType !== reaction[1]) {
        const wait = Math.min(REAGENT_WAIT, nextCheck);
        countStat("lab:waiting", wait);
        return wait;
    }
    const product = productOf(reaction);
    let wait = nextCheck;
    for (const id of layout.reactor) {
        if (isLabUsedForBoosting(id)) continue;
        const reactor = Game.getObjectById(id);
        if (!reactor) continue;
        if (reactor.cooldown) {
            wait = Math.min(wait, reactor.cooldown);
            continue;
        }
        const result = reactor.runReaction(source1, source2);
        if (result === OK) {
            countStat(`reaction:${product}`, LAB_REACTION_AMOUNT);
            wait = Math.min(wait, (REACTION_TIME as Record<string, number>)[product] ?? 1);
        } else wait = Math.min(wait, REAGENT_WAIT);
    }
    return Math.max(1, wait);
}

/** Reactions of a room; returns the ticks until there is something to do again (labsModule skips the room meanwhile) */
export function manageReactions(room: Room): number {
    const labs = operationalLabs(room);
    if (labs.length < 3) {
        delete room.memory.labs;
        delete room.memory.currentReaction;
        return IDLE_WAIT;
    }
    const layout = room.memory.labs;
    if (!layout || layout.n !== labs.length || Game.time - layout.at >= LAYOUT_EVERY) updateLayout(room, labs);
    if (!room.memory.labs) return IDLE_WAIT;
    if (!room.storage && !room.terminal) return IDLE_WAIT;
    updateReaction(room);
    return runReactions(room);
}
