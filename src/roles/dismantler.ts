/**
 * Dismantler: opens the remote paths of its home room, blocked tile by blocked tile from the home
 * side (remote/dismantle.ts), then recycles.
 * Ported from Hivemind (MIT), src/role/dismantler.ts performOperationDismantle; The International
 * remoteDismantler.
 */

import { whenInRange } from "../core/movement";
import { trafficManager } from "../modules/TrafficManager";
import { dismantleTarget, dismantleTargets, DISMANTLER } from "../remote/dismantle";
import { countStat } from "../utils/stats";
import { fleeIfThreatened } from "./flee";
import { performRecycle } from "./recycle";
import { registerRole } from "./registry";

function runDismantler(creep: Creep): void {
    const homeRoom = creep.memory.room ?? creep.room.name;
    if (fleeIfThreatened(creep, new RoomPosition(25, 25, homeRoom))) return;
    for (const pos of dismantleTargets(homeRoom)) {
        if (Game.rooms[pos.roomName] && !dismantleTarget(pos)) continue;
        if (creep.pos.roomName !== pos.roomName || creep.pos.getRangeTo(pos) > 1) {
            trafficManager.requestMove(creep, pos, { range: 1 });
            return;
        }
        const target = dismantleTarget(pos)!;
        whenInRange(creep, 1, pos, () => {
            if (creep.dismantle(target) === OK) countStat("work:dismantle");
        });
        return;
    }
    performRecycle(creep);
}

registerRole(DISMANTLER, runDismantler);
