/**
 * Claimer: claims its target room's controller (attacks another player's reservation or ownership
 * first; reserves when the GCL has no room left), then is recycled.
 * Ported from Hivemind (MIT), src/role/claimer.ts (mission "claim") and the singleClaim unit of
 * role/brawler.ts.
 */

import { whenInRange } from "../core/movement";
import { CLAIMER } from "../expansion/squadSpawnRole";
import { intelManager } from "../modules/IntelManager";
import { trafficManager } from "../modules/TrafficManager";
import { fleeIfThreatened } from "./flee";
import { performRecycle } from "./recycle";
import { registerRole } from "./registry";

export function runClaimer(creep: Creep): void {
    const target = creep.memory.targetRoom;
    if (!target) {
        performRecycle(creep);
        return;
    }
    if (creep.room.name !== target) {
        const pos = intelManager.getIntel(target)?.controllerPos;
        const goal = pos ? new RoomPosition(pos.x, pos.y, target) : new RoomPosition(25, 25, target);
        if (fleeIfThreatened(creep, goal)) return;
        trafficManager.requestMove(creep, goal, { range: 1, priority: 30 });
        return;
    }
    const controller = creep.room.controller;
    if (!controller || controller.my) {
        // Forget the target, else it walks back in as soon as it leaves the room
        delete creep.memory.targetRoom;
        performRecycle(creep);
        return;
    }
    whenInRange(creep, 1, controller, () => {
        const reservedByOther = !!controller.reservation && controller.reservation.username !== creep.owner.username;
        if ((controller.owner && !controller.my) || reservedByOther) {
            creep.attackController(controller);
            return;
        }
        const owned = _.filter(Game.rooms, r => !!r.controller?.my).length;
        if (owned < Game.gcl.level) creep.claimController(controller);
        else creep.reserveController(controller);
    });
}

registerRole(CLAIMER, runClaimer);
