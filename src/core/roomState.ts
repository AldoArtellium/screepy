/**
 * Per-tick room state shared by roles, dispatcher and spawning: creeps by role, creeps by order
 * target (Hivemind's getCreepsWithOrder, indexed instead of filtered), containers, stored energy, bays.
 * Rules ported from Hivemind (MIT): src/prototype/room.resources.ts, room.intel.ts, room.creeps.ts,
 * src/manager.source.ts, src/manager.bay.ts.
 */

import { roomPlanner } from "../planner/RoomPlanner";
import { jitter } from "../utils/jitter";

/** A creep's current resource / work order, kept in memory */
export interface Order {
    type: string;
    priority: number;
    weight: number;
    target?: string;
    /** Bay orders target the bay by name (center position) */
    name?: string;
    resourceType?: ResourceConstant;
    amount?: number;
    /** Repair orders: hits to reach */
    maxHealth?: number;
}

declare global {
    interface CreepMemory {
        order?: Order;
    }
    interface RoomMemory {
        /** Hostile intel, refreshed by RoomIntel */
        enemies?: {
            safe: boolean;
            lastSeen?: number;
            expires?: number;
            hasInvaderCore?: boolean;
            /** Damage and heal per tick of the dangerous hostiles at range 1 (Hivemind getTotalEnemyData) */
            damage?: number;
            heal?: number;
            /** The dangerous hostiles have RANGED_ATTACK */
            ranged?: boolean;
        };
    }
}

interface TickCache {
    tick: number;
    byRole: Map<string, Creep[]>;
    byOrder: Map<string, Creep[]>;
    /** Creeps by `duo:<name>` / `quad:<name>` / `squad:<name>` */
    byGroup: Map<string, Creep[]>;
    values: Map<string, unknown>;
}

let cache: TickCache = { tick: -1, byRole: new Map(), byOrder: new Map(), byGroup: new Map(), values: new Map() };

function orderKey(roomName: string, type: string, target: string | undefined): string {
    return `${roomName}|${type}|${target ?? ""}`;
}

function refresh(): TickCache {
    if (cache.tick === Game.time) return cache;
    cache = { tick: Game.time, byRole: new Map(), byOrder: new Map(), byGroup: new Map(), values: new Map() };
    for (const name in Game.creeps) {
        const creep = Game.creeps[name];
        const home = creep.memory.room ?? creep.room.name;
        const role = creep.memory.role ?? "unassigned";
        const key = `${home}|${role}`;
        const list = cache.byRole.get(key);
        if (list) list.push(creep);
        else cache.byRole.set(key, [creep]);
        indexOrder(creep, creep.memory.order);
        if (creep.memory.duo) indexGroup(`duo:${creep.memory.duo}`, creep);
        if (creep.memory.squad) indexGroup(`squad:${creep.memory.squad}`, creep);
        if (creep.memory.quad) indexGroup(`quad:${creep.memory.quad}`, creep);
    }
    return cache;
}

function indexGroup(key: string, creep: Creep): void {
    const list = cache.byGroup.get(key);
    if (list) list.push(creep);
    else cache.byGroup.set(key, [creep]);
}

function indexOrder(creep: Creep, order: Order | undefined): void {
    if (!order) return;
    const key = orderKey(creep.room.name, order.type, order.target ?? order.name);
    const list = cache.byOrder.get(key);
    if (list) list.push(creep);
    else cache.byOrder.set(key, [creep]);
}

function unindexOrder(creep: Creep, order: Order | undefined): void {
    if (!order) return;
    const list = cache.byOrder.get(orderKey(creep.room.name, order.type, order.target ?? order.name));
    if (!list) return;
    const index = list.indexOf(creep);
    if (index >= 0) list.splice(index, 1);
}

/** Cache a value for the rest of the tick */
export function tickCache<T>(key: string, compute: () => T): T {
    const values = refresh().values;
    if (values.has(key)) return values.get(key) as T;
    const value = compute();
    values.set(key, value);
    return value;
}

/** Creeps of a home room with a role, spawning ones included */
export function creepsByRole(roomName: string, role: string): Creep[] {
    return refresh().byRole.get(`${roomName}|${role}`) ?? [];
}

/** Creeps of a military duo (memory.duo), spawning ones included */
export function duoCreeps(duo: string): Creep[] {
    return refresh().byGroup.get(`duo:${duo}`) ?? [];
}

/** Creeps of a military quad (memory.quad), spawning ones included */
export function quadCreeps(quad: string): Creep[] {
    return refresh().byGroup.get(`quad:${quad}`) ?? [];
}

/** Creeps of an expansion squad (memory.squad), spawning ones included */
export function squadCreeps(squad: string): Creep[] {
    return refresh().byGroup.get(`squad:${squad}`) ?? [];
}

/** Creeps in the room holding an order of this type on this target */
export function creepsWithOrder(room: Room, type: string, target: string): Creep[] {
    return refresh().byOrder.get(orderKey(room.name, type, target)) ?? [];
}

export function setOrder(creep: Creep, order: Order | null | undefined): void {
    refresh();
    unindexOrder(creep, creep.memory.order);
    if (order) {
        // Weights like 1.0233333333333334 cost ~15 chars of Memory per creep: 3 decimals are plenty
        if (order.weight % 1) order.weight = Math.round(order.weight * 1000) / 1000;
        creep.memory.order = order;
        indexOrder(creep, order);
    } else {
        delete creep.memory.order;
    }
}

export function clearOrder(creep: Creep): void {
    setOrder(creep, null);
}

export function activeParts(creeps: Creep[], part: BodyPartConstant): number {
    return _.sum(creeps, c => c.getActiveBodyparts(part));
}

// ------------------------------------------------------------------ structures

export function structuresOfType<T extends Structure>(room: Room, type: StructureConstant): T[] {
    return tickCache(`structures:${room.name}:${type}`, () =>
        room.find(FIND_STRUCTURES, { filter: s => s.structureType === type }) as unknown as T[]
    );
}

export function mySpawns(room: Room): StructureSpawn[] {
    return structuresOfType<StructureSpawn>(room, STRUCTURE_SPAWN).filter(s => s.my);
}

/** Container next to a source (planned 'container.source' when the room has a plan), range <= 5 */
export function sourceContainer(source: Source): StructureContainer | null {
    return tickCache(`sourceContainer:${source.id}`, () => {
        const plan = roomPlanner.getPlan(source.room.name);
        const containers = structuresOfType<StructureContainer>(source.room, STRUCTURE_CONTAINER).filter(
            c => c.pos.inRangeTo(source, 5) && (!plan || plan.has(c.pos, "container.source"))
        );
        return source.pos.findClosestByRange(containers);
    });
}

/** Container next to a mineral (planned 'container.mineral' when the room has a plan), range 1 */
export function mineralContainer(mineral: Mineral): StructureContainer | null {
    return tickCache(`mineralContainer:${mineral.id}`, () => {
        const room = Game.rooms[mineral.pos.roomName];
        if (!room) return null;
        const plan = roomPlanner.getPlan(room.name);
        return (
            structuresOfType<StructureContainer>(room, STRUCTURE_CONTAINER).find(
                c => c.pos.isNearTo(mineral) && (!plan || plan.has(c.pos, "container.mineral"))
            ) ?? null
        );
    });
}

/** Container of the controller (planned 'container.controller', else any container within 3) */
export function controllerContainer(room: Room): StructureContainer | null {
    return tickCache(`controllerContainer:${room.name}`, () => {
        const controller = room.controller;
        if (!controller) return null;
        const plan = roomPlanner.getPlan(room.name);
        const containers = structuresOfType<StructureContainer>(room, STRUCTURE_CONTAINER);
        if (plan) {
            const planned = containers.find(c => plan.has(c.pos, "container.controller"));
            if (planned) return planned;
        }
        return containers.find(c => c.pos.inRangeTo(controller, 3)) ?? null;
    });
}

// ------------------------------------------------------------------ links

/** Controller link (planned 'link.controller', else any link within 3), Hivemind updateControllerLink */
export function controllerLink(room: Room): StructureLink | null {
    return tickCache(`controllerLink:${room.name}`, () => {
        const controller = room.controller;
        if (!controller) return null;
        const links = structuresOfType<StructureLink>(room, STRUCTURE_LINK).filter(l => l.my);
        const plan = roomPlanner.getPlan(room.name);
        if (plan && plan.count("link.controller") > 0) return links.find(l => plan.has(l.pos, "link.controller")) ?? null;
        return links.find(l => l.pos.inRangeTo(controller, 3)) ?? null;
    });
}

/** Closest link within 3 of a source (Hivemind getNearbyLink) */
export function sourceLink(source: Source): StructureLink | null {
    return tickCache(`sourceLink:${source.id}`, () => {
        const links = structuresOfType<StructureLink>(source.room, STRUCTURE_LINK).filter(l => l.my && l.pos.inRangeTo(source, 3));
        return source.pos.findClosestByRange(links);
    });
}

export interface LinkAndDelta {
    link: StructureLink;
    delta: number;
}

/**
 * Links of a room by role (Hivemind LinkNetwork, generateLinkNetwork): source links are "in" (want 0),
 * the controller link "out" (wants full), both at once "in-out" (half), the others neutral (storage)
 */
export interface LinkNetwork {
    neutral: StructureLink[];
    underfull: LinkAndDelta[];
    overfull: LinkAndDelta[];
    energy: number;
    /** Sum of the wanted levels */
    minEnergy: number;
    /** Sum of the wanted levels, neutral links counted full */
    maxEnergy: number;
}

export function linkNetwork(room: Room): LinkNetwork | null {
    return tickCache(`linkNetwork:${room.name}`, () => {
        const links = structuresOfType<StructureLink>(room, STRUCTURE_LINK).filter(l => l.my);
        if (links.length === 0) return null;
        const network: LinkNetwork = { neutral: [], underfull: [], overfull: [], energy: 0, minEnergy: 0, maxEnergy: 0 };
        const controller = controllerLink(room);
        const sourceLinks = new Set(room.find(FIND_SOURCES).map(s => sourceLink(s)?.id));
        for (const link of links) {
            const capacity = link.store.getCapacity(RESOURCE_ENERGY);
            const energy = link.store.energy;
            network.energy += energy;
            let wanted: number | null = null;
            if (link.id === controller?.id) wanted = sourceLinks.has(link.id) ? capacity / 2 : capacity;
            else if (sourceLinks.has(link.id)) wanted = 0;
            if (wanted === null) {
                network.neutral.push(link);
                network.maxEnergy += capacity;
                continue;
            }
            network.minEnergy += wanted;
            network.maxEnergy += wanted;
            if (energy < wanted) network.underfull.push({ link, delta: wanted - energy });
            else if (energy > wanted) network.overfull.push({ link, delta: energy - wanted });
        }
        return network;
    });
}

/** Where energy is dropped before the storage exists: plan center, else storage, else first spawn */
export function storageLocation(room: Room): RoomPosition | null {
    return tickCache(`storageLocation:${room.name}`, () => {
        if (!room.controller) return null;
        const center = roomPlanner.getPlan(room.name)?.getCenter();
        if (center) return center;
        return room.storage?.pos ?? mySpawns(room)[0]?.pos ?? null;
    });
}

/**
 * Path length from the storage location to the controller container, cached 5000 ticks (like
 * Hivemind) per pair of positions. 1 without container: nothing cached, so the real length counts
 * as soon as the container is built.
 */
const refillPaths: Map<string, { until: number; key: string; length: number }> = new Map();
export function controllerRefillPathLength(room: Room): number {
    const container = controllerContainer(room);
    const from = storageLocation(room);
    if (!container || !from) return 1;
    const key = `${from.x},${from.y}:${container.pos.x},${container.pos.y}`;
    const cached = refillPaths.get(room.name);
    if (cached && cached.key === key && cached.until > Game.time) return cached.length;
    const result = PathFinder.search(from, { pos: container.pos, range: 1 }, { maxRooms: 1 });
    const length = result.incomplete ? 1 : result.path.length;
    refillPaths.set(room.name, { until: Game.time + jitter(5000), key, length });
    return length;
}

/** Energy in storage + transporters (Hivemind getCurrentResourceAmount) */
export function currentEnergy(room: Room): number {
    return tickCache(`currentEnergy:${room.name}`, () => {
        let total = room.storage?.store.energy ?? 0;
        total += room.terminal?.store.energy ?? 0;
        total += _.sum(creepsByRole(room.name, "transporter"), c => c.store.energy);
        return total;
    });
}

/**
 * Energy the room can spend (Hivemind getStoredEnergy): storage, transporters, the pile at the base
 * center, piles and containers on harvest positions, and the controller container
 */
export function effectiveEnergy(room: Room): number {
    return tickCache(`effectiveEnergy:${room.name}`, () => {
        let total = currentEnergy(room);
        const location = storageLocation(room);
        if (!location) return total;
        const plan = roomPlanner.getPlan(room.name);
        const energyAt = (pos: RoomPosition) =>
            _.sum(pos.lookFor(LOOK_RESOURCES), r => (r.resourceType === RESOURCE_ENERGY ? r.amount : 0));
        if (!room.storage) total += energyAt(location);
        for (const pos of plan?.getLocations("harvester") ?? []) {
            total += energyAt(pos);
            for (const s of pos.lookFor(LOOK_STRUCTURES)) {
                if (s.structureType === STRUCTURE_CONTAINER) total += (s as StructureContainer).store.energy;
            }
        }
        total += controllerContainer(room)?.store.energy ?? 0;
        return total;
    });
}

export function hasEnemies(room: Room): boolean {
    return !!room.memory.enemies && !room.memory.enemies.safe;
}

/** Adjacent walkable tiles of a source (plain/swamp, no blocking structure) */
export function harvestSpots(source: Source): number {
    return tickCache(`harvestSpots:${source.id}`, () => {
        const terrain = source.room.getTerrain();
        let count = 0;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if (!dx && !dy) continue;
                const x = source.pos.x + dx;
                const y = source.pos.y + dy;
                if (x < 0 || x > 49 || y < 0 || y > 49 || terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
                const blocked = source.room
                    .lookForAt(LOOK_STRUCTURES, x, y)
                    .some(s => (OBSTACLE_OBJECT_TYPES as string[]).includes(s.structureType));
                if (!blocked) count++;
            }
        }
        return count;
    });
}

// ------------------------------------------------------------------ bays

type BayStructure = StructureSpawn | StructureExtension | StructureTower | StructureLink | StructureContainer;
const BAY_FILL_ORDER: StructureConstant[] = [STRUCTURE_SPAWN, STRUCTURE_EXTENSION, STRUCTURE_TOWER, STRUCTURE_LINK, STRUCTURE_CONTAINER];
const BAY_BLOCKERS: StructureConstant[] = [
    STRUCTURE_STORAGE, STRUCTURE_TERMINAL, STRUCTURE_FACTORY, STRUCTURE_LAB, STRUCTURE_NUKER, STRUCTURE_POWER_SPAWN
];

/** A planned 3x3 bay: a filler on the center tile reaches up to 8 structures */
export class Bay {
    readonly name: string;
    readonly structures: BayStructure[];
    readonly energy: number;
    readonly energyCapacity: number;

    constructor(readonly pos: RoomPosition, readonly isHarvesterBay: boolean) {
        this.name = `${pos.x},${pos.y}`;
        const room = Game.rooms[pos.roomName];
        const blocked =
            pos.lookFor(LOOK_STRUCTURES).some(s => (OBSTACLE_OBJECT_TYPES as string[]).includes(s.structureType)) ||
            room.lookForAtArea(LOOK_STRUCTURES, pos.y - 1, pos.x - 1, pos.y + 1, pos.x + 1, true).some(
                r => BAY_BLOCKERS.includes(r.structure.structureType)
            );
        this.structures = blocked
            ? []
            : (room
                  .lookForAtArea(LOOK_STRUCTURES, pos.y - 1, pos.x - 1, pos.y + 1, pos.x + 1, true)
                  .map(r => r.structure)
                  .filter(
                      s => BAY_FILL_ORDER.includes(s.structureType) && (!("my" in s) || (s as OwnedStructure).my || s.structureType === STRUCTURE_CONTAINER)
                  ) as BayStructure[]);
        const fillable = this.structures.filter(
            s => s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION
        ) as (StructureSpawn | StructureExtension)[];
        this.energy = _.sum(fillable, s => s.store.energy);
        this.energyCapacity = _.sum(fillable, s => s.store.getCapacity(RESOURCE_ENERGY));
    }

    needsRefill(): boolean {
        return this.energy < this.energyCapacity;
    }

    hasHarvester(): boolean {
        return this.isHarvesterBay && this.pos.lookFor(LOOK_CREEPS).some(c => c.my && c.memory.role === "harvester");
    }

    /** Transfer to the structure most in need; false once the bay is (about to be) full or the creep empty */
    refillFrom(creep: Creep): boolean {
        const needs = (s: BayStructure) =>
            s.store.getFreeCapacity(RESOURCE_ENERGY) > 0 &&
            !(s.structureType === STRUCTURE_CONTAINER && creep.memory.role === "harvester" && s.pos.isEqualTo(creep.pos));
        const target = _.min(
            this.structures.filter(needs),
            s => BAY_FILL_ORDER.indexOf(s.structureType)
        ) as BayStructure | number;
        if (typeof target === "number") return false;
        const free = target.store.getFreeCapacity(RESOURCE_ENERGY);
        const carried = creep.store.energy;
        const result = creep.transfer(target, RESOURCE_ENERGY);
        if (result !== OK) return false;
        const missing = this.energyCapacity - this.energy;
        return !(Math.min(free, carried) >= missing || carried <= free);
    }

    /** Adjacent planned road to leave the bay center */
    exitPosition(): RoomPosition | null {
        const plan = roomPlanner.getPlan(this.pos.roomName);
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if (!dx && !dy) continue;
                const x = this.pos.x + dx;
                const y = this.pos.y + dy;
                if (plan?.has({ x, y }, "road")) return new RoomPosition(x, y, this.pos.roomName);
            }
        }
        return null;
    }
}

export function roomBays(room: Room): Bay[] {
    return tickCache(`bays:${room.name}`, () => {
        const plan = roomPlanner.getPlan(room.name);
        if (!plan) return [];
        return plan.getLocations("bay_center").map(pos => new Bay(pos, plan.has(pos, "harvester")));
    });
}

/** Spawns/extensions belonging to a bay are filled through the bay */
export function isInBay(room: Room, structure: Structure): boolean {
    return tickCache(`bayStructures:${room.name}`, () => {
        const ids = new Set<string>();
        for (const bay of roomBays(room)) for (const s of bay.structures) ids.add(s.id);
        return ids;
    }).has(structure.id);
}
