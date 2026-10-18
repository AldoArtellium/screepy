/**
 * MemoryCleanup - drops the memory of dead creeps (every 100 ticks) and of rooms nothing uses any
 * more (every 1000 ticks): not owned, not mined as a remote, not targeted by expansion or military,
 * no hostile still expected alive; the plans of rooms no longer used go with them.
 */

import { roomPlanner } from "../planner/RoomPlanner";
import { countStat } from "../utils/stats";

const CREEP_INTERVAL = 100;
const ROOM_INTERVAL = 1000;

/**
 * Last cleanups (heap: right after a global reset both run once). Not `Game.time % interval`: the
 * module is bucket-throttled, and a skipped multiple meant no cleanup for another interval. With
 * the throttle skipping most multiples of 100, dead creeps piled up (~500 entries, 40-55k chars of
 * Memory.creeps at 20000 ticks).
 */
let lastCreepCleanup = 0;
let lastRoomCleanup = 0;

function usedRooms(): Set<string> {
    const used = new Set<string>();
    for (const name in Game.rooms) if (Game.rooms[name].controller?.my) used.add(name);
    for (const source of Object.values(Memory.remoteMining?.sources ?? {})) used.add(source.room);
    const expansion = Memory.expand?.current?.roomName;
    if (expansion) used.add(expansion);
    for (const squad of Object.values(Memory.expand?.squads ?? {})) used.add(squad.targetRoom);
    if (Memory.military?.attack) used.add(Memory.military.attack);
    for (const duo of Object.values(Memory.military?.duos ?? {})) used.add(duo.targetRoom);
    return used;
}

export const memoryCleanupModule = (): void => {
    if (Game.time - lastCreepCleanup >= CREEP_INTERVAL) {
        lastCreepCleanup = Game.time;
        for (const name in Memory.creeps) {
            if (Game.creeps[name]) continue;
            delete Memory.creeps[name];
            countStat("memory:deadCreep");
        }
    }
    if (Game.time - lastRoomCleanup >= ROOM_INTERVAL && Memory.rooms) {
        lastRoomCleanup = Game.time;
        const used = usedRooms();
        for (const name in Memory.rooms) {
            if (used.has(name)) continue;
            // A hostile still expected alive keeps the room unsafe for paths through it
            if ((Memory.rooms[name].enemies?.expires ?? 0) > Game.time) continue;
            delete Memory.rooms[name];
            countStat("memory:deadRoom");
        }
        // Plans (segment) of rooms we no longer own
        for (const name of roomPlanner.plannedRooms()) if (!used.has(name)) roomPlanner.forget(name);
    }
};
