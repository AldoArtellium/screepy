/**
 * Offense, first step: `Memory.military.attack = "<room>"` sends a duo from the closest RCL 4+
 * room with a spawn; the mission ends when the room has no spawn and no tower left, or after the
 * duo lost 10 creeps. Automatic target selection comes later (Harabi's ROI: threat / elimination cost).
 * Our design; see docs/superpowers/roadmap.md (J7).
 */

import { buildBody, MoveMode } from "../core/bodyBuilder";
import { effectiveEnergy } from "../core/roomState";
import { performRecycle } from "../roles/recycle";
import { registerRole } from "../roles/registry";
import type { SpawnOption, SpawnRole } from "../spawning/spawnRoles";
import { log } from "../utils/logger";
import { DUO_ATTACKER, DUO_HEALER, DuoMemory, runDuo } from "./duo";

declare global {
    interface Memory {
        military?: {
            /** Room to attack (set by hand for now) */
            attack?: string;
            duos: { [name: string]: DuoMemory };
            /** Lowest RCL of the attacking room (default 4; lower it to test sooner) */
            minRcl?: number;
            /** Finished missions */
            log?: { room: string; result: "success" | "abandoned"; time: number; losses: number }[];
        };
    }
}

/** Draining towers costs creeps: give up after this many */
const MAX_LOSSES = 10;
const MIN_ENERGY = 2000;
const MAX_ROUTE_ROOMS = 10;

export function militaryMemory(): NonNullable<Memory["military"]> {
    if (!Memory.military) Memory.military = { duos: {} };
    return Memory.military;
}

/** Closest RCL 4+ room with a spawn, and the room the duo heals up in before the target */
function findOrigin(target: string): { spawnRoom: string; stagingRoom: string } | null {
    let best: { spawnRoom: string; stagingRoom: string; length: number } | null = null;
    const minRcl = militaryMemory().minRcl ?? 4;
    for (const room of _.filter(Game.rooms, r => !!r.controller?.my && r.controller.level >= minRcl)) {
        if (room.find(FIND_MY_SPAWNS).length === 0) continue;
        const route = Game.map.findRoute(room.name, target);
        if (route === ERR_NO_PATH || route.length === 0 || route.length > MAX_ROUTE_ROOMS) continue;
        const stagingRoom = route.length >= 2 ? route[route.length - 2].room : room.name;
        if (!best || route.length < best.length) best = { spawnRoom: room.name, stagingRoom, length: route.length };
    }
    return best;
}

function finish(name: string, duo: DuoMemory, result: "success" | "abandoned"): void {
    const memory = militaryMemory();
    memory.log = [...(memory.log ?? []).slice(-9), { room: duo.targetRoom, result, time: Game.time, losses: duo.losses }];
    delete memory.duos[name];
    if (memory.attack === duo.targetRoom) delete memory.attack;
    log.info("Military", `Attack on ${duo.targetRoom}: ${result} (${duo.losses} creeps lost)`);
}

function isNeutralized(roomName: string): boolean {
    const room = Game.rooms[roomName];
    if (!room) return false;
    return room.find(FIND_HOSTILE_STRUCTURES, { filter: s => s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_TOWER }).length === 0;
}

export const militaryModule = (): void => {
    const memory = militaryMemory();
    const target = memory.attack;
    if (target && !memory.duos[`duo.${target}`]) {
        const origin = findOrigin(target);
        if (origin) {
            memory.duos[`duo.${target}`] = { ...origin, targetRoom: target, state: "forming", members: [], losses: 0 };
            log.info("Military", `Duo from ${origin.spawnRoom} to attack ${target} (staging in ${origin.stagingRoom})`);
        }
    }
    for (const name in memory.duos) {
        const duo = memory.duos[name];
        if (isNeutralized(duo.targetRoom)) {
            finish(name, duo, "success");
            continue;
        }
        if (duo.losses >= MAX_LOSSES || duo.targetRoom !== memory.attack) {
            finish(name, duo, "abandoned");
            continue;
        }
        runDuo(name, duo);
    }
};

function duoMissing(roomName: string): { name: string; role: string } | null {
    for (const [name, duo] of Object.entries(militaryMemory().duos)) {
        if (duo.spawnRoom !== roomName) continue;
        for (const role of [DUO_HEALER, DUO_ATTACKER]) {
            if (!_.some(Game.creeps, c => c.memory.duo === name && c.memory.role === role)) return { name, role };
        }
    }
    return null;
}

/** Spawn role of the duos (the healer first: the attacker waits next to it) */
export const militarySpawnRole: SpawnRole = {
    id: "military",
    emptyTimeout: 10,

    options(room) {
        if (effectiveEnergy(room) < MIN_ENERGY) return [];
        const missing = duoMissing(room.name);
        if (!missing) return [];
        return [{ role: missing.role, priority: 3, weight: 1, memory: { duo: missing.name } } as SpawnOption];
    },

    body(room, option) {
        const energyLimit = room.energyCapacityAvailable;
        if (option.role === DUO_HEALER) return buildBody({ weights: { [HEAL]: 1 }, moveMode: MoveMode.PLAINS, energyLimit });
        // ATTACK only (Hivemind's attacker body): with a TOUGH weight our body builder made no ATTACK part
        return buildBody({ weights: { [ATTACK]: 1 }, moveMode: MoveMode.PLAINS, energyLimit });
    },

    memory(room, option) {
        return { role: option.role, room: room.name, duo: option.memory?.duo };
    }
};

/** Duo creeps are run by the military module; without a duo they go back to be recycled */
for (const role of [DUO_ATTACKER, DUO_HEALER]) {
    registerRole(role, creep => {
        if (!creep.memory.duo || !militaryMemory().duos[creep.memory.duo]) performRecycle(creep);
    });
}
