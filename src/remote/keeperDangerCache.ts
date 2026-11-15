/**
 * A keeper room's dangers this tick (keepers.ts keeperDangers: live keepers, lairs spawning soon and
 * their sources), cached per room and tick in the heap: read by the civilians' flee rule
 * (roles/flee.ts) and by the TrafficManager's step guard (keepers.ts safeStepTargets).
 */

import { isKeeperOrCenter, keeperDangers, Point } from "./keepers";

export const SOURCE_KEEPER = "Source Keeper";

const dangerCache: Map<string, { tick: number; dangers: Point[] }> = new Map();

export function roomKeeperDangers(room: Room): Point[] {
    const cached = dangerCache.get(room.name);
    if (cached?.tick === Game.time) return cached.dangers;
    let dangers: Point[] = [];
    if (isKeeperOrCenter(room.name)) {
        const keepers = room.find(FIND_HOSTILE_CREEPS, { filter: c => c.owner.username === SOURCE_KEEPER }).map(c => c.pos);
        const lairStructures = room.find(FIND_HOSTILE_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_KEEPER_LAIR
        }) as StructureKeeperLair[];
        const lairs = lairStructures.map(l => ({ x: l.pos.x, y: l.pos.y, ticksToSpawn: l.ticksToSpawn }));
        const sources = lairs.length > 0 ? room.find(FIND_SOURCES).map(s => s.pos) : [];
        if (keepers.length + lairs.length > 0) dangers = keeperDangers(keepers, lairs, sources);
    }
    dangerCache.set(room.name, { tick: Game.time, dangers });
    return dangers;
}
