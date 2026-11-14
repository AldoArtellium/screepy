/**
 * Controller attacker (military/siege.ts): CLAIM x N + MOVE x N, spawned to stand next to the controller of a
 * sieged room when its upgrade block ends; attacks it once (each CLAIM part takes 300 ticks off the downgrade
 * timer and blocks upgrades 1000 ticks), then suicides (it lives 600 ticks: useless until the next block ends).
 * Our design.
 */

import { ATTACKER_TRAFFIC, CONTROLLER_ATTACKER, noteAttack, sieges, travelToSiege } from "../military/siege";
import { trafficManager } from "../modules/TrafficManager";
import { performRecycle } from "./recycle";
import { registerRole } from "./registry";

export function runControllerAttacker(creep: Creep): void {
    // Suicide the tick after the attack: in the same tick it could cancel the attack intent
    if (creep.memory.attacked) {
        creep.suicide();
        return;
    }
    const target = creep.memory.siege;
    if (!target || !sieges()[target]) {
        performRecycle(creep);
        return;
    }
    if (creep.room.name !== target) {
        travelToSiege(creep, target);
        return;
    }
    const controller = creep.room.controller;
    if (!controller?.owner || controller.my) {
        performRecycle(creep);
        return;
    }
    trafficManager.requestMove(creep, controller, { range: 1, priority: ATTACKER_TRAFFIC });
    if (!creep.pos.isNearTo(controller) || controller.upgradeBlocked || controller.safeMode) return;
    if (creep.attackController(controller) === OK) {
        creep.memory.attacked = true;
        noteAttack(target, controller);
    }
}

registerRole(CONTROLLER_ATTACKER, runControllerAttacker);
