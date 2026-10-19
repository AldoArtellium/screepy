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
/** Ranged defenders keep melee hostiles at this range */
const KITE_RANGE = 3;

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
        // Kite melee hostiles: holding still once in range let a boosted invader walk up and strip
        // the RANGED parts first (W29N8, a mini blinky out-healed 24 vs 80 at range 1)
        if (kite(creep)) {
            if (creep.pos.inRangeTo(target, 3)) creep.rangedAttack(target);
            return;
        }
        whenInRange(creep, 3, target, () => creep.rangedAttack(target));
        return;
    }
    stayInPlace(creep);
}

/** Steps away from melee hostiles closer than KITE_RANGE; false when none or no way out */
function kite(creep: Creep): boolean {
    const melee = creep.pos.findInRange(FIND_HOSTILE_CREEPS, KITE_RANGE - 1, {
        filter: c => c.getActiveBodyparts(ATTACK) > 0
    });
    if (melee.length === 0) return false;
    const result = PathFinder.search(
        creep.pos,
        melee.map(c => ({ pos: c.pos, range: KITE_RANGE })),
        { flee: true, maxRooms: 1, roomCallback: exitCosts }
    );
    const next = result.path[0];
    if (!next) return false;
    trafficManager.requestMove(creep, next, { range: 0, priority: 5 });
    return true;
}

/** Exit tiles are a last resort: they carry the creep out of the room it defends */
function exitCosts(roomName: string): CostMatrix {
    const matrix = new PathFinder.CostMatrix();
    const terrain = Game.map.getRoomTerrain(roomName);
    for (let i = 0; i < 50; i++) {
        for (const [x, y] of [
            [i, 0],
            [i, 49],
            [0, i],
            [49, i]
        ]) {
            if (terrain.get(x, y) !== TERRAIN_MASK_WALL) matrix.set(x, y, 20);
        }
    }
    return matrix;
}

registerRole(REMOTE_DEFENDER, runRemoteDefender);
