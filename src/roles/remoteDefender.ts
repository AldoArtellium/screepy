/**
 * Remote defender: goes to its remote, fights the hostiles met on the way and there, destroys
 * invader cores, heals itself, and is recycled once its remote is clear.
 * Simplified from Hivemind (MIT), src/role/brawler.ts (outside owned rooms: hostile creeps and
 * invader cores only).
 */

import { stayInPlace, whenInRange } from "../core/movement";
import { trafficManager } from "../modules/TrafficManager";
import { isRoomUnderAttack } from "../modules/RoomIntel";
import { REMOTE_DEFENDER } from "../remote/remoteDefense";
import { performRecycle } from "./recycle";
import { registerRole } from "./registry";

/** Hostiles closer than this interrupt the trip */
const ENGAGE_RANGE = 5;

export function runRemoteDefender(creep: Creep): void {
    const targetRoom = creep.memory.targetRoom;
    if (!targetRoom) {
        performRecycle(creep);
        return;
    }
    if (creep.hits < creep.hitsMax && creep.getActiveBodyparts(HEAL) > 0) creep.heal(creep);

    const inTarget = creep.room.name === targetRoom;
    const hostiles = creep.room.find(FIND_HOSTILE_CREEPS, {
        filter: c => c.owner.username !== "Source Keeper" && (inTarget || c.pos.inRangeTo(creep, ENGAGE_RANGE))
    });
    const enemy = creep.pos.findClosestByRange(hostiles);
    if (enemy) {
        engage(creep, enemy);
        return;
    }
    if (!inTarget) {
        trafficManager.moveToRoom(creep, targetRoom, { priority: 30 });
        return;
    }
    const core = creep.room.find(FIND_HOSTILE_STRUCTURES, {
        filter: s => s.structureType === STRUCTURE_INVADER_CORE
    })[0];
    if (core) {
        engage(creep, core);
        return;
    }
    if (!isRoomUnderAttack(targetRoom)) {
        // Forget the target: else, back out of it, the defender walked to it again (endless bounce
        // on the room edge)
        delete creep.memory.targetRoom;
        performRecycle(creep);
        return;
    }
    stayInPlace(creep);
}

function engage(creep: Creep, target: Creep | Structure): void {
    if (creep.getActiveBodyparts(ATTACK) > 0) {
        whenInRange(creep, 1, target, () => creep.attack(target));
        return;
    }
    if (creep.getActiveBodyparts(RANGED_ATTACK) > 0) {
        whenInRange(creep, 3, target, () => creep.rangedAttack(target));
        return;
    }
    stayInPlace(creep);
}

registerRole(REMOTE_DEFENDER, runRemoteDefender);
