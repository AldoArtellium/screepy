/**
 * Our observers (STRUCTURE_OBSERVER, RCL 8), listed once per tick (heap). Read by ObserverManager (which
 * observes) and ScoutManager (rooms in their range get no scout, intel/observerPlan.ts coveredByObserver).
 */

import { ObserverSite } from "./observerPlan";

let cache: ObserverSite[] = [];
let cacheTick = -1;

export function ownObservers(): ObserverSite[] {
    if (cacheTick === Game.time) return cache;
    cacheTick = Game.time;
    cache = [];
    for (const name in Game.rooms) {
        const room = Game.rooms[name];
        if (!room.controller?.my || room.controller.level < 8) continue;
        const observer = room.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_OBSERVER })[0];
        if (observer) cache.push({ id: observer.id, room: name });
    }
    return cache;
}
