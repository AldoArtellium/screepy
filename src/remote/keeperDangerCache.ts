/**
 * A keeper room's keepers and lairs this tick, and its dangers (keepers.ts keeperDangers: live keepers,
 * lairs spawning soon and their sources), cached per room and tick in the heap: read by the civilians'
 * flee rule (roles/flee.ts), the TrafficManager's step guard (keepers.ts safeStepTargets) and the
 * keeper killer (roles/keeperKiller.ts).
 */

import { isKeeperOrCenter, keeperDangers, Point, SOURCE_KEEPER } from "./keepers";

const scanCache: Map<string, { tick: number; keepers: Creep[]; lairs: StructureKeeperLair[] }> = new Map();
const dangerCache: Map<string, { tick: number; dangers: Point[] }> = new Map();

/** The room's live source keepers and keeper lairs this tick */
export function keeperScan(room: Room): { keepers: Creep[]; lairs: StructureKeeperLair[] } {
    const cached = scanCache.get(room.name);
    if (cached?.tick === Game.time) return cached;
    const keepers = room.find(FIND_HOSTILE_CREEPS, { filter: c => c.owner.username === SOURCE_KEEPER });
    const lairs = room.find(FIND_HOSTILE_STRUCTURES, {
        filter: s => s.structureType === STRUCTURE_KEEPER_LAIR
    }) as StructureKeeperLair[];
    const scan = { tick: Game.time, keepers, lairs };
    scanCache.set(room.name, scan);
    return scan;
}

export function roomKeeperDangers(room: Room): Point[] {
    const cached = dangerCache.get(room.name);
    if (cached?.tick === Game.time) return cached.dangers;
    let dangers: Point[] = [];
    if (isKeeperOrCenter(room.name)) {
        const scan = keeperScan(room);
        const keepers = scan.keepers.map(c => c.pos);
        const lairs = scan.lairs.map(l => ({ x: l.pos.x, y: l.pos.y, ticksToSpawn: l.ticksToSpawn }));
        const sources = lairs.length > 0 ? room.find(FIND_SOURCES).map(s => s.pos) : [];
        if (keepers.length + lairs.length > 0) dangers = keeperDangers(keepers, lairs, sources);
    }
    dangerCache.set(room.name, { tick: Game.time, dangers });
    return dangers;
}
