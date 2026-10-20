/**
 * Spawn energy order and exit directions (not in Hivemind).
 *
 * energyStructures: spawns and extensions of harvester bays first (their harvester refills them for
 * free, Bay.refillFrom), then the others closest to the base center first, so transporters walk
 * less to refill what a spawn drained. The International room/commune/commune.ts
 * (spawningStructuresByPriority), Overmind hiveClusters/hatchery.ts (energyStructures).
 *
 * directions: new creeps leave towards the free adjacent tile farthest from the base center,
 * planned bay centers / harvest / upgrader / parking tiles last (The International
 * spawningStructureOps.ts findDirections). Every walkable direction stays listed, so the engine
 * behaves as without directions when the preferred tiles are taken.
 */

import { roomPlanner } from "../planner/RoomPlanner";
import { roomBays, structuresOfType } from "../core/roomState";
import { jitter } from "../utils/jitter";

const ORDER_TTL = 1000;
const DIRECTIONS_TTL = 500;
/** Planned tiles a creep should not be pushed onto when leaving the spawn */
const RESERVED_TYPES = ["bay_center", "harvester", "upgrader", "helper_parking"];

interface EnergyOrder {
    until: number;
    count: number;
    ids: Id<StructureSpawn | StructureExtension>[];
}

interface SpawnDirections {
    until: number;
    directions: DirectionConstant[];
}

const energyOrders: Map<string, EnergyOrder> = new Map();
const spawnDirections: Map<string, SpawnDirections> = new Map();

function baseCenter(room: Room): RoomPosition | null {
    return roomPlanner.getPlan(room.name)?.getCenter() ?? room.storage?.pos ?? null;
}

function energyStructureList(room: Room): (StructureSpawn | StructureExtension)[] {
    return [
        ...structuresOfType<StructureSpawn>(room, STRUCTURE_SPAWN),
        ...structuresOfType<StructureExtension>(room, STRUCTURE_EXTENSION)
    ].filter(s => s.my);
}

/** Spawns and extensions in the order the spawn should drain them; undefined = engine default */
export function spawnEnergyStructures(room: Room): (StructureSpawn | StructureExtension)[] | undefined {
    const structures = energyStructureList(room);
    let cached = energyOrders.get(room.name);
    if (!cached || cached.until <= Game.time || cached.count !== structures.length) {
        const center = baseCenter(room);
        if (!center) {
            energyOrders.delete(room.name);
            return undefined;
        }
        const harvesterBay = new Set<string>();
        for (const bay of roomBays(room)) {
            if (bay.isHarvesterBay) for (const s of bay.structures) harvesterBay.add(s.id);
        }
        const sorted = _.sortBy(structures, s => (harvesterBay.has(s.id) ? 0 : 1000) + s.pos.getRangeTo(center));
        cached = { until: Game.time + jitter(ORDER_TTL), count: structures.length, ids: sorted.map(s => s.id) };
        energyOrders.set(room.name, cached);
    }
    const ordered: (StructureSpawn | StructureExtension)[] = [];
    for (const id of cached.ids) {
        const s = Game.getObjectById(id);
        if (s) ordered.push(s);
    }
    // Every structure with energy must be listed: the engine only draws from the list
    return ordered.length === structures.length ? ordered : undefined;
}

/** Directions for a creep leaving this spawn, preferred first; undefined = engine default */
export function spawnExitDirections(spawn: StructureSpawn): DirectionConstant[] | undefined {
    const cached = spawnDirections.get(spawn.id);
    if (cached && cached.until > Game.time) return cached.directions.length > 0 ? cached.directions : undefined;

    const room = spawn.room;
    const center = baseCenter(room);
    const plan = roomPlanner.getPlan(room.name);
    let directions: DirectionConstant[] = [];
    if (center && plan) {
        const terrain = room.getTerrain();
        const candidates: { direction: DirectionConstant; score: number }[] = [];
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if (!dx && !dy) continue;
                const x = spawn.pos.x + dx;
                const y = spawn.pos.y + dy;
                if (x < 1 || x > 48 || y < 1 || y > 48 || terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
                const pos = new RoomPosition(x, y, room.name);
                const blocked = pos.lookFor(LOOK_STRUCTURES).some(
                    s =>
                        (OBSTACLE_OBJECT_TYPES as string[]).includes(s.structureType) ||
                        (s.structureType === STRUCTURE_RAMPART &&
                            !(s as StructureRampart).my &&
                            !(s as StructureRampart).isPublic)
                );
                if (blocked) continue;
                const reserved = RESERVED_TYPES.some(type => plan.has(pos, type));
                const score = (reserved ? 0 : 100) + pos.getRangeTo(center);
                candidates.push({ direction: spawn.pos.getDirectionTo(pos), score });
            }
        }
        directions = _.sortBy(candidates, c => -c.score).map(c => c.direction);
    }
    spawnDirections.set(spawn.id, { until: Game.time + jitter(DIRECTIONS_TTL), directions });
    return directions.length > 0 ? directions : undefined;
}
