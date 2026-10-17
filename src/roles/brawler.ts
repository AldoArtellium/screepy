/**
 * Brawler: melee defender of a low-level room (towers handle defense from RCL 4).
 * Simplified from Hivemind (MIT), src/role/brawler.ts: attack the closest dangerous hostile, else park.
 */

import { whenInRange } from "../core/movement";
import { performRecycle } from "./recycle";
import { registerRole } from "./registry";

export function runBrawler(creep: Creep): void {
    const home = Game.rooms[creep.memory.room ?? creep.room.name];
    if (!home) return;
    const hostiles = home.find(FIND_HOSTILE_CREEPS, {
        filter: c => c.body.some(p => p.type !== MOVE && p.type !== TOUGH)
    });
    const target = creep.pos.findClosestByRange(hostiles);
    if (!target) {
        if (home.memory.enemies?.safe !== false) performRecycle(creep);
        return;
    }
    whenInRange(creep, 1, target, () => creep.attack(target));
}

registerRole("brawler", runBrawler);
