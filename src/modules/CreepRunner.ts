/**
 * CreepRunner - runs every creep through the handler of its role (roles/registry.ts).
 * Room-bound economy roles are first brought back into their room and off the room edge
 * (Hivemind containSingleRoomCreep, MIT, src/role/role.ts).
 */

import "../roles/brawler";
import "../roles/builder";
import "../roles/claimer";
import "../roles/dismantler";
import "../roles/guardian";
import "../roles/harvester";
import "../roles/helper";
import "../roles/mineralHarvester";
import "../roles/pioneer";
import "../roles/remoteBuilder";
import "../roles/remoteDefender";
import "../roles/remoteHarvester";
import "../roles/remoteHauler";
import "../roles/reserver";
import "../roles/transporter";
import "../roles/upgrader";
import { needsBoosting, overrideForBoosting } from "../labs/boosts";
import { getRoleHandler } from "../roles/registry";
import { log } from "../utils/logger";
import { countStat } from "../utils/stats";
import { throttle, throttleOffset } from "../utils/throttle";
import { trafficManager } from "./TrafficManager";

/**
 * Bucket thresholds per role (Hivemind role stopAt / throttleAt): a creep's logic is skipped on more
 * and more ticks below `throttleAt` bucket, on every tick below `stopAt`. Default 2000 / 8000.
 */
const THROTTLE: { [role: string]: [stopAt: number, throttleAt: number] } = {
    harvester: [0, 2000],
    upgrader: [0, 2000],
    transporter: [0, 5000],
    remoteHarvester: [2000, 5000],
    brawler: [0, 0],
    guardian: [0, 0],
    remoteDefender: [0, 0],
    reserver: [0, 0],
    claimer: [0, 0],
    pioneer: [0, 0]
};

/** Heap only: throttle offset per creep, spreads the skipped ticks */
const offsets: Map<string, number> = new Map();

/** Skip this creep's logic this tick? (Hivemind creep-manager throttleCreep) */
function isThrottled(creep: Creep, role: string): boolean {
    // Creeps on an exit tile would bounce back to the previous room
    const { x, y } = creep.pos;
    if (x === 0 || x === 49 || y === 0 || y === 49) return false;
    if (Game.cpu.getUsed() > Game.cpu.tickLimit * 0.85) return true;
    let offset = offsets.get(creep.name);
    if (offset === undefined) {
        offset = throttleOffset();
        offsets.set(creep.name, offset);
    }
    const [stopAt, throttleAt] = THROTTLE[role] ?? [2000, 8000];
    return throttle(offset, stopAt, throttleAt);
}

const ROOM_BOUND_ROLES = new Set(["harvester", "mineralHarvester", "transporter", "builder", "upgrader", "brawler", "guardian", "helper"]);
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
    if (Game.time % 1000 === 0) for (const name of offsets.keys()) if (!Game.creeps[name]) offsets.delete(name);
    for (const name in Game.creeps) {
        const creep = Game.creeps[name];
        if (creep.spawning) continue;
        const role = creep.memory.role;
        const handler = role ? getRoleHandler(role) : undefined;
        if (!role || !handler) {
            countStat("creep:noRole");
            continue;
        }
        if (isThrottled(creep, role)) {
            countStat(`throttled:${role}`);
            continue;
        }
        if (ROOM_BOUND_ROLES.has(role) && containInRoom(creep)) continue;
        // Boosts first (Hivemind Role.preRun -> boostManager.overrideCreepLogic)
        if (needsBoosting(creep) && overrideForBoosting(creep)) continue;
        const start = Game.cpu.getUsed();
        try {
            handler(creep);
        } catch (error) {
            log.error("CreepRunner", `Role ${role} failed for ${creep.name}:`, (error as Error).stack);
            countStat(`roleError:${role}`);
        }
        // CPU per role, the role's intents included but its moves (TrafficManager), and creep-ticks to average it
        countStat(`cpu:${role}`, Game.cpu.getUsed() - start);
        countStat(`creepTicks:${role}`);
    }
};
