/**
 * CreepRunner - runs every creep through the handler of its role (roles/registry.ts).
 * Room-bound economy roles are first brought back into their room and off the room edge
 * (Hivemind containSingleRoomCreep, MIT, src/role/role.ts).
 */

import "../roles/brawler";
import "../roles/builder";
import "../roles/harvester";
import "../roles/remoteHarvester";
import "../roles/remoteHauler";
import "../roles/reserver";
import "../roles/transporter";
import "../roles/upgrader";
import { getRoleHandler } from "../roles/registry";
import { log } from "../utils/logger";
import { countStat } from "../utils/stats";
import { trafficManager } from "./TrafficManager";

const ROOM_BOUND_ROLES = new Set(["harvester", "transporter", "builder", "upgrader", "brawler"]);
const INWARD: { [edge: string]: DirectionConstant } = { left: RIGHT, right: LEFT, top: BOTTOM, bottom: TOP };

/** True when the creep was moved back into its room this tick */
function containInRoom(creep: Creep): boolean {
    const home = creep.memory.room;
    if (!home) return false;
    if (creep.room.name !== home) {
        trafficManager.moveToRoom(creep, home);
        return true;
    }
    const { x, y } = creep.pos;
    const edge = x === 0 ? "left" : x === 49 ? "right" : y === 0 ? "top" : y === 49 ? "bottom" : null;
    if (!edge) return false;
    creep.move(INWARD[edge]);
    return true;
}

export const creepRunnerModule = () => {
    for (const name in Game.creeps) {
        const creep = Game.creeps[name];
        if (creep.spawning) continue;
        const role = creep.memory.role;
        const handler = role ? getRoleHandler(role) : undefined;
        if (!role || !handler) {
            countStat("creep:noRole");
            continue;
        }
        if (ROOM_BOUND_ROLES.has(role) && containInRoom(creep)) continue;
        try {
            handler(creep);
        } catch (error) {
            log.error("CreepRunner", `Role ${role} failed for ${creep.name}:`, (error as Error).stack);
            countStat(`roleError:${role}`);
        }
    }
};
