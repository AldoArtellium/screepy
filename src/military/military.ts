/**
 * Offense: `Memory.military.attack = "<room>"` (by hand), else an automatic target (targets.ts:
 * strongholds near our rooms; player rooms only with `Memory.military.auto = true`), sends a duo or
 * a quad (sizing.ts, `Memory.military.squad` to force one) from the closest RCL 4+ room with a spawn.
 * The mission ends when the room has no spawn, no tower and no invader core left, or after the
 * squad lost 10 creeps. Our design; see docs/superpowers/roadmap.md (J7).
 */

import { duoCreeps, effectiveEnergy, quadCreeps } from "../core/roomState";
import { boostsFor } from "../labs/boosts";
import { performRecycle } from "../roles/recycle";
import { registerRole } from "../roles/registry";
import type { SpawnOption, SpawnRole } from "../spawning/spawnRoles";
import { log } from "../utils/logger";
import { DUO_ATTACKER, DUO_HEALER, DuoMemory, runDuo } from "./duo";
import { hostileRoom, militaryMemory, updateMilitaryIntel } from "./intel";
import { lootRamparts, startLooting, updateLootMissions } from "./loot";
import { QUAD_ATTACKER, QUAD_HEALER, QUAD_ROSTER, runQuad } from "./quad";
import { duoAttackerBody, duoHealerBody, planSquad, quadAttackerBody, quadHealerBody } from "./sizing";
import { chooseAutoTarget } from "./targets";

export { militaryMemory } from "./intel";

/** Draining towers costs creeps: give up after this many */
const MAX_LOSSES = 10;
const MIN_ENERGY = 2000;
const MAX_ROUTE_ROOMS = 10;
const AUTO_TARGET_EVERY = 100;

/** Closest RCL 4+ room with a spawn, and the room the squad heals up in before the target */
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

/** Room under attack: set by hand, else the automatic target */
export function currentTarget(): string | undefined {
    const memory = militaryMemory();
    return memory.attack ?? memory.target?.room;
}

function finish(
    kind: "duo" | "quad",
    name: string,
    mission: { targetRoom: string; spawnRoom: string; losses: number },
    result: "success" | "abandoned"
): void {
    if (result === "success") startLooting(mission.targetRoom, mission.spawnRoom);
    const memory = militaryMemory();
    memory.log = [
        ...(memory.log ?? []).slice(-9),
        { room: mission.targetRoom, result, time: Game.time, losses: mission.losses, squad: kind }
    ];
    if (kind === "duo") delete memory.duos[name];
    else delete memory.quads?.[name];
    if (memory.attack === mission.targetRoom) delete memory.attack;
    if (memory.target?.room === mission.targetRoom) delete memory.target;
    log.info("Military", `Attack on ${mission.targetRoom} (${kind}): ${result} (${mission.losses} creeps lost)`);
}

/** Visible room without spawn, tower or invader core left, nor a hostile rampart over loot (loot.ts) */
function isNeutralized(roomName: string): boolean {
    const room = Game.rooms[roomName];
    if (!room) return false;
    const left = room.find(FIND_HOSTILE_STRUCTURES, {
        filter: s =>
            s.structureType === STRUCTURE_SPAWN ||
            s.structureType === STRUCTURE_TOWER ||
            s.structureType === STRUCTURE_INVADER_CORE
    });
    return left.length === 0 && lootRamparts(room).length === 0;
}

/** A duo that lost a pair against a room now sized for a quad (unless the squad type is forced) */
function shouldUpgrade(duo: DuoMemory): boolean {
    const memory = militaryMemory();
    if (memory.squad || duo.losses < 2 || duo.losses >= MAX_LOSSES || !Game.rooms[duo.spawnRoom]) return false;
    const refills = (hostileRoom(duo.targetRoom)?.coreLevel ?? 0) > 0;
    return (
        planSquad(duo.targetRoom, Game.rooms[duo.spawnRoom].energyCapacityAvailable, undefined, refills).type === "quad"
    );
}

function hasMission(target: string): boolean {
    const memory = militaryMemory();
    return !!memory.duos[`duo.${target}`] || !!memory.quads?.[`quad.${target}`];
}

function startMission(target: string): void {
    const memory = militaryMemory();
    const origin = findOrigin(target);
    if (!origin) return;
    const refills = (hostileRoom(target)?.coreLevel ?? 0) > 0;
    const plan = planSquad(target, Game.rooms[origin.spawnRoom].energyCapacityAvailable, memory.squad, refills);
    if (!plan.feasible && !memory.attack) {
        delete memory.target;
        return;
    }
    const base = { ...origin, targetRoom: target, members: [], losses: 0 };
    if (plan.type === "duo") memory.duos[`duo.${target}`] = { ...base, state: "forming" };
    else memory.quads = { ...memory.quads, [`quad.${target}`]: { ...base, state: "forming" } };
    log.info(
        "Military",
        `${plan.type} from ${origin.spawnRoom} to attack ${target} (staging in ${origin.stagingRoom}): edge damage ${plan.threat.edge},`,
        `duo heal ${plan.duoHeal}, quad heal ${plan.quadHeal}${plan.feasible ? "" : " (not enough healing: drain only)"}`
    );
}

export const militaryModule = (): void => {
    updateMilitaryIntel();
    updateLootMissions();
    const memory = militaryMemory();
    if (!memory.attack && Game.time % AUTO_TARGET_EVERY === 0) {
        const auto = chooseAutoTarget();
        if (auto && auto.room !== memory.target?.room) {
            memory.target = { room: auto.room, reason: auto.reason, since: Game.time, roi: Math.round(auto.roi * 100) / 100 };
            log.info("Military", `Automatic target: ${auto.room} (${auto.reason}, value ${auto.value} for a squad of ${auto.cost} energy)`);
        } else if (!auto && memory.target && !hasMission(memory.target.room)) delete memory.target;
    }
    const target = currentTarget();
    if (target && !hasMission(target)) startMission(target);

    for (const name in memory.duos) {
        const duo = memory.duos[name];
        if (shouldUpgrade(duo)) {
            // The duo was sized on stale intel: the threat seen in the fight calls for a quad
            delete memory.duos[name];
            memory.quads = { ...memory.quads, [`quad.${duo.targetRoom}`]: { ...duo, members: [], state: "forming" } };
            log.info("Military", `${name} lost ${duo.losses} creeps: a quad takes over`);
            continue;
        }
        if (isNeutralized(duo.targetRoom)) finish("duo", name, duo, "success");
        else if (duo.losses >= MAX_LOSSES || duo.targetRoom !== currentTarget()) finish("duo", name, duo, "abandoned");
        else runDuo(name, duo);
    }
    for (const name in memory.quads ?? {}) {
        const quad = memory.quads![name];
        if (isNeutralized(quad.targetRoom)) finish("quad", name, quad, "success");
        else if (quad.losses >= MAX_LOSSES || quad.targetRoom !== currentTarget())
            finish("quad", name, quad, "abandoned");
        else runQuad(name, quad);
    }
};

function duoMissing(roomName: string): { name: string; role: string } | null {
    for (const [name, duo] of Object.entries(militaryMemory().duos)) {
        if (duo.spawnRoom !== roomName) continue;
        for (const role of [DUO_HEALER, DUO_ATTACKER]) {
            if (!duoCreeps(name).some(c => c.memory.role === role)) return { name, role };
        }
    }
    return null;
}

/** Quads are refilled only while forming at home */
function quadMissing(roomName: string): { name: string; role: string } | null {
    for (const [name, quad] of Object.entries(militaryMemory().quads ?? {})) {
        if (quad.spawnRoom !== roomName || quad.state !== "forming") continue;
        const have = _.countBy(quadCreeps(name), c => c.memory.role);
        const wanted = _.countBy(QUAD_ROSTER);
        for (const role of QUAD_ROSTER) if ((have[role] ?? 0) < wanted[role]) return { name, role };
    }
    return null;
}

/** Spawn role of the duos and quads (healers first: the others wait next to them) */
export const militarySpawnRole: SpawnRole = {
    id: "military",
    emptyTimeout: 10,

    options(room) {
        if (effectiveEnergy(room) < MIN_ENERGY) return [];
        const duo = duoMissing(room.name);
        if (duo) return [{ role: duo.role, priority: 3, weight: 1, memory: { duo: duo.name } } as SpawnOption];
        const quad = quadMissing(room.name);
        if (quad) return [{ role: quad.role, priority: 3, weight: 1, memory: { quad: quad.name } } as SpawnOption];
        return [];
    },

    body(room, option) {
        const energy = room.energyCapacityAvailable;
        if (option.role === DUO_HEALER) return duoHealerBody(energy);
        if (option.role === QUAD_HEALER) return quadHealerBody(energy);
        if (option.role === QUAD_ATTACKER) return quadAttackerBody(energy);
        return duoAttackerBody(energy);
    },

    memory(room, option) {
        return { role: option.role, room: room.name, duo: option.memory?.duo, quad: option.memory?.quad };
    },

    /**
     * Best available boosts of the combat parts (Hivemind squad getCreepBoosts: attack, heal, and the
     * blinky's ranged attack and TOUGH). MOVE stays unboosted: bodies are sized for plain MOVE parts.
     * The squad waits at most BOOST_TIMEOUT ticks for them (labs/boosts.ts).
     */
    boosts(room, _option, body) {
        return boostsFor(room, body, [
            [TOUGH, "damage"],
            [ATTACK, "attack"],
            [HEAL, "heal"],
            [RANGED_ATTACK, "rangedAttack"]
        ]);
    }
};

/** Squad creeps are run by the military module; without a mission they go back to be recycled */
for (const role of [DUO_ATTACKER, DUO_HEALER]) {
    registerRole(role, creep => {
        if (!creep.memory.duo || !militaryMemory().duos[creep.memory.duo]) performRecycle(creep);
    });
}
for (const role of [QUAD_ATTACKER, QUAD_HEALER]) {
    registerRole(role, creep => {
        if (!creep.memory.quad || !militaryMemory().quads?.[creep.memory.quad]) performRecycle(creep);
    });
}
