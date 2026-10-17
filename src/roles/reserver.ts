/**
 * Reserver: keeps a remote controller reserved (doubles its sources), attacks other reservations.
 * Ported from Hivemind (MIT), src/role/claimer.ts (mission "reserve").
 */

import { whenInRange } from "../core/movement";
import { trafficManager } from "../modules/TrafficManager";
import { RESERVER } from "../remote/remoteSpawnRole";
import { fleeIfThreatened } from "./flee";
import { registerRole } from "./registry";

export function runReserver(creep: Creep): void {
    const roomName = creep.memory.reserveRoom;
    if (!roomName) return;
    const controllerPos = Memory.intel?.[roomName]?.controllerPos;
    if (!controllerPos) return;
    const target = new RoomPosition(controllerPos.x, controllerPos.y, roomName);
    if (fleeIfThreatened(creep, target)) return;
    if (creep.room.name !== roomName) {
        trafficManager.requestMove(creep, target, { range: 1, priority: 40 });
        return;
    }
    const controller = creep.room.controller;
    if (!controller) return;
    whenInRange(creep, 1, controller, () => {
        const reservation = controller.reservation;
        const mine = reservation?.username === creep.owner.username;
        creep.room.memory.lastClaim = { time: Game.time, value: mine ? reservation!.ticksToEnd : 0 };
        if (reservation && !mine) {
            creep.attackController(controller);
            return;
        }
        creep.reserveController(controller);
    });
}

registerRole(RESERVER, runReserver);
