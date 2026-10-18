/**
 * Room resources: amounts in storage + terminal, "full" tests, storage vs terminal choice, terminal
 * preparation for sends and deals, resource levels and funnel targets.
 * Ported from Hivemind (MIT), src/prototype/room.resources.ts, src/room/resource-level-manager.ts and
 * src/empire/funnel-manager.ts. See docs/hivemind/hivemind-endgame.md.
 *
 * Not ported: evacuation and storage/terminal clearing modes, factory bars and batteries, power, ops
 * and commodities levels.
 */

import { ENEMY_STRENGTH_NORMAL, enemyStrength } from "../defense/RoomDefense";
import { expansionScore } from "../expansion/expansionScore";
import { creepsByRole, effectiveEnergy, tickCache } from "./roomState";

declare global {
    interface RoomMemory {
        /** Resource transporters bring to the terminal for a send or a deal (Hivemind prepareForTrading) */
        fillTerminal?: ResourceConstant;
        fillTerminalAmount?: number;
    }
}

export type ResourceLevel = "low" | "medium" | "high" | "excessive";

/** Terminal energy transporters keep at least (Hivemind terminal destination) */
export const TERMINAL_MIN_ENERGY = 5000;
/** Energy goes to the terminal first below this (Hivemind getBestStorageTarget) */
const TERMINAL_PREFERRED_ENERGY = 7000;

export function myRoomsWithTerminal(): Room[] {
    return tickCache("roomsWithTerminal", () => _.filter(Game.rooms, r => !!r.controller?.my && !!r.terminal?.my));
}

/** Storage + terminal capacity; 10 000 without either (Hivemind getStorageLimit) */
export function storageLimit(room: Room): number {
    const total = (room.storage?.store.getCapacity() ?? 0) + (room.terminal?.store.getCapacity() ?? 0);
    return total || 10000;
}

/** Storage + terminal + transporters' cargo, by resource type (Hivemind getCurrentResourceAmount) */
function allResources(room: Room): { [resourceType: string]: number } {
    return tickCache(`allResources:${room.name}`, () => {
        const resources: { [resourceType: string]: number } = {};
        const add = (store: StoreDefinition | undefined) => {
            if (!store) return;
            for (const resourceType in store) resources[resourceType] = (resources[resourceType] ?? 0) + (store[resourceType as ResourceConstant] ?? 0);
        };
        add(room.storage?.store);
        add(room.terminal?.store);
        for (const creep of creepsByRole(room.name, "transporter")) add(creep.store);
        return resources;
    });
}

export function resourceAmount(room: Room, resourceType: ResourceConstant): number {
    return allResources(room)[resourceType] ?? 0;
}

/** Every resource but energy and power (Hivemind getCurrentMineralAmount) */
export function mineralAmount(room: Room): number {
    const resources = allResources(room);
    let total = 0;
    for (const resourceType in resources) {
        if (resourceType !== RESOURCE_ENERGY && resourceType !== RESOURCE_POWER) total += resources[resourceType];
    }
    return total;
}

/** Energy above half the storage limit, power above a sixth, minerals above a third (Hivemind isFullOn) */
export function isFullOn(room: Room, resourceType: ResourceConstant): boolean {
    if (resourceType === RESOURCE_ENERGY) return resourceAmount(room, RESOURCE_ENERGY) > storageLimit(room) / 2;
    if (resourceType === RESOURCE_POWER) return resourceAmount(room, RESOURCE_POWER) > storageLimit(room) / 6;
    return mineralAmount(room) > storageLimit(room) / 3;
}

/**
 * Where to store resources (Hivemind getBestStorageTarget): energy in the terminal below 7000, else
 * each resource where it fills the smaller share of the free space; null when neither has room.
 */
export function bestStorageTarget(room: Room, amount: number, resourceType: ResourceConstant): StructureStorage | StructureTerminal | null {
    const storage = room.storage?.my ? room.storage : undefined;
    const terminal = room.terminal?.my ? room.terminal : undefined;
    if (!storage || !terminal) return storage ?? terminal ?? null;
    const storageFree = storage.store.getFreeCapacity();
    const terminalFree = terminal.store.getFreeCapacity();
    if (resourceType === RESOURCE_ENERGY && terminal.store.energy < TERMINAL_PREFERRED_ENERGY && terminalFree > 0) return terminal;
    if (
        storageFree >= amount &&
        terminalFree >= amount &&
        (storage.store[resourceType] ?? 0) / storageFree < (terminal.store[resourceType] ?? 0) / terminalFree
    ) {
        return storage;
    }
    if (terminalFree >= amount) return terminal;
    if (storageFree >= amount) return storage;
    return null;
}

/**
 * Where to take resources from (Hivemind getBestStorageSource): the terminal when it holds a larger share
 * of its capacity (unless the resource is being prepared there), else the storage.
 */
export function bestStorageSource(room: Room, resourceType: ResourceConstant): StructureStorage | StructureTerminal | null {
    const storage = room.storage?.my ? room.storage : undefined;
    const terminal = room.terminal?.my ? room.terminal : undefined;
    if (storage && terminal) {
        if (
            (storage.store[resourceType] ?? 0) / storage.store.getCapacity() < (terminal.store[resourceType] ?? 0) / terminal.store.getCapacity() &&
            room.memory.fillTerminal !== resourceType
        ) {
            return terminal;
        }
        return (storage.store[resourceType] ?? 0) > 0 ? storage : null;
    }
    if (storage?.store[resourceType]) return storage;
    if (terminal?.store[resourceType] && room.memory.fillTerminal !== resourceType) return terminal;
    return null;
}

/** Transporters bring `amount` (default min(10 000, stock), at most 50 000) of a resource to the terminal */
export function prepareForTrading(room: Room, resourceType: ResourceConstant, amount?: number): void {
    room.memory.fillTerminal = resourceType;
    room.memory.fillTerminalAmount = Math.min(amount ?? Math.min(10000, resourceAmount(room, resourceType)), 50000);
}

export function stopTradePreparation(room: Room): void {
    delete room.memory.fillTerminal;
    delete room.memory.fillTerminalAmount;
}

/** Storage + terminal + factory, the amounts rooms compare to trade (Hivemind getResourceState) */
export function totalResources(room: Room): { [resourceType: string]: number } {
    return tickCache(`totalResources:${room.name}`, () => {
        const resources: { [resourceType: string]: number } = {};
        for (const structure of [room.storage, room.terminal, room.find(FIND_MY_STRUCTURES, { filter: { structureType: STRUCTURE_FACTORY } })[0] as StructureFactory | undefined]) {
            if (!structure) continue;
            for (const resourceType in structure.store) {
                resources[resourceType] = (resources[resourceType] ?? 0) + (structure.store[resourceType as ResourceConstant] ?? 0);
            }
        }
        return resources;
    });
}

/** Some owned room fights stronger than NORMAL enemies (Hivemind isAnyRoomUnderAttack) */
function isAnyRoomUnderAttack(): boolean {
    return tickCache("anyRoomUnderAttack", () => _.some(Game.rooms, r => !!r.controller?.my && enemyStrength(r) > ENEMY_STRENGTH_NORMAL));
}

type Cutoffs = [number, number, number];

/** Hivemind getBoostCutoffs: wanted while fighting (attack, ranged, repair), else kept up to 15k */
function boostCutoffs(room: Room, resourceType: ResourceConstant): Cutoffs | null {
    const boosts = BOOSTS as unknown as Record<string, Record<string, Record<string, number>>>;
    let isBoost = false;
    for (const part in boosts) {
        const effect = boosts[part][resourceType];
        if (!effect) continue;
        isBoost = true;
        if (part === WORK && effect.upgradeController && room.controller!.level >= 8) return [15000, 7500, 2500];
        if (enemyStrength(room) <= ENEMY_STRENGTH_NORMAL) continue;
        if (part === ATTACK || part === RANGED_ATTACK || (part === WORK && effect.repair)) return [15000, 7500, 2500];
    }
    if (!isBoost) return null;
    return enemyStrength(room) > ENEMY_STRENGTH_NORMAL ? [1, 0, 0] : [15000, 0, 0];
}

/** Hivemind getReactionCutoffs: reagents of the reaction under way */
function reactionCutoffs(room: Room, resourceType: ResourceConstant): Cutoffs | null {
    const reaction = room.memory.currentReaction;
    if (!reaction || !reaction.includes(resourceType)) return null;
    return enemyStrength(room) > ENEMY_STRENGTH_NORMAL ? [1, 0, 0] : [30000, 20000, 10000];
}

/**
 * [excessive, high, medium] thresholds (Hivemind getResourceLevelCutoffs: energy; boosts and reaction
 * reagents, the highest of both; everything else 50k/0/0)
 */
function levelCutoffs(room: Room, resourceType: ResourceConstant): Cutoffs {
    if (resourceType !== RESOURCE_ENERGY) {
        const applicable = [boostCutoffs(room, resourceType), reactionCutoffs(room, resourceType)].filter((c): c is Cutoffs => !!c);
        if (applicable.length === 0) return [50000, 0, 0];
        return applicable.reduce((a, c) => [Math.max(a[0], c[0]), Math.max(a[1], c[1]), Math.max(a[2], c[2])]);
    }
    if (enemyStrength(room) >= ENEMY_STRENGTH_NORMAL) return [200000, 100000, 50000];
    if (isAnyRoomUnderAttack()) return [50000, 20000, 15000];
    if (roomsToFunnel().includes(room.name)) return [500000, 300000, 150000];
    if (room.find(FIND_MY_STRUCTURES, { filter: { structureType: STRUCTURE_POWER_SPAWN } }).length > 0) return [200000, 100000, 50000];
    return [200000, 50000, 20000];
}

export function resourceLevel(room: Room, resourceType: ResourceConstant, amount = totalResources(room)[resourceType] ?? 0): ResourceLevel {
    const cutoffs = levelCutoffs(room, resourceType);
    if (amount >= cutoffs[0]) return "excessive";
    if (amount >= cutoffs[1]) return "high";
    if (amount >= cutoffs[2]) return "medium";
    return "low";
}

/** Heap cache of the funnel targets (Hivemind: 500 ticks) */
let funnelCache: { until: number; rooms: string[] } | null = null;

function funnelScore(room: Room): number {
    const needed = Math.max(0, (room.controller?.progressTotal ?? 0) - (room.controller?.progress ?? 0));
    return expansionScore(room.name) / (needed + 1);
}

/**
 * Rooms other rooms send energy to (Hivemind FunnelManager, without the RCL 8 priority setting):
 * every RCL 6-7 room once an RCL 8 room has 300k energy; else the best RCL 7 room when there are 3+
 * of them and at most one RCL 8; else the best RCL 6-7 room. None when the GCL is closer to its next level.
 */
export function roomsToFunnel(): string[] {
    if (funnelCache && funnelCache.until > Game.time) return funnelCache.rooms;
    const rooms = myRoomsWithTerminal();
    const atLevel = (level: number) => rooms.filter(r => r.controller!.level === level);
    let funnel: Room[] = [];
    if (_.some(Game.rooms, r => r.controller?.my && r.controller.level === 8 && effectiveEnergy(r) > 300000)) {
        funnel = [...atLevel(6), ...atLevel(7)];
    } else {
        if (atLevel(7).length > 2 && atLevel(8).length <= 1) funnel = [_.max(atLevel(7), funnelScore)];
        else if (atLevel(6).length + atLevel(7).length > 0) funnel = [_.max([...atLevel(6), ...atLevel(7)], funnelScore)];
        const gclScore = 10 / (Math.max(0, Game.gcl.progressTotal - Game.gcl.progress) + 1);
        if (funnel.length > 0 && gclScore > funnelScore(funnel[0])) funnel = [];
    }
    funnelCache = { until: Game.time + 500, rooms: funnel.map(r => r.name) };
    return funnelCache.rooms;
}
