/**
 * Offense: `Memory.military.attack = "<room>"` (by hand), else an automatic target (targets.ts:
 * strongholds near our rooms; player rooms unless `Memory.military.auto = false`), sends a duo or
 * a quad (sizing.ts, `Memory.military.squad` to force one) from the closest RCL 4+ room with a spawn.
 * The mission ends when the room has no spawn, no tower and no invader core left, or after the
 * squad lost 10 creeps. Our design; see docs/superpowers/roadmap.md (J7).
 */

import { duoCreeps, effectiveEnergy, quadCreeps } from "../core/roomState";
import { boostsFor, cancelBoost } from "../labs/boosts";
import { performRecycle } from "../roles/recycle";
import { registerRole } from "../roles/registry";
import type { SpawnOption, SpawnRole } from "../spawning/spawnRoles";
import { log } from "../utils/logger";
import { DUO_ATTACKER, DUO_HEALER, DuoMemory, runDuo } from "./duo";
import { hostileRoom, militaryMemory, updateMilitaryIntel } from "./intel";
import { lootRamparts, startLooting, startRaids, updateLootMissions } from "./loot";
import { QUAD_ATTACKER, QUAD_HEALER, QUAD_ROSTER, runQuad } from "./quad";
import { duoAttackerBody, duoHealerBody, planSquad, quadAttackerBody, quadHealerBody } from "./sizing";
import { chooseAutoTarget } from "./targets";

export { militaryMemory } from "./intel";

/** Draining towers costs creeps: give up after this many */
const MAX_LOSSES = 10;
const MIN_ENERGY = 2000;
const MAX_ROUTE_ROOMS = 10;
const AUTO_TARGET_EVERY = 100;
/**
 * Ticks a squad creep waits for its boosts once out of the spawn (labs/boosts.ts BOOST_TIMEOUT: 150).
 * The quad gathers its four members anyway (~3 ticks per part each), and at RCL 6 the three labs
 * (two of them lent by the reactions) are filled by one helper, compound after compound.
 */
const SQUAD_BOOST_TIMEOUT = 500;

/**
 * Towers that refill: a stronghold's (the core) and a player's (haulers from the storage; shard0
 * W28N8 kept a dedicated tower feeder): judged at close range, they are never drained for good
 */
export function towersRefill(roomName: string): boolean {
    const intel = hostileRoom(roomName);
    return (intel?.coreLevel ?? 0) > 0 || !!intel?.owner;
}

/**
 * RCL 4+ room with a spawn whose squad can fight the target (sizing.ts feasible: its boosts in stock
 * count), closest first, else the closest one; and the room the squad heals up in before the target.
 * shard0 W28N8: W28N7 (RCL 5, no labs) is next to it, W29N7 (RCL 6, labs, XLHO2 and GHO2) one more room.
 */
function findOrigin(target: string): { spawnRoom: string; stagingRoom: string } | null {
    let best: { spawnRoom: string; stagingRoom: string; length: number; feasible: boolean } | null = null;
    const minRcl = militaryMemory().minRcl ?? 4;
    const refills = towersRefill(target);
    for (const room of _.filter(Game.rooms, r => !!r.controller?.my && r.controller.level >= minRcl)) {
        if (room.find(FIND_MY_SPAWNS).length === 0) continue;
        const route = Game.map.findRoute(room.name, target);
        if (route === ERR_NO_PATH || route.length === 0 || route.length > MAX_ROUTE_ROOMS) continue;
        const stagingRoom = route.length >= 2 ? route[route.length - 2].room : room.name;
        const energy = room.energyCapacityAvailable;
        const feasible = planSquad(target, energy, militaryMemory().squad, refills, room).feasible;
        if (!best || (feasible && !best.feasible) || (feasible === best.feasible && route.length < best.length))
            best = { spawnRoom: room.name, stagingRoom, length: route.length, feasible };
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
    result: "success" | "abandoned" | "retargeted"
): void {
    if (result === "success") startLooting(mission.targetRoom, mission.spawnRoom);
    // The members go to be recycled: boosting them first (CreepRunner boosts before the role) wastes the compound
    for (const creep of kind === "duo" ? duoCreeps(name) : quadCreeps(name)) cancelBoost(creep.name);
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
    const refills = towersRefill(duo.targetRoom);
    return (
        planSquad(duo.targetRoom, Game.rooms[duo.spawnRoom].energyCapacityAvailable, undefined, refills, Game.rooms[duo.spawnRoom])
            .type === "quad"
    );
}

function hasMission(target: string): boolean {
    const memory = militaryMemory();
    return !!memory.duos[`duo.${target}`] || !!memory.quads?.[`quad.${target}`];
}

/** The mission against the target has creeps (spawning ones included): retargeting would recycle them */
function isEngaged(target: string): boolean {
    return duoCreeps(`duo.${target}`).length > 0 || quadCreeps(`quad.${target}`).length > 0;
}

/** Losses or the target changed (not a failure: the room is not left alone for it, targets.ts recentlyFailed) */
function endReason(mission: { targetRoom: string; losses: number }): "abandoned" | "retargeted" | null {
    if (mission.losses >= MAX_LOSSES) return "abandoned";
    return mission.targetRoom !== currentTarget() ? "retargeted" : null;
}

function startMission(target: string): void {
    const memory = militaryMemory();
    const origin = findOrigin(target);
    if (!origin) return;
    const refills = towersRefill(target);
    const spawnRoom = Game.rooms[origin.spawnRoom];
    const plan = planSquad(target, spawnRoom.energyCapacityAvailable, memory.squad, refills, spawnRoom);
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
    startRaids();
    const memory = militaryMemory();
    if (!memory.attack && Game.time % AUTO_TARGET_EVERY === 0) {
        const auto = chooseAutoTarget(!!memory.target && isEngaged(memory.target.room));
        if (auto && auto.room !== memory.target?.room) {
            memory.target = { room: auto.room, reason: auto.reason, since: Game.time, roi: Math.round(auto.roi * 100) / 100 };
            log.info("Military", `Automatic target: ${auto.room} (${auto.reason}, value ${auto.value} for a squad of ${auto.cost} energy, CPU priced ${auto.cpu})`);
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
        const duoEnd = isNeutralized(duo.targetRoom) ? "success" : endReason(duo);
        if (duoEnd) finish("duo", name, duo, duoEnd);
        else runDuo(name, duo);
    }
    for (const name in memory.quads ?? {}) {
        const quad = memory.quads![name];
        const quadEnd = isNeutralized(quad.targetRoom) ? "success" : endReason(quad);
        if (quadEnd) finish("quad", name, quad, quadEnd);
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
    boostTimeout: SQUAD_BOOST_TIMEOUT,

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
     * The squad waits at most SQUAD_BOOST_TIMEOUT ticks for them.
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
