/**
 * Lab reactions: which labs are the 2 sources and which react (Hivemind labs.position.ts), which
 * compound to make (The International's reverse-chain targeting, labs.ts chainDecompose /
 * chainFindNextReaction, with our military-first target list) and running the reactions (Hivemind
 * labs.ts). Hivemind (MIT) and The International (MIT). Rules: docs/hivemind/hivemind-labs.md.
 */

import { tickCache } from "../core/roomState";
import { log } from "../utils/logger";
import { countStat } from "../utils/stats";
import { isLabUsedForBoosting, operationalLabs } from "./boosts";

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
 * What we want in stock, in priority order (military first: TI sorts its targets by deficit). Without
 * catalyst (X) the chain stops at the tier 2 compounds, which boost too.
 */
export const REACTION_TARGETS: [ResourceConstant, number][] = [
    [RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE, 3000], // XLHO2, HEAL
    [RESOURCE_CATALYZED_GHODIUM_ALKALIDE, 3000], // XGHO2, TOUGH
    [RESOURCE_CATALYZED_UTRIUM_ACID, 3000], // XUH2O, ATTACK
    [RESOURCE_CATALYZED_KEANIUM_ALKALIDE, 3000], // XKHO2, RANGED_ATTACK
    [RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE, 3000], // XZHO2, MOVE
    [RESOURCE_CATALYZED_LEMERGIUM_ACID, 3000] // XLH2O, WORK repair (emergency builders)
];

/** At most this much of a product per reaction cycle (TI reactionCycleAmount: 5000) */
const CYCLE_AMOUNT = 3000;
const MIN_CYCLE_AMOUNT = 1000;
/** Hivemind: layout every 3000 ticks, reaction every 1500 (TI: replan after 3000 at the latest) */
const LAYOUT_EVERY = 3000;
const REPLAN_EVERY = 1500;
/** A finished reaction is replaced at the next check */
const CHECK_EVERY = 50;

/** Compound -> its two reagents */
const REAGENTS: { [compound: string]: [ResourceConstant, ResourceConstant] } = (() => {
    const result: { [compound: string]: [ResourceConstant, ResourceConstant] } = {};
    const reactions = REACTIONS as unknown as Record<string, Record<string, string>>;
    for (const r1 in reactions) {
        for (const r2 in reactions[r1]) result[reactions[r1][r2]] = [r1 as ResourceConstant, r2 as ResourceConstant];
    }
    return result;
})();

export function reagentsOf(compound: ResourceConstant): [ResourceConstant, ResourceConstant] | undefined {
    return REAGENTS[compound];
}

export function productOf(reaction: [ResourceConstant, ResourceConstant]): ResourceConstant {
    return (REACTIONS as unknown as Record<string, Record<string, ResourceConstant>>)[reaction[0]][reaction[1]];
}

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

/** The International chainDecompose: deficits of every compound for the targets, reagents included */
function deficits(room: Room): { [resourceType: string]: number } {
    const have = labResources(room);
    const result: { [resourceType: string]: number } = {};
    const decompose = (compound: ResourceConstant, amount: number) => {
        result[compound] = (result[compound] ?? -(have[compound] ?? 0)) + amount;
        const next = Math.max(0, Math.min(amount, result[compound]));
        const reagents = REAGENTS[compound];
        if (!reagents || next === 0) return;
        for (const reagent of reagents) decompose(reagent, next);
    };
    for (const [compound, amount] of REACTION_TARGETS) decompose(compound, amount);
    return result;
}

/**
 * The International chainFindNextReaction: make the target if both reagents are there (a quarter of
 * the amount, + 5% per reactor), else the first missing reagent that can be made
 */
function findReaction(room: Room, target: ResourceConstant, amount: number, reactors: number, depth = 0): ResourceConstant | null {
    const reagents = REAGENTS[target];
    if (!reagents || depth > 5) return null;
    const have = labResources(room);
    const missing = reagents.filter(r => (have[r] ?? 0) < Math.max(LAB_REACTION_AMOUNT, amount * (0.25 + 0.05 * reactors)));
    if (missing.length === 0) return target;
    for (const reagent of missing) {
        if (!REAGENTS[reagent]) continue; // base minerals: bought, not made
        const found = findReaction(room, reagent, amount, reactors, depth + 1);
        if (found) return found;
    }
    return null;
}

/** Next compound to make: targets in priority order (TI: by deficit) */
export function chooseReaction(room: Room, reactors: number): { product: ResourceConstant; amount: number } | null {
    const deficit = deficits(room);
    for (const [compound] of REACTION_TARGETS) {
        const missing = deficit[compound] ?? 0;
        if (missing <= 0) continue;
        const product = findReaction(room, compound, missing, reactors);
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

function updateReaction(room: Room): void {
    const memory = room.memory;
    const due = memory.reactionAt === undefined || Game.time - memory.reactionAt >= REPLAN_EVERY;
    if (!due && (Game.time % CHECK_EVERY !== 0 || !isFinished(room))) return;
    memory.reactionAt = Game.time;
    const next = chooseReaction(room, memory.labs?.reactor.length ?? 1);
    const previous = memory.currentReaction ? productOf(memory.currentReaction) : null;
    if (!next) {
        if (memory.currentReaction) log.info("Labs", `${room.name}: no reaction (was ${previous})`);
        delete memory.currentReaction;
        delete memory.reactionTarget;
        return;
    }
    memory.currentReaction = REAGENTS[next.product];
    memory.reactionTarget = (labResources(room)[next.product] ?? 0) + next.amount;
    if (next.product !== previous) log.info("Labs", `${room.name}: now producing ${next.amount} ${next.product}`);
}

/** Hivemind runReactions: every free reactor reacts once the source labs hold the reagents */
function runReactions(room: Room): void {
    const memory = room.memory;
    const layout = memory.labs;
    const reaction = memory.currentReaction;
    if (!layout || !reaction) return;
    const source1 = Game.getObjectById(layout.source1);
    const source2 = Game.getObjectById(layout.source2);
    if (!source1 || !source2) return;
    if (source1.mineralType !== reaction[0] || source2.mineralType !== reaction[1]) {
        countStat("lab:waiting");
        return;
    }
    for (const id of layout.reactor) {
        if (isLabUsedForBoosting(id)) continue;
        const reactor = Game.getObjectById(id);
        if (!reactor || reactor.cooldown) continue;
        const result = reactor.runReaction(source1, source2);
        if (result === OK) countStat(`reaction:${productOf(reaction)}`, LAB_REACTION_AMOUNT);
    }
}

export function manageReactions(room: Room): void {
    const labs = operationalLabs(room);
    if (labs.length < 3) {
        delete room.memory.labs;
        delete room.memory.currentReaction;
        return;
    }
    const layout = room.memory.labs;
    if (!layout || layout.n !== labs.length || Game.time - layout.at >= LAYOUT_EVERY) updateLayout(room, labs);
    if (!room.memory.labs) return;
    if (!room.storage && !room.terminal) return;
    updateReaction(room);
    runReactions(room);
}
