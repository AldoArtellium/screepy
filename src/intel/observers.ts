/**
 * Our observers (STRUCTURE_OBSERVER, RCL 8), read by ObserverManager (which observes) and ScoutManager (rooms in
 * their range get no scout, intel/observerPlan.ts coveredByObserver). Listed again every REFRESH ticks (heap): a
 * room.find per tick was most of the module's CPU (mockup W7N3 plan8, 0.08 CPU per tick with nothing to observe).
 * Callers read the structure by id and skip a missing one.
 */

import { ObserverSite } from "./observerPlan";

/** An observer built or lost shows within this many ticks */
const REFRESH = 100;

let cache: ObserverSite[] = [];
let listed = -Infinity;

export function ownObservers(): ObserverSite[] {
    // Elapsed ticks: heap timestamps survive throttled ticks, a global reset lists again
    if (Game.time - listed < REFRESH) return cache;
    listed = Game.time;
    cache = [];
    for (const name in Game.rooms) {
        const room = Game.rooms[name];
        if (!room.controller?.my || room.controller.level < 8) continue;
        const observer = room.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_OBSERVER })[0];
        if (observer) cache.push({ id: observer.id, room: name });
    }
    return cache;
}
