/**
 * Hivemind's whenInRange on top of the traffic manager: register the move (or the "stay in range"
 * intent when already there) every tick, run the action once in range.
 */

import { trafficManager } from "../modules/TrafficManager";

export function whenInRange(
    creep: Creep,
    range: number,
    target: RoomPosition | _HasRoomPosition,
    action?: () => void
): boolean {
    const pos = target instanceof RoomPosition ? target : target.pos;
    trafficManager.requestMove(creep, pos, { range });
    if (creep.pos.roomName !== pos.roomName || creep.pos.getRangeTo(pos) > range) return false;
    action?.();
    return true;
}

/** Hold the current tile (and keep it from being shoved for nothing) */
export function stayInPlace(creep: Creep): void {
    trafficManager.requestMove(creep, creep.pos, { range: 0 });
}
