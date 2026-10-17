/**
 * Civilian creeps run from hostiles that can fight (Hivemind combat-manager needsToFlee, simplified:
 * flee instead of scoring every neighbour tile).
 */

import { trafficManager } from "../modules/TrafficManager";

const FLEE_RANGE = 5;

export function fleeIfThreatened(creep: Creep, home?: RoomPosition): boolean {
    const threats = creep.pos.findInRange(FIND_HOSTILE_CREEPS, FLEE_RANGE, {
        filter: c => c.getActiveBodyparts(ATTACK) + c.getActiveBodyparts(RANGED_ATTACK) > 0
    });
    if (threats.length === 0) return false;
    const goals = threats.map(c => ({ pos: c.pos, range: FLEE_RANGE + 2 }));
    const result = PathFinder.search(creep.pos, goals, { flee: true, maxRooms: 2 });
    const next = result.path[0];
    if (next) trafficManager.requestMove(creep, next, { range: 0, priority: 5 });
    else if (home) trafficManager.requestMove(creep, home, { range: 1, priority: 5 });
    return true;
}
