/**
 * Spawn roles of the expansion: squad units (claimer, pioneers, defender) from their squad's spawn
 * room, and pioneers for owned rooms without spawn (reclaim).
 * Ported from Hivemind (MIT), src/spawn-role/squad.ts and spawn-role/reclaim.ts.
 * See docs/hivemind/hivemind-expansion.md §4.2, §7.
 */

import { buildBody, MoveMode } from "../core/bodyBuilder";
import { effectiveEnergy, squadCreeps } from "../core/roomState";
import { remoteDefenderBody, DefenseResponse } from "../remote/remoteDefense";
import type { SpawnOption, SpawnRole } from "../spawning/spawnRoles";
import { decisionBucket } from "../utils/throttle";
import { roomsNeedingReclaim, SquadUnit, squadsOf } from "./Expansion";

export const CLAIMER = "claimer";
export const PIONEER = "pioneer";

type SquadOption = SpawnOption & { squad: string; unit: SquadUnit; targetRoom: string };

/** Claimer first, then pioneers, then the defender (Hivemind draws the missing unit at random) */
const UNIT_ORDER: SquadUnit[] = ["claimer", "pioneer", "defender"];
const MIN_SQUAD_ENERGY = 5000;
const RECLAIM_ENERGY = 10000;
const RECLAIM_BUCKET = 8000;
const MAX_RECLAIM_PIONEERS = 5;

function energyLimit(room: Room): number {
    return Math.min(room.energyCapacityAvailable, Math.max(room.energyCapacityAvailable * 0.9, room.energyAvailable));
}

/** Units alive (pioneers keep their squad once in the target room) */
function unitCount(squad: string, unit: SquadUnit): number {
    return squadCreeps(squad).filter(c => c.memory.unit === unit).length;
}

function pioneerBody(room: Room): BodyPartConstant[] {
    return buildBody({ weights: { [CARRY]: 3, [WORK]: 2 }, moveMode: MoveMode.PLAINS, energyLimit: energyLimit(room) });
}

export const squadSpawnRole: SpawnRole = {
    id: "squad",
    emptyTimeout: 10,

    options(room) {
        const options: SpawnOption[] = [];
        const energy = effectiveEnergy(room);
        if (energy < MIN_SQUAD_ENERGY) return options;
        for (const [name, squad] of squadsOf(room.name)) {
            const unit = UNIT_ORDER.find(u => (squad.composition[u] ?? 0) > unitCount(name, u));
            if (!unit) continue;
            const option: SquadOption = { role: unit, priority: energy > 10000 ? 4 : 2, weight: 1.1, squad: name, unit, targetRoom: squad.targetRoom };
            options.push(option);
        }
        return options;
    },

    body(room, option) {
        const unit = (option as SquadOption).unit;
        if (unit === "claimer") {
            // A single CLAIM part on swamp moves claims; a bigger claimer breaks hostile reservations
            return buildBody({ weights: { [CLAIM]: 1 }, partLimits: { [CLAIM]: 1 }, moveMode: MoveMode.SWAMP, energyLimit: room.energyCapacityAvailable });
        }
        if (unit === "defender") return remoteDefenderBody(room, { role: "remoteDefender", priority: 0, weight: 0, targetRoom: "", response: DefenseResponse.MINI_BRAWLER });
        return pioneerBody(room);
    },

    memory(room, option) {
        const { squad, unit, targetRoom } = option as SquadOption;
        const role = unit === "claimer" ? CLAIMER : unit === "defender" ? "remoteDefender" : PIONEER;
        return { role, room: room.name, squad, unit, targetRoom, ...(unit === "pioneer" && { filling: true }) };
    }
};

export const reclaimSpawnRole: SpawnRole = {
    id: "reclaim",
    emptyTimeout: 100,

    options(room) {
        if (effectiveEnergy(room) < RECLAIM_ENERGY || decisionBucket() < RECLAIM_BUCKET) return [];
        const options: SpawnOption[] = [];
        for (const target of roomsNeedingReclaim()) {
            if (target === room.name) continue;
            const route = Game.map.findRoute(room.name, target);
            if (route === ERR_NO_PATH || route.length > 14) continue;
            const pioneers = _.filter(Game.creeps, c => c.memory.role === PIONEER && c.memory.targetRoom === target).length;
            if (pioneers >= MAX_RECLAIM_PIONEERS) continue;
            options.push({ role: PIONEER, priority: 3, weight: 1, memory: { targetRoom: target } });
        }
        return options;
    },

    body(room) {
        return pioneerBody(room);
    },

    memory(room, option) {
        return { role: PIONEER, room: room.name, targetRoom: option.memory?.targetRoom, filling: true };
    }
};
