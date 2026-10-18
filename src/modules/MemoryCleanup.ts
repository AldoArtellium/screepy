/**
 * MemoryCleanup - drops the memory of dead creeps (every 100 ticks) and of rooms nothing uses any
 * more (every 1000 ticks): not owned, not mined as a remote, not targeted by expansion or military,
 * no hostile still expected alive.
 */

import { countStat } from "../utils/stats";

const CREEP_INTERVAL = 100;
const ROOM_INTERVAL = 1000;

function usedRooms(): Set<string> {
    const used = new Set<string>();
    for (const name in Game.rooms) if (Game.rooms[name].controller?.my) used.add(name);
    for (const source of Object.values(Memory.remoteMining?.sources ?? {})) used.add(source.room);
    const expansion = Memory.expand?.current?.roomName;
    if (expansion) used.add(expansion);
    for (const squad of Object.values(Memory.expand?.squads ?? {})) used.add(squad.targetRoom);
    if (Memory.military?.attack) used.add(Memory.military.attack);
    if (Memory.military?.target) used.add(Memory.military.target.room);
    for (const duo of Object.values(Memory.military?.duos ?? {})) used.add(duo.targetRoom);
    for (const quad of Object.values(Memory.military?.quads ?? {})) used.add(quad.targetRoom);
    return used;
}

export const memoryCleanupModule = (): void => {
    if (Game.time % CREEP_INTERVAL === 0) {
        for (const name in Memory.creeps) {
            if (Game.creeps[name]) continue;
            delete Memory.creeps[name];
            countStat("memory:deadCreep");
        }
    }
    if (Game.time % ROOM_INTERVAL === 0 && Memory.rooms) {
        const used = usedRooms();
        for (const name in Memory.rooms) {
            if (used.has(name)) continue;
            // A hostile still expected alive keeps the room unsafe for paths through it
            if ((Memory.rooms[name].enemies?.expires ?? 0) > Game.time) continue;
            delete Memory.rooms[name];
            countStat("memory:deadRoom");
        }
    }
};
