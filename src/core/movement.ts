/**
 * Hivemind's whenInRange on top of the traffic manager: register the move (or the "stay in range"
 * intent when already there) every tick, run the action once in range.
 */

import { EDGE_BOUNCES, trafficManager } from "../modules/TrafficManager";
import { countStat, recordSample } from "../utils/stats";

export function whenInRange(
    creep: Creep,
    range: number,
    target: RoomPosition | _HasRoomPosition,
    action?: () => void
): boolean {
    const pos = target instanceof RoomPosition ? target : target.pos;
    trafficManager.requestMove(creep, pos, { range });
    if (creep.pos.roomName !== pos.roomName || creep.pos.getRangeTo(pos) > range) return false;
    action?.();
    return true;
}

/** Hold the current tile (and keep it from being shoved for nothing) */
export function stayInPlace(creep: Creep): void {
    trafficManager.requestMove(creep, creep.pos, { range: 0 });
}

/** Ticks a creep stuck on a stored path walks with the normal pathfinder before trying the path again */
const DETOUR_TICKS = 5;
/** Stuck ticks on a stored path before the detour */
const STUCK_TICKS = 3;

/** Tile on a room edge: the engine carries a creep left there to the next room */
function isExitTile(pos: RoomPosition): boolean {
    return pos.x === 0 || pos.x === 49 || pos.y === 0 || pos.y === 49;
}

/** Last path index and detour end per creep (heap; lost on a global reset, then looked up again) */
const pathIndexCache: Map<string, number> = new Map();
const detourUntil: Map<string, number> = new Map();
let cacheCleaned = 0;

/** Path index of the creep's tile, looked up around the last known index first; null when off the path */
export function pathIndexOf(creep: Creep, path: RoomPosition[]): number | null {
    const last = pathIndexCache.get(creep.name);
    if (last !== undefined) {
        for (let i = Math.max(0, last - 3); i <= Math.min(path.length - 1, last + 3); i++) {
            if (path[i].isEqualTo(creep.pos)) return i;
        }
    }
    const index = path.findIndex(p => p.isEqualTo(creep.pos));
    return index === -1 ? null : index;
}

/**
 * Walk one tile along a stored path (The International createMoveRequestByPath): towards index 0
 * when `backwards`, else towards the last index. On the path the creep steps onto the next tile
 * without a path search (the traffic manager still shoves and swaps); off the path it heads for the
 * closest path tile of its room (ahead first). Returns false when the caller should move by itself:
 * end of the path, no path tile in the room, or a detour after being stuck on the path.
 */
export function followPath(creep: Creep, path: RoomPosition[], backwards: boolean, priority?: number): boolean {
    if (Game.time - cacheCleaned >= 500) {
        cacheCleaned = Game.time;
        for (const name of pathIndexCache.keys()) if (!Game.creeps[name]) pathIndexCache.delete(name);
        for (const [name, until] of detourUntil) if (until <= Game.time) detourUntil.delete(name);
    }
    if (path.length === 0) return false;
    if ((detourUntil.get(creep.name) ?? 0) > Game.time) return false;
    const bounced = trafficManager.getEdgeBounces(creep) >= EDGE_BOUNCES;
    if (bounced || trafficManager.getStuckTicks(creep) >= STUCK_TICKS) {
        detourUntil.set(creep.name, Game.time + DETOUR_TICKS);
        if (bounced) {
            countStat("move:edgeBounce");
            const index = pathIndexOf(creep, path);
            const where = `${index === null ? "off" : `at ${index}`}/${path.length} ${backwards ? "back" : "fwd"}`;
            recordSample("edgeBounces", `${creep.memory.role} ${creep.pos} ${where}`);
        }
        countStat("move:pathDetour");
        return false;
    }
    const index = pathIndexOf(creep, path);
    if (index === null) return rejoinPath(creep, path, backwards, priority);
    pathIndexCache.set(creep.name, index);
    const next = backwards ? index - 1 : index + 1;
    if (next < 0 || next >= path.length) return false;
    const pos = path[next];
    // Exit tiles carry the creep to the next room by themselves
    if (pos.roomName !== creep.pos.roomName) return false;
    trafficManager.requestStep(creep, pos, priority);
    countStat("move:pathStep");
    return true;
}

/**
 * Exit tiles of the path are never targets: a creep stepping onto one is carried to the next room off
 * the path, and from an exit tile the engine PathFinder can't reach an exit tile of the same edge 1-2
 * tiles away (see TrafficManager.sameEdgeHop): the creep stayed on its exit tile and bounced between
 * the two rooms every tick (shard0 W29N6/W29N7). The inner tile next to the crossing is used instead.
 */
function rejoinPath(creep: Creep, path: RoomPosition[], backwards: boolean, priority?: number): boolean {
    let best = -1;
    let bestRange = Infinity;
    for (let i = 0; i < path.length; i++) {
        const pos = path[i];
        if (pos.roomName !== creep.pos.roomName || isExitTile(pos)) continue;
        const range = creep.pos.getRangeTo(pos);
        // Equal range: the tile further along the way wins
        const ahead = best === -1 || (backwards ? i < best : i > best);
        if (range < bestRange || (range === bestRange && ahead)) {
            best = i;
            bestRange = range;
        }
    }
    if (best === -1) return false;
    if (bestRange <= 1) {
        pathIndexCache.set(creep.name, best);
        trafficManager.requestStep(creep, path[best], priority);
        countStat("move:pathRejoin");
        return true;
    }
    // Never a tile held by a creep (the container tile's harvester never moves): cartographer's
    // fallback path avoids creeps, so an occupied target means ERR_NO_PATH every tick
    let target = -1;
    let targetRange = Infinity;
    for (let i = 0; i < path.length; i++) {
        const pos = path[i];
        if (pos.roomName !== creep.pos.roomName || i === 0 || isExitTile(pos)) continue;
        const range = creep.pos.getRangeTo(pos);
        if (range < targetRange && pos.lookFor(LOOK_CREEPS).length === 0) {
            target = i;
            targetRange = range;
        }
    }
    if (target === -1) return false;
    trafficManager.requestMove(creep, path[target], { range: 0, priority });
    countStat("move:pathRejoin");
    return true;
}
