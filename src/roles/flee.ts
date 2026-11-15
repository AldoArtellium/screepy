/**
 * Civilian creeps run from hostiles that can fight (Hivemind combat-manager needsToFlee, simplified:
 * flee instead of scoring every neighbour tile).
 *
 * Source keepers (2026-11-14, keeper mining): a keeper guards its source and only strikes within 3, so
 * civilians step out of range 3 of a live keeper or of a lair spawning within 10 ticks (keepers.ts),
 * and come back once the room's keeperKiller has cleared it; they used to flee every keeper at 5.
 * They never step back in on their own: the TrafficManager drops such steps (keepers.ts safeStepTargets).
 */

import { trafficManager } from "../modules/TrafficManager";
import { roomKeeperDangers } from "../remote/keeperDangerCache";
import { inKeeperDanger, KEEPER_FLEE_RANGE, SOURCE_KEEPER } from "../remote/keepers";
import { countStat } from "../utils/stats";

const FLEE_RANGE = 5;

function fleeFrom(creep: Creep, goals: { pos: RoomPosition; range: number }[], home?: RoomPosition): void {
    const result = PathFinder.search(creep.pos, goals, { flee: true, maxRooms: 2 });
    const next = result.path[0];
    if (next) trafficManager.requestMove(creep, next, { range: 0, priority: 5 });
    else if (home) trafficManager.requestMove(creep, home, { range: 1, priority: 5 });
}

export function fleeIfThreatened(creep: Creep, home?: RoomPosition): boolean {
    const threats = creep.pos.findInRange(FIND_HOSTILE_CREEPS, FLEE_RANGE, {
        filter: c =>
            c.owner.username !== SOURCE_KEEPER && c.getActiveBodyparts(ATTACK) + c.getActiveBodyparts(RANGED_ATTACK) > 0
    });
    if (threats.length > 0) {
        fleeFrom(creep, threats.map(c => ({ pos: c.pos, range: FLEE_RANGE + 2 })), home);
        return true;
    }
    const dangers = roomKeeperDangers(creep.room);
    // A civilian hurt in a keeper room (creep-ticks): the flee rule came too late
    if (dangers.length > 0 && creep.hits < creep.hitsMax) countStat("keeper:hit");
    if (dangers.length === 0 || !inKeeperDanger(creep.pos, dangers)) return false;
    countStat("keeper:flee");
    const roomName = creep.room.name;
    fleeFrom(creep, dangers.map(d => ({ pos: new RoomPosition(d.x, d.y, roomName), range: KEEPER_FLEE_RANGE + 1 })), home);
    return true;
}
