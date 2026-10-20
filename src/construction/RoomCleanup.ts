/**
 * RoomCleanup - removes what stands in the way of the plan in owned rooms (a claimed room's previous
 * owner, abandoned walls). Ported from Hivemind (MIT), src/room/room-manager.ts cleanRoom (:242-330:
 * removeHostileStructures, removeHostileConstructionSites, cleanExtensions / cleanLabs / cleanLinks,
 * cleanWalls) and dismantleUnwantedDefenses (:504-525, walls).
 *
 * - Construction sites of other players: removed.
 * - Structures of other players: destroyed, except stores holding resources (storage, terminal,
 *   labs...): looted first by the dispatcher (grave source), destroyed once nearly empty or after
 *   LOOT_TICKS (destroy() leaves a ruin, also looted).
 * - Once the plan is final: walls not planned (novice walls can't be destroyed and are left), and our
 *   extensions, labs, links and containers on a tile planned for another structure (or an extension,
 *   lab or link on a planned road). Our spawns, towers, storage, terminal and ramparts are never
 *   destroyed.
 *
 * destroy() fails while hostile creeps are in the room: the room is skipped until they are gone.
 * Deviation: runs every 100 ticks (Hivemind: once per room, behind a feature flag).
 */

import { RoomPlan } from "../planner/RoomPlan";
import { roomPlanner } from "../planner/RoomPlanner";
import { log } from "../utils/logger";
import { countStat } from "../utils/stats";

/** Others' stores holding at least this much are looted before being destroyed */
const LOOT_MIN = 1000;
/** ...for at most this long after first seen (heap) */
const LOOT_TICKS = 5000;
const lootSeen: Map<string, number> = new Map();

/** Our structures destroyed when they block a planned tile of another type (Hivemind clean*) */
const MOVABLE: StructureConstant[] = [STRUCTURE_EXTENSION, STRUCTURE_LAB, STRUCTURE_LINK, STRUCTURE_CONTAINER];

/** Plan location types per structure type ("extension.bay.0" -> extension, "wall" -> constructedWall) */
function plannedTypes(plan: RoomPlan): Map<number, Set<string>> {
    const tiles: Map<number, Set<string>> = new Map();
    for (const type of plan.types()) {
        const base = type.split(".")[0];
        const structureType = base === "wall" ? STRUCTURE_WALL : base;
        if (!(structureType in CONSTRUCTION_COST)) continue;
        for (const pos of plan.getLocations(type)) {
            const xy = pos.x + 50 * pos.y;
            let set = tiles.get(xy);
            if (!set) tiles.set(xy, (set = new Set()));
            set.add(structureType);
        }
    }
    return tiles;
}

function destroy(structure: Structure, reason: string): void {
    if (structure.destroy() !== OK) return;
    countStat(`cleanup:${structure.structureType}`);
    log.info("RoomCleanup", `${structure.room.name}: destroyed ${structure.structureType} at ${structure.pos.x},${structure.pos.y} (${reason})`);
}

function removeHostileSites(room: Room): void {
    for (const site of room.find(FIND_HOSTILE_CONSTRUCTION_SITES)) {
        if (site.remove() === OK) countStat("cleanup:site");
    }
}

/** Loot first: a store with resources waits until nearly empty, at most LOOT_TICKS */
function waitsForLoot(structure: Structure): boolean {
    const store = (structure as AnyStoreStructure).store as Store<ResourceConstant, false> | undefined;
    if (!store || store.getUsedCapacity() < LOOT_MIN) return false;
    const seen = lootSeen.get(structure.id) ?? Game.time;
    lootSeen.set(structure.id, seen);
    return Game.time - seen < LOOT_TICKS;
}

function removeHostileStructures(room: Room): void {
    for (const structure of room.find(FIND_HOSTILE_STRUCTURES)) {
        if (!(structure.structureType in CONSTRUCTION_COST)) continue;
        if (waitsForLoot(structure)) continue;
        lootSeen.delete(structure.id);
        destroy(structure, `owned by ${structure.owner?.username}`);
    }
}

function cleanPlannedTiles(room: Room, plan: RoomPlan): void {
    const planned = plannedTypes(plan);
    for (const structure of room.find(FIND_STRUCTURES)) {
        const type = structure.structureType;
        const types = planned.get(structure.pos.x + 50 * structure.pos.y);
        if (type === STRUCTURE_WALL) {
            // Novice area walls can't be destroyed (they disappear on their own)
            const novice = (structure as StructureWall).ticksToLive !== undefined;
            if (!novice && !types?.has(STRUCTURE_WALL)) destroy(structure, "wall not planned");
            continue;
        }
        if (!types || types.has(type) || !(structure as OwnedStructure).my && type !== STRUCTURE_CONTAINER) continue;
        if (!MOVABLE.includes(type)) continue;
        const blocksBuilding = [...types].some(t => t !== STRUCTURE_ROAD && t !== STRUCTURE_RAMPART);
        const blocksRoad = types.has(STRUCTURE_ROAD) && type !== STRUCTURE_CONTAINER;
        if (blocksBuilding || blocksRoad) destroy(structure, `planned ${[...types].join("/")}`);
    }
}

export const roomCleanupModule = () => {
    for (const name in Game.rooms) {
        const room = Game.rooms[name];
        if (!room.controller?.my) continue;
        removeHostileSites(room);
        // destroy() returns ERR_BUSY with hostile creeps in the room
        if (room.find(FIND_HOSTILE_CREEPS).length > 0 || room.find(FIND_HOSTILE_POWER_CREEPS).length > 0) continue;
        removeHostileStructures(room);
        const plan = roomPlanner.getPlan(room.name);
        if (plan && roomPlanner.isFinal(room.name)) cleanPlannedTiles(room, plan);
    }
};
