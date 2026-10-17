/**
 * Recycle a creep at the closest spawn (suicide when the room has none).
 * Ported from Hivemind (MIT), src/role/role.ts performRecycle.
 */

import { whenInRange } from "../core/movement";
import { mySpawns } from "../core/roomState";

export function performRecycle(creep: Creep): void {
    const home = Game.rooms[creep.memory.room ?? creep.room.name] ?? creep.room;
    const spawn = creep.pos.findClosestByRange(mySpawns(home)) ?? mySpawns(home)[0];
    if (!spawn) {
        creep.suicide();
        return;
    }
    whenInRange(creep, 1, spawn, () => spawn.recycleCreep(creep));
}
