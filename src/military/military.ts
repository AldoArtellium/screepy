/**
 * Offense: `Memory.military.attack = "<room>"` (by hand), else an automatic target (targets.ts:
 * strongholds near our rooms; player rooms unless `Memory.military.auto = false`), sends a duo or
 * a quad (sizing.ts, `Memory.military.squad` to force one) from the closest RCL 4+ room with a spawn.
 * The mission ends when the room has no spawn, no tower and no invader core left, or after the
 * squad lost 10 creeps. Our design; see docs/superpowers/roadmap.md (J7).
 */

import { duoCreeps, effectiveEnergy, quadCreeps } from "../core/roomState";
import { boostsFor, boostsWith, cancelBoost } from "../labs/boosts";
import { performRecycle } from "../roles/recycle";
import { registerRole } from "../roles/registry";
import type { SpawnOption, SpawnRole } from "../spawning/spawnRoles";
import { log } from "../utils/logger";
import { countStat } from "../utils/stats";
import { BOOST_MARGIN, BoostedEffect } from "./boostNeed";
import { DUO_ATTACKER, DUO_HEALER, DuoMemory, runDuo } from "./duo";
import { hostileRoom, militaryMemory, updateMilitaryIntel } from "./intel";
import { lootRamparts, startLooting, updateLootMissions } from "./loot";
import { QUAD_ATTACKER, QUAD_HEALER, QUAD_ROSTER, QuadMemory, runQuad } from "./quad";
import { squadRoute } from "./route";
import {
    describeBoosts,
    duoAttackerBody,
    duoHealerBody,
    planSquad,
    quadAttackerBody,
    quadHealerBody,
    SQUAD_BOOST_PARTS,
    squadMemberCosts,
    SquadPlan,
    SquadType
} from "./sizing";
import { AutoTargetEntry } from "./intel";
import { helperRooms } from "./roi";
import { chooseAutoTargets, releaseFallen } from "./targets";
import { militaryCpuAverage, militaryCpuTooHigh } from "./cpuGuard";
import { decisionBucket } from "../utils/throttle";

export { militaryMemory } from "./intel";

/** Draining towers costs creeps: give up after this many */
const MAX_LOSSES = 10;
/** Creeps lost before the boosts of the next members are chosen again with a bigger margin */
const ESCALATION_LOSSES = 2;
/** Margin added per escalation, as a share of BOOST_MARGIN */
const ESCALATION_STEP = 0.25;
const MIN_ENERGY = 2000;
/** Priority of a squad's first member (economy roles at 4 go first) */
const START_PRIORITY = 3;
/**
 * Priority of the other members once one is out: back to back, above transporters and builders.
 * shard0 W29N7 (one spawn, 2026-10-25): the quad's healers waited 200+ ticks of their life for the
 * attackers, the spawn making transporters (priority 4) in between.
 */
const BURST_PRIORITY = 5;
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
function findOrigin(target: string, busy: Set<string>): { spawnRoom: string; stagingRoom: string } | null {
    let best: { spawnRoom: string; stagingRoom: string; length: number; feasible: boolean } | null = null;
    const minRcl = militaryMemory().minRcl ?? 4;
    const refills = towersRefill(target);
    for (const room of _.filter(Game.rooms, r => !!r.controller?.my && r.controller.level >= minRcl)) {
        // A base arms one mission at a time
        if (busy.has(room.name) || room.find(FIND_MY_SPAWNS).length === 0) continue;
        // The squad's own room route (route.ts): the staging room is never another player's room
        const rooms = squadRoute(room.name, target);
        if (!rooms || rooms.length < 2 || rooms.length - 1 > MAX_ROUTE_ROOMS) continue;
        const route = rooms.slice(1);
        const stagingRoom = rooms[rooms.length - 2];
        const energy = room.energyCapacityAvailable;
        const feasible = planSquad(target, energy, militaryMemory().squad, refills, room).feasible;
        if (!best || (feasible && !best.feasible) || (feasible === best.feasible && route.length < best.length))
            best = { spawnRoom: room.name, stagingRoom, length: route.length, feasible };
    }
    return best;
}

/** Rooms under attack: the one set by hand, then the automatic targets */
export function currentTargets(): string[] {
    const memory = militaryMemory();
    const rooms = (memory.targets ?? []).map(t => t.room);
    return memory.attack ? [memory.attack, ...rooms.filter(r => r !== memory.attack)] : rooms;
}

/** Bases arming a mission (spawn rooms and helpers), but the one against `except` */
function busyBases(except?: string): Set<string> {
    const memory = militaryMemory();
    const busy = new Set<string>();
    const missions: (DuoMemory | QuadMemory)[] = [...Object.values(memory.duos), ...Object.values(memory.quads ?? {})];
    for (const mission of missions) {
        if (mission.targetRoom === except) continue;
        busy.add(mission.spawnRoom);
        for (const helper of mission.helpers ?? []) busy.add(helper);
    }
    return busy;
}

/** Free bases close to the spawn room that build the same bodies spawn members too (roi.ts helperRooms) */
function findHelpers(spawnRoom: string, busy: Set<string>): string[] {
    const home = Game.rooms[spawnRoom];
    if (!home) return [];
    const minRcl = militaryMemory().minRcl ?? 4;
    const bases = _.filter(
        Game.rooms,
        r => !!r.controller?.my && r.controller.level >= minRcl && r.find(FIND_MY_SPAWNS).length > 0
    ).map(r => {
        // The squad's own route (route.ts): members never walk through another player's or a keeper room
        const rooms = r.name === spawnRoom ? [r.name] : squadRoute(r.name, spawnRoom);
        return {
            room: r.name,
            route: rooms ? rooms.length - 1 : Infinity,
            capacity: r.energyCapacityAvailable,
            busy: busy.has(r.name)
        };
    });
    return helperRooms(spawnRoom, home.energyCapacityAvailable, bases);
}

function finish(
    kind: "duo" | "quad",
    name: string,
    mission: { targetRoom: string; spawnRoom: string; losses: number },
    result: "success" | "abandoned" | "retargeted"
): void {
    if (result === "success") {
        startLooting(mission.targetRoom, mission.spawnRoom);
        releaseFallen(mission.targetRoom);
    }
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
    if (memory.targets) {
        memory.targets = memory.targets.filter(t => t.room !== mission.targetRoom);
        if (memory.targets.length === 0) delete memory.targets;
    }
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

/**
 * Squad and boosts against the mission's target with the margin raised by ESCALATION_STEP per
 * ESCALATION_LOSSES creeps lost, never weaker boosts than the mission's (the intel the choice was made
 * on was stale, or the model too optimistic)
 */
function escalatedPlan(mission: DuoMemory | QuadMemory, type?: SquadType): SquadPlan | null {
    const spawnRoom = Game.rooms[mission.spawnRoom];
    if (!spawnRoom) return null;
    const steps = Math.floor(mission.losses / ESCALATION_LOSSES);
    const refills = towersRefill(mission.targetRoom);
    return planSquad(mission.targetRoom, spawnRoom.energyCapacityAvailable, type, refills, spawnRoom, {
        floor: mission.boosts,
        margin: BOOST_MARGIN * (1 + ESCALATION_STEP * steps)
    });
}

/** A duo that lost a pair against a room now sized for a quad (unless the squad type is forced): the quad's plan */
function upgradePlan(duo: DuoMemory): SquadPlan | null {
    if (militaryMemory().squad || duo.losses < 2 || duo.losses >= MAX_LOSSES) return null;
    const plan = escalatedPlan(duo);
    return plan?.type === "quad" ? plan : null;
}

/** Stronger boosts for the next members once the squad lost ESCALATION_LOSSES more creeps */
function escalateBoosts(kind: "duo" | "quad", name: string, mission: DuoMemory | QuadMemory): void {
    // Missions started before the boost choice keep the strongest boosts in stock
    if (!mission.boosts || mission.losses < (mission.boostLosses ?? 0) + ESCALATION_LOSSES) return;
    const plan = escalatedPlan(mission, kind);
    if (!plan) return;
    mission.boostLosses = mission.losses;
    if (_.isEqual(plan.compounds, mission.boosts)) return;
    mission.boosts = plan.compounds;
    countStat("military:boostEscalation");
    log.info("Military", `${name} lost ${mission.losses} creeps: boosts raised to ${describeBoosts(plan.compounds)}`);
}

function hasMission(target: string): boolean {
    const memory = militaryMemory();
    return !!memory.duos[`duo.${target}`] || !!memory.quads?.[`quad.${target}`];
}

/** The mission against the target has creeps (spawning ones included): retargeting would recycle them */
function isEngaged(target: string): boolean {
    return duoCreeps(`duo.${target}`).length > 0 || quadCreeps(`quad.${target}`).length > 0;
}

/** Average CPU per tick of this module (heap, military/cpuGuard.ts) */
let moduleCpu: number | undefined;

/**
 * Losses, a CPU cost the account can't carry (cpuGuard.ts) or the target changed (not a failure: the room
 * is not left alone for it, targets.ts recentlyFailed)
 */
function endReason(mission: { targetRoom: string; losses: number }): "abandoned" | "retargeted" | null {
    if (mission.losses >= MAX_LOSSES) return "abandoned";
    if (militaryCpuTooHigh(moduleCpu, Game.cpu.limit, decisionBucket())) {
        countStat("military:cpuAbandon");
        log.warn("Military", `Attack on ${mission.targetRoom}: ${moduleCpu!.toFixed(1)} CPU per tick with the bucket at ${decisionBucket()}`);
        return "abandoned";
    }
    return currentTargets().includes(mission.targetRoom) ? null : "retargeted";
}

/** Tick of the last mission start tried for each target (heap: no origin free is tried again later) */
const startTried: Map<string, number> = new Map();
const START_RETRY = 20;

function startMission(target: string): void {
    const memory = militaryMemory();
    if (Game.time - (startTried.get(target) ?? -Infinity) < START_RETRY) return;
    startTried.set(target, Game.time);
    const busy = busyBases(target);
    const origin = findOrigin(target, busy);
    if (!origin) return;
    const refills = towersRefill(target);
    const spawnRoom = Game.rooms[origin.spawnRoom];
    const plan = planSquad(target, spawnRoom.energyCapacityAvailable, memory.squad, refills, spawnRoom);
    if (!plan.feasible && memory.attack !== target) {
        if (memory.targets) memory.targets = memory.targets.filter(t => t.room !== target);
        return;
    }
    busy.add(origin.spawnRoom);
    const helpers = findHelpers(origin.spawnRoom, busy);
    const base = { ...origin, helpers, targetRoom: target, members: [], losses: 0, boosts: plan.compounds, boostLosses: 0 };
    if (plan.type === "duo") memory.duos[`duo.${target}`] = { ...base, state: "forming" };
    else memory.quads = { ...memory.quads, [`quad.${target}`]: { ...base, state: "forming" } };
    log.info(
        "Military",
        `${plan.type} from ${[origin.spawnRoom, ...helpers].join("+")} to attack ${target} (staging in ${origin.stagingRoom}):`,
        `edge damage ${plan.threat.edge}, close damage ${plan.threat.close}, heal ${plan.heal},`,
        `boosts ${describeBoosts(plan.compounds)} (${plan.boostCost} energy)`,
        plan.feasible ? "" : "(not enough healing: drain only)"
    );
}

/** An engaged target still worth its squad: no safe mode on, a spawn still seen there */
function targetStillHeld(roomName: string): boolean {
    const intel = hostileRoom(roomName);
    if (!intel) return true;
    if ((intel.safeMode ?? 0) > Game.time) return false;
    return intel.spawns > 0 || (intel.coreLevel ?? 0) > 0;
}

/** Missions at once by default, the manual attack included */
const DEFAULT_MAX_MISSIONS = 2;

/**
 * Automatic targets every AUTO_TARGET_EVERY ticks (targets.ts chooseAutoTargets, roi.ts pickTargets): the
 * slots left by the manual attack; a current target with a mission keeps a free slot even when no longer
 * picked (as the single target did before 2026-11-05)
 */
function updateAutoTargets(): void {
    const memory = militaryMemory();
    const max = Math.max(0, (memory.maxMissions ?? DEFAULT_MAX_MISSIONS) - (memory.attack ? 1 : 0));
    const entries = (memory.targets ?? []).filter(t => t.room !== memory.attack);
    const current = entries.map(t => t.room);
    // A mission still forming (no creep yet) counts as engaged: a better target must not recycle it
    const engaged = current.filter(r => isEngaged(r) || hasMission(r));
    // A mission with creeps keeps its target even when it stops being a candidate: its squad spent the boosts
    // in stock, so the target looks infeasible again (shard0 2026-11-05: quads on W26N3, then W28N3,
    // retargeted ~1000 ticks in without a loss and recycled). It ends by success, losses or the CPU guard;
    // a safe mode or a room left without spawn releases it.
    const held = entries.filter(t => isEngaged(t.room) && targetStillHeld(t.room)).slice(0, max);
    const picked = chooseAutoTargets(current, engaged, max).filter(auto => !held.some(t => t.room === auto.room));
    const next: AutoTargetEntry[] = [...held];
    for (const auto of picked) {
        if (next.length >= max) break;
        const known = entries.find(t => t.room === auto.room);
        if (known) {
            next.push(known);
            continue;
        }
        next.push({ room: auto.room, reason: auto.reason, since: Game.time, roi: Math.round(auto.roi * 100) / 100 });
        countStat(`military:target:${auto.reason}`);
        log.info("Military", `Automatic target: ${auto.room} (${auto.reason}, value ${auto.value} for a squad of ${auto.cost} energy)`);
    }
    for (const entry of entries)
        if (next.length < max && !next.includes(entry) && hasMission(entry.room)) next.push(entry);
    if (next.length > 0) memory.targets = next;
    else delete memory.targets;
}

export const militaryModule = (): void => {
    const start = Game.cpu.getUsed();
    runMilitary();
    moduleCpu = militaryCpuAverage(moduleCpu, Game.cpu.getUsed() - start);
};

function runMilitary(): void {
    updateMilitaryIntel();
    updateLootMissions();
    const memory = militaryMemory();
    // One target before 2026-11-05: its mission goes on as the first of the list
    if (memory.target) {
        memory.targets = [memory.target, ...(memory.targets ?? []).filter(t => t.room !== memory.target!.room)];
        delete memory.target;
    }
    if (Game.time % AUTO_TARGET_EVERY === 0) updateAutoTargets();
    for (const target of currentTargets()) if (!hasMission(target)) startMission(target);

    for (const name in memory.duos) {
        const duo = memory.duos[name];
        const upgrade = upgradePlan(duo);
        if (upgrade) {
            // The duo was sized on stale intel: the threat seen in the fight calls for a quad
            delete memory.duos[name];
            const quad: QuadMemory = { ...duo, members: [], state: "forming", boosts: upgrade.compounds, boostLosses: duo.losses };
            memory.quads = { ...memory.quads, [`quad.${duo.targetRoom}`]: quad };
            log.info("Military", `${name} lost ${duo.losses} creeps: a quad takes over (boosts ${describeBoosts(upgrade.compounds)})`);
            continue;
        }
        const duoEnd = isNeutralized(duo.targetRoom) ? "success" : endReason(duo);
        if (duoEnd) finish("duo", name, duo, duoEnd);
        else {
            escalateBoosts("duo", name, duo);
            runDuo(name, duo);
        }
    }
    for (const name in memory.quads ?? {}) {
        const quad = memory.quads![name];
        const quadEnd = isNeutralized(quad.targetRoom) ? "success" : endReason(quad);
        if (quadEnd) finish("quad", name, quad, quadEnd);
        else {
            escalateBoosts("quad", name, quad);
            runQuad(name, quad);
        }
    }
}

/** A squad member to spawn; `started`: another member is already alive or spawning */
interface MissingMember {
    name: string;
    role: string;
    started: boolean;
}

/** A base of the mission: its spawn room or a helper (shared missions) */
function spawnsFor(mission: DuoMemory | QuadMemory, roomName: string): boolean {
    return mission.spawnRoom === roomName || !!mission.helpers?.includes(roomName);
}

/**
 * Members given to a spawn this tick (heap), so two bases of a shared mission don't spawn the same one:
 * the creep only shows in duoCreeps / quadCreeps the next tick
 */
const claimed: { tick: number; members: string[] } = { tick: -1, members: [] };

function claimedRoles(name: string): string[] {
    if (claimed.tick !== Game.time) return [];
    return claimed.members.filter(m => m.startsWith(`${name}|`)).map(m => m.split("|")[1]);
}

function duoMissing(roomName: string): MissingMember | null {
    for (const [name, duo] of Object.entries(militaryMemory().duos)) {
        if (!spawnsFor(duo, roomName)) continue;
        const creeps = duoCreeps(name);
        const pending = claimedRoles(name);
        for (const role of [DUO_HEALER, DUO_ATTACKER]) {
            if (!creeps.some(c => c.memory.role === role) && !pending.includes(role))
                return { name, role, started: creeps.length + pending.length > 0 };
        }
    }
    return null;
}

/** Quads are refilled only while forming at home */
function quadMissing(roomName: string): MissingMember | null {
    for (const [name, quad] of Object.entries(militaryMemory().quads ?? {})) {
        if (!spawnsFor(quad, roomName) || quad.state !== "forming") continue;
        const creeps = quadCreeps(name);
        const pending = claimedRoles(name);
        const have = _.countBy([...creeps.map(c => c.memory.role), ...pending]);
        const wanted = _.countBy(QUAD_ROSTER);
        for (const role of QUAD_ROSTER) {
            if ((have[role] ?? 0) < wanted[role]) return { name, role, started: creeps.length + pending.length > 0 };
        }
    }
    return null;
}

function missionOf(option: SpawnOption): DuoMemory | QuadMemory | undefined {
    const memory = militaryMemory();
    return option.memory?.duo ? memory.duos[option.memory.duo] : memory.quads?.[option.memory?.quad ?? ""];
}

/** Bodies of the mission's spawn room, so members from a bigger helper match the squad's sizing */
function memberEnergy(room: Room, option: SpawnOption): number {
    const home = Game.rooms[missionOf(option)?.spawnRoom ?? ""];
    return Math.min(room.energyCapacityAvailable, home?.energyCapacityAvailable ?? room.energyCapacityAvailable);
}

/**
 * Spawn option of a missing member: the first one only once the room can pay for the whole squad
 * (the others then never wait for energy), the next ones back to back at BURST_PRIORITY
 */
function memberOption(room: Room, missing: MissingMember, type: "duo" | "quad"): SpawnOption[] {
    if (!missing.started) {
        const option = { role: missing.role, priority: 0, weight: 0, memory: { [type]: missing.name } } as SpawnOption;
        const squad = _.sum(squadMemberCosts(type, memberEnergy(room, option)));
        if (effectiveEnergy(room) < MIN_ENERGY + squad) return [];
    }
    return [
        {
            role: missing.role,
            priority: missing.started ? BURST_PRIORITY : START_PRIORITY,
            weight: 1,
            memory: { [type]: missing.name },
            reason: `${missing.name} ${missing.started ? "burst" : "start"}`
        } as SpawnOption
    ];
}

/** Spawn role of the duos and quads (healers first: the others wait next to them) */
export const militarySpawnRole: SpawnRole = {
    id: "military",
    emptyTimeout: 10,
    boostTimeout: SQUAD_BOOST_TIMEOUT,

    options(room) {
        if (effectiveEnergy(room) < MIN_ENERGY) return [];
        const duo = duoMissing(room.name);
        if (duo) return memberOption(room, duo, "duo");
        const quad = quadMissing(room.name);
        if (quad) return memberOption(room, quad, "quad");
        return [];
    },

    body(room, option) {
        const energy = memberEnergy(room, option);
        if (option.role === DUO_HEALER) return duoHealerBody(energy);
        if (option.role === QUAD_HEALER) return quadHealerBody(energy);
        if (option.role === QUAD_ATTACKER) return quadAttackerBody(energy);
        return duoAttackerBody(energy);
    },

    memory(room, option) {
        const name = option.memory?.duo ?? option.memory?.quad;
        if (name) {
            if (claimed.tick !== Game.time) claimed.members = [];
            claimed.tick = Game.time;
            claimed.members.push(`${name}|${option.role}`);
        }
        return { role: option.role, room: room.name, duo: option.memory?.duo, quad: option.memory?.quad };
    },

    /**
     * The compounds the mission chose against its target (sizing.ts planSquad, boostNeed.ts: the
     * cheapest set that holds; RANGED_ATTACK stays plain). Missions started before that choice: the best
     * available boosts of the combat parts (Hivemind squad getCreepBoosts). MOVE stays unboosted: bodies
     * are sized for plain MOVE parts. The squad waits at most SQUAD_BOOST_TIMEOUT ticks for them.
     */
    boosts(room, option, body) {
        const mission = missionOf(option);
        if (mission?.boosts) {
            const chosen = mission.boosts;
            const effects = Object.keys(SQUAD_BOOST_PARTS) as BoostedEffect[];
            return boostsWith(room, body, effects.map(e => [...SQUAD_BOOST_PARTS[e], chosen[e] ?? null]));
        }
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
