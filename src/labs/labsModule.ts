/**
 * Labs module: boost labs (Hivemind init.ts manageBoostLabs) then reactions (Hivemind
 * process/rooms/owned/labs.ts) in every owned room with labs. Hivemind (MIT).
 *
 * Not in Hivemind: a room whose labs can't act (reactors on cooldown, source labs waiting for their
 * reagents, no reaction to make) is skipped until the tick manageReactions gives, unless a boost is
 * pending (Memory.boost: every tick, like before). shard0 2026-11-04: 0.67 CPU per tick for 5 rooms
 * with labs, run every tick.
 */

import { log } from "../utils/logger";
import { cleanBoostMemory, manageBoostLabs, operationalLabs } from "./boosts";
import { IDLE_WAIT, manageReactions } from "./reactions";

/** Heap: first tick each room has lab work again */
const nextRun: Map<string, number> = new Map();

/** A boost request or a boost lab anywhere (boost labs are managed every tick while one is pending) */
function boostPending(): boolean {
    const memory = Memory.boost;
    if (!memory) return false;
    for (const _name in memory.creeps) return true;
    for (const _id in memory.labs) return true;
    return false;
}

export const labsModule = (): void => {
    cleanBoostMemory();
    const boosting = boostPending();
    for (const name in Game.rooms) {
        const room = Game.rooms[name];
        if (!room.controller?.my || (room.controller.level ?? 0) < 6) continue;
        if (!boosting && Game.time < (nextRun.get(name) ?? 0)) continue;
        if (operationalLabs(room).length === 0) {
            nextRun.set(name, Game.time + IDLE_WAIT);
            continue;
        }
        try {
            manageBoostLabs(room);
            nextRun.set(name, Game.time + manageReactions(room));
        } catch (error) {
            log.error("Labs", `${room.name}:`, (error as Error).stack);
        }
    }
};
