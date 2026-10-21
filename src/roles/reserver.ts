/**
 * Reserver: keeps a remote controller reserved (doubles its sources), attacks other reservations.
 * Ported from Hivemind (MIT), src/role/claimer.ts (mission "reserve").
 */

import { followPath, whenInRange } from "../core/movement";
import { intelManager } from "../modules/IntelManager";
import { trafficManager } from "../modules/TrafficManager";
import { remotePath, remoteSources } from "../remote/RemoteMining";
import { RESERVER } from "../remote/remoteSpawnRole";
import { fleeIfThreatened } from "./flee";
import { registerRole } from "./registry";

export function runReserver(creep: Creep): void {
    const roomName = creep.memory.reserveRoom;
    if (!roomName) return;
    const controllerPos = intelManager.getIntel(roomName)?.controllerPos;
    if (!controllerPos) return;
    const target = new RoomPosition(controllerPos.x, controllerPos.y, roomName);
    if (fleeIfThreatened(creep, target)) return;
    if (creep.room.name !== roomName) {
        // The stored path of one of the room's sources up to the room, then the controller
        const source = remoteSources(creep.memory.room ?? "").find(s => s.room === roomName);
        if (source && followPath(creep, remotePath(source), true, 40)) return;
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
        // At the cap a reserve adds nothing but still costs an intent (0.2 official CPU)
        if (mine && reservation!.ticksToEnd + creep.getActiveBodyparts(CLAIM) > CONTROLLER_RESERVE_MAX) return;
        creep.reserveController(controller);
    });
}

registerRole(RESERVER, runReserver);
