/**
 * Remote defender: goes to its remote, fights the hostiles met on the way and there, destroys
 * invader cores, heals itself, and is recycled once its remote is clear.
 * Simplified from Hivemind (MIT), src/role/brawler.ts (outside owned rooms: hostile creeps and
 * invader cores only).
 */

import { stayInPlace, whenInRange } from "../core/movement";
import { isFast } from "../defense/RoomDefense";
import { trafficManager } from "../modules/TrafficManager";
import { isRoomUnderAttack } from "../modules/RoomIntel";
import { groupMembers, REMOTE_DEFENDER, waitingForGroup } from "../remote/remoteDefense";
import { performRecycle } from "./recycle";
import { registerRole } from "./registry";

/** Hostiles closer than this interrupt the trip */
const ENGAGE_RANGE = 5;
/** Group members farther apart than this regroup before going on (out of fights) */
const GROUP_RANGE = 2;
/** Ranged defenders keep melee hostiles at this range */
const KITE_RANGE = 3;

export function runRemoteDefender(creep: Creep): void {
    const targetRoom = creep.memory.targetRoom;
    if (!targetRoom) {
        performRecycle(creep);
        return;
    }
    if (creep.getActiveBodyparts(HEAL) > 0) healGroup(creep);
    if (waitingForGroup(creep)) {
        const spot = trafficManager.findIdlePosition(creep);
        if (spot) trafficManager.requestMove(creep, spot, { range: 0 });
        else stayInPlace(creep);
        return;
    }

    const inTarget = creep.room.name === targetRoom;
    const hostiles = creep.room.find(FIND_HOSTILE_CREEPS, {
        filter: c => c.owner.username !== "Source Keeper" && (inTarget || c.pos.inRangeTo(creep, ENGAGE_RANGE))
    });
    const enemy = creep.pos.findClosestByRange(hostiles);
    if ((!enemy || !enemy.pos.inRangeTo(creep, ENGAGE_RANGE)) && regroup(creep)) return;
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

/** Walks to the closest group member farther than GROUP_RANGE (a pair that left together got split on the way) */
function regroup(creep: Creep): boolean {
    const group = creep.memory.defenseGroup;
    if (!group || !creep.memory.room) return false;
    // Not across a room edge: both members swapped rooms every tick to join each other
    const onEdge = (c: Creep) => c.pos.x === 0 || c.pos.y === 0 || c.pos.x === 49 || c.pos.y === 49;
    if (onEdge(creep)) return false;
    const partners = groupMembers(creep.memory.room, group).filter(c => c !== creep && !c.spawning && !onEdge(c));
    const apart = partners.filter(c => c.pos.roomName !== creep.pos.roomName || !c.pos.inRangeTo(creep, GROUP_RANGE));
    if (apart.length === 0 || apart.length < partners.length) return false;
    trafficManager.requestMove(creep, apart[0], { range: 1, priority: 30 });
    return true;
}

/** Heals the most wounded adjacent group member (Hivemind brawler), else pre-heals itself near hostiles */
function healGroup(creep: Creep): void {
    const group = creep.memory.defenseGroup;
    const allies = group && creep.memory.room ? groupMembers(creep.memory.room, group) : [creep];
    // rangedHeal would cancel rangedAttack (same action pipeline): adjacent allies only
    const wounded = allies.filter(c => !c.spawning && c.hits < c.hitsMax && c.pos.isNearTo(creep));
    if (wounded.length > 0) {
        creep.heal(_.max(wounded, c => c.hitsMax - c.hits));
        return;
    }
    if (creep.hits < creep.hitsMax || creep.room.find(FIND_HOSTILE_CREEPS).length > 0) creep.heal(creep);
}

function engage(creep: Creep, target: Creep | Structure): void {
    if (creep.getActiveBodyparts(ATTACK) > 0) {
        whenInRange(creep, 1, target, () => creep.attack(target));
        return;
    }
    if (creep.getActiveBodyparts(RANGED_ATTACK) > 0) {
        // A pair fights packed: the follower sticks to the leader, both heal whoever is hit (W7N4 mockup:
        // kiting apart, the leader got cornered on the room edge out of its partner's heal)
        const leader = groupLeader(creep);
        if (leader && leader !== creep) {
            trafficManager.requestMove(creep, leader, { range: 1, priority: 5 });
            if (creep.pos.inRangeTo(target, 3)) creep.rangedAttack(target);
            return;
        }
        // Kite melee hostiles: holding still once in range let a boosted invader walk up and strip
        // the RANGED parts first (W29N8, a mini blinky out-healed 24 vs 80 at range 1)
        if (kite(creep, !!leader)) {
            if (creep.pos.inRangeTo(target, 3)) creep.rangedAttack(target);
            return;
        }
        whenInRange(creep, 3, target, () => creep.rangedAttack(target));
        return;
    }
    stayInPlace(creep);
}

/** Leader of a creep's group (first member by name), null outside groups or when alone */
function groupLeader(creep: Creep): Creep | null {
    const group = creep.memory.defenseGroup;
    if (!group || !creep.memory.room) return null;
    const members = groupMembers(creep.memory.room, group).filter(c => !c.spawning);
    if (members.length < 2) return null;
    return _.sortBy(members, c => c.name)[0];
}

/**
 * Steps away from melee hostiles closer than KITE_RANGE; false when none or no way out. A pair leader
 * holds against hostiles as fast as itself: kiting can't shake them, it only leaves the follower behind.
 */
function kite(creep: Creep, inGroup: boolean): boolean {
    const melee = creep.pos.findInRange(FIND_HOSTILE_CREEPS, KITE_RANGE - 1, {
        filter: c => c.getActiveBodyparts(ATTACK) > 0
    });
    if (melee.length === 0) return false;
    if (inGroup && melee.some(c => isFast(c))) return false;
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
