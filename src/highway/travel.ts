/**
 * Highway creeps (deposit and power harvesters, power haulers): travel along the squad route
 * (military/route.ts: no other player's room, no keeper room) and delivery to the home storage or terminal.
 */

import { whenInRange } from "../core/movement";
import { bestStorageTarget } from "../core/resources";
import { squadRoute } from "../military/route";
import { trafficManager } from "../modules/TrafficManager";
import { countStat } from "../utils/stats";

/** Walk towards a room along the squad route, one room at a time; false once inside it */
export function travelTo(creep: Creep, room: string): boolean {
    if (creep.room.name === room) return false;
    const route = squadRoute(creep.room.name, room);
    trafficManager.moveToRoom(creep, route?.[1] ?? room, { priority: 40 });
    return true;
}

/** Carry the creep's resources home, one type per tick, counted in `counter` */
export function deliverHome(creep: Creep, home: string, counter: string): void {
    if (travelTo(creep, home)) return;
    const resources = Object.keys(creep.store) as ResourceConstant[];
    const resource = resources.find(r => creep.store[r] > 0);
    if (!resource) return;
    const amount = creep.store[resource];
    const target = bestStorageTarget(creep.room, amount, resource);
    if (!target) {
        creep.drop(resource);
        return;
    }
    whenInRange(creep, 1, target, () => {
        if (creep.transfer(target, resource) === OK) countStat(counter, amount);
    });
}
