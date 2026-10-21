/**
 * Remote harvester travel time in ticks, for timing replacements (not in Hivemind, which uses the path
 * length: a ROAD body off roads takes 2 ticks per plain tile and ~8 per swamp tile). Estimated from the
 * path terrain and the body's fatigue, raised to the travel observed on arrival; a spawn lead per home,
 * learnt from how late replacements spawn, covers the spawn queue.
 */

import { jitter } from "../utils/jitter";

export interface PathTerrain {
    plain: number;
    swamp: number;
    road: number;
}

/** Fatigue a non-MOVE part generates per step (Screeps: road 1, plain 2, swamp 10) */
const FATIGUE = { road: 1, plain: 2, swamp: 10 };

/** Spawn lead learnt per home, at most (a jammed spawn should not keep two harvesters per source) */
const MAX_SPAWN_LEAD = 200;

/**
 * Ticks a body takes to walk a path: every step adds `weight` (WORK and loaded CARRY parts) x the tile's
 * fatigue, MOVE parts remove 2 each per tick, and the creep steps again once its fatigue is 0
 */
export function walkTicks(terrain: PathTerrain, weight: number, move: number): number {
    if (move === 0) return Infinity;
    const step = (factor: number) => Math.max(1, Math.ceil((weight * factor) / (2 * move)));
    return terrain.plain * step(FATIGUE.plain) + terrain.swamp * step(FATIGUE.swamp) + terrain.road * step(FATIGUE.road);
}

/** Path terrain per source key (heap; roads are only known in visible rooms, else counted as terrain) */
const terrainCache = new Map<string, { until: number; terrain: PathTerrain }>();

export function pathTerrain(key: string, path: RoomPosition[]): PathTerrain {
    const cached = terrainCache.get(key);
    if (cached && cached.until > Game.time) return cached.terrain;
    const terrain: PathTerrain = { plain: 0, swamp: 0, road: 0 };
    const roads = new Map<string, Set<number>>();
    for (const pos of path) {
        let roomRoads = roads.get(pos.roomName);
        if (!roomRoads) {
            const found = Game.rooms[pos.roomName]?.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_ROAD });
            roomRoads = new Set((found ?? []).map(s => s.pos.x * 50 + s.pos.y));
            roads.set(pos.roomName, roomRoads);
        }
        if (roomRoads.has(pos.x * 50 + pos.y)) terrain.road++;
        else if (Game.map.getRoomTerrain(pos.roomName).get(pos.x, pos.y) & TERRAIN_MASK_SWAMP) terrain.swamp++;
        else terrain.plain++;
    }
    terrainCache.set(key, { until: Game.time + jitter(1000), terrain });
    return terrain;
}

/** Travel ticks observed per source key (heap, slow average) */
const observedTravel = new Map<string, number>();

export function recordTravel(key: string, ticks: number): void {
    const old = observedTravel.get(key);
    observedTravel.set(key, old === undefined ? ticks : old * 0.7 + ticks * 0.3);
}

export function travelObserved(key: string): number | undefined {
    return observedTravel.get(key);
}

/** Spawn lead per home (heap): raised by each replacement spawned after its deadline, lowered by early ones */
const spawnLead = new Map<string, number>();

/**
 * `lateness`: spawn tick minus the replacement's deadline (negative when early). Integrating it, rather than
 * averaging the wait since the option was first offered, settles on the queue time: a longer lead offers the
 * option sooner, which only lengthens that wait.
 */
export function recordSpawnLateness(home: string, lateness: number): void {
    const lead = (spawnLead.get(home) ?? 0) + 0.3 * lateness;
    spawnLead.set(home, Math.max(0, Math.min(MAX_SPAWN_LEAD, lead)));
}

export function spawnLeadObserved(home: string): number {
    return spawnLead.get(home) ?? 0;
}
