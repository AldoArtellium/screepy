/**
 * Safe mode bait (military/bait.ts): walks to a player room along the squad route and hits the closest
 * hostile structure (spawns and towers first) until the owner safe-modes the room; recycled once its bait
 * ended. Our design.
 */

import { BAIT, baitTarget, travelToBait } from "../military/bait";
import { trafficManager } from "../modules/TrafficManager";
import { performRecycle } from "./recycle";
import { registerRole } from "./registry";

const ORDER: { [type: string]: number } = { [STRUCTURE_SPAWN]: 0, [STRUCTURE_TOWER]: 1 };

function structureToHit(creep: Creep): Structure | null {
    const structures = creep.room.find(FIND_HOSTILE_STRUCTURES, {
        filter: s => s.structureType !== STRUCTURE_CONTROLLER && s.structureType !== STRUCTURE_KEEPER_LAIR
    });
    if (structures.length === 0) return null;
    const best = _.min(structures.map(s => ORDER[s.structureType] ?? 2));
    return creep.pos.findClosestByRange(structures.filter(s => (ORDER[s.structureType] ?? 2) === best));
}

export function runBait(creep: Creep): void {
    const target = baitTarget(creep);
    if (!target) {
        performRecycle(creep);
        return;
    }
    if (creep.room.name !== target) {
        trafficManager.moveToRoom(creep, travelToBait(creep, target));
        return;
    }
    const structure = structureToHit(creep);
    if (!structure) return;
    if (creep.pos.isNearTo(structure)) creep.attack(structure);
    trafficManager.requestMove(creep, structure, { range: 1, combat: true });
}

registerRole(BAIT, runBait);
