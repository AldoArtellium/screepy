/**
 * Labs module: boost labs (Hivemind init.ts manageBoostLabs) then reactions (Hivemind
 * process/rooms/owned/labs.ts) in every owned room with labs. Hivemind (MIT).
 */

import { log } from "../utils/logger";
import { manageBoostLabs, operationalLabs } from "./boosts";
import { manageReactions } from "./reactions";

export const labsModule = (): void => {
    for (const name in Game.rooms) {
        const room = Game.rooms[name];
        if (!room.controller?.my || (room.controller.level ?? 0) < 6) continue;
        if (operationalLabs(room).length === 0) continue;
        try {
            manageBoostLabs(room);
            manageReactions(room);
        } catch (error) {
            log.error("Labs", `${room.name}:`, (error as Error).stack);
        }
    }
};
