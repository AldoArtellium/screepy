/**
 * Offense: `Memory.military.attack = "<room>"` (by hand), else an automatic target (targets.ts:
 * strongholds near our rooms; player rooms unless `Memory.military.auto = false`), sends a duo or
 * a quad (sizing.ts, `Memory.military.squad` to force one). Colony missions (2026-11-14): the squad
 * forms in the rally room (`spawnRoom`, the RCL 4+ base with a spawn closest to the target); every base
 * within COLONY_RANGE of it whose capacity builds the mission's bodies (`energy`: the smallest capacity
 * whose squad holds, roi.ts energyBase) spawns members (`bases`, roi.ts colonyBases, refreshed every
 * BASES_REFRESH ticks), boosted members from the bases holding the mission's compounds. A base serves
 * every mission, in the order of currentTargets(). The mission ends when the room has no spawn, no tower
 * and no invader core left, or after the squad lost 10 creeps. A takeover mission (a player's room whose
 * controller siege fits, siege.ts) also waits for a way to the controller, and opens the siege on success.
 * Our design; see docs/decisions/military.md.
 */

import { duoCreeps, effectiveEnergy, quadCreeps } from "../core/roomState";
import { boostableParts, boostsFor, boostsWith, canBoost, cancelBoost } from "../labs/boosts";
import { performRecycle } from "../roles/recycle";
import { registerRole } from "../roles/registry";
import type { SpawnOption, SpawnRole } from "../spawning/spawnRoles";
import { log } from "../utils/logger";
import { countStat } from "../utils/stats";
import { BOOST_MARGIN, BoostedEffect } from "./boostNeed";
import { controllerBlocker, DUO_ATTACKER, DUO_HEALER, DuoMemory, runDuo } from "./duo";
import { openSiege, runSieges, siegePlan } from "./siege";
import { hostileRoom, militaryMemory, updateMilitaryIntel } from "./intel";
import { lootRamparts, startLooting, updateLootMissions } from "./loot";
import { QUAD_ATTACKER, QUAD_HEALER, QUAD_ROSTER, QuadMemory, runQuad } from "./quad";
import { DRAINER, drainerCreeps, runDrainers } from "./drainer";
import { squadRoute } from "./route";
import {
    describeBoosts,
    drainerBody,
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
import { BASES_REFRESH, BaseCandidate, colonyBases, energyBase, offersMember } from "./roi";
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

function minRcl(): number {
    return militaryMemory().minRcl ?? 4;
}

/**
 * Rally room of a mission: the RCL 4+ room with a spawn closest to the target by squad route, and the
 * room the squad heals up in before the target. Whether its squad can win is the bases' matter
 * (startMission): shard0 W28N8, W28N7 (RCL 5, no labs) next to it rallies, W29N7 (RCL 6, labs, XLHO2 and
 * GHO2) one more room spawns the boosted members.
 */
function findOrigin(target: string): { spawnRoom: string; stagingRoom: string; length: number } | null {
    let best: { spawnRoom: string; stagingRoom: string; length: number } | null = null;
    for (const room of _.filter(Game.rooms, r => !!r.controller?.my && r.controller.level >= minRcl())) {
        if (room.find(FIND_MY_SPAWNS).length === 0) continue;
        // The squad's own room route (route.ts): the staging room is never another player's room
        const rooms = squadRoute(room.name, target);
        if (!rooms || rooms.length < 2 || rooms.length - 1 > MAX_ROUTE_ROOMS) continue;
        if (!best || rooms.length - 1 < best.length)
            best = { spawnRoom: room.name, stagingRoom: rooms[rooms.length - 2], length: rooms.length - 1 };
    }
    return best;
}

/** Rooms under attack: the one set by hand, then the automatic targets */
export function currentTargets(): string[] {
    const memory = militaryMemory();
    const rooms = (memory.targets ?? []).map(t => t.room);
    return memory.attack ? [memory.attack, ...rooms.filter(r => r !== memory.attack)] : rooms;
}

type Mission = DuoMemory | QuadMemory;

/**
 * Our rooms as bases of a mission rallying in `rally` (roi.ts colonyBases filters them), by the squad's
 * own route (route.ts): members never walk through another player's or a keeper room
 */
function baseCandidates(rally: string): (BaseCandidate & { home: Room })[] {
    return _.filter(Game.rooms, r => !!r.controller?.my).map(r => {
        const level = r.controller!.level;
        const rooms = level >= minRcl() ? squadRoute(r.name, rally) : null;
        return {
            room: r.name,
            route: rooms ? rooms.length - 1 : Infinity,
            capacity: r.energyCapacityAvailable,
            rcl: level,
            spawns: r.find(FIND_MY_SPAWNS).length,
            home: r
        };
    });
}

/** Missions started before 2026-11-14 (a spawn room and its helpers): the colony's fields */
function migrateMission(mission: Mission): void {
    if (mission.bases) return;
    const old = mission as Mission & { helpers?: string[] };
    mission.bases = [mission.spawnRoom, ...(old.helpers ?? [])];
    const capacities = mission.bases.map(b => Game.rooms[b]?.energyCapacityAvailable).filter((c): c is number => !!c);
    mission.energy = Game.rooms[mission.spawnRoom]?.energyCapacityAvailable ?? capacities[0] ?? 0;
    delete old.helpers;
}

/** Bases of a mission again every BASES_REFRESH ticks: rooms grow, lose their spawn, get one */
function refreshBases(name: string, mission: Mission): void {
    if (Game.time - (mission.basesAt ?? -Infinity) < BASES_REFRESH) return;
    mission.basesAt = Game.time;
    const bases = colonyBases(mission.energy, minRcl(), baseCandidates(mission.spawnRoom));
    if (_.isEqual(bases, mission.bases)) return;
    log.info("Military", `${name}: bases ${mission.bases.join("+") || "none"} -> ${bases.join("+") || "none"}`);
    mission.bases = bases;
}

interface MissionEntry {
    kind: "duo" | "quad";
    name: string;
    mission: Mission;
}

/** Every mission (migrated), those of currentTargets() first in its order (the manual attack first) */
function missionsInOrder(): MissionEntry[] {
    const memory = militaryMemory();
    const entries: MissionEntry[] = [
        ...Object.entries(memory.duos).map(([name, mission]) => ({ kind: "duo" as const, name, mission })),
        ...Object.entries(memory.quads ?? {}).map(([name, mission]) => ({ kind: "quad" as const, name, mission }))
    ];
    for (const entry of entries) migrateMission(entry.mission);
    const targets = currentTargets();
    const rank = (entry: MissionEntry) => {
        const index = targets.indexOf(entry.mission.targetRoom);
        return index < 0 ? targets.length : index;
    };
    return entries
        .map((entry, index) => ({ entry, index }))
        .sort((x, y) => rank(x.entry) - rank(y.entry) || x.index - y.index)
        .map(x => x.entry);
}

function finish(kind: "duo" | "quad", name: string, mission: Mission, result: "success" | "abandoned" | "retargeted"): void {
    if (result === "success") {
        startLooting(mission.targetRoom, mission.spawnRoom);
        // Before releaseFallen: the siege reads the owner from the intel
        if (mission.takeover) openSiege(mission.targetRoom, mission.bases, mission.spawnRoom);
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

/**
 * Visible room without spawn, tower or invader core left, nor a hostile rampart over loot (loot.ts); for a
 * takeover, a tile next to the controller reachable from a squad member in the room (duo.ts controllerBlocker)
 */
function isNeutralized(roomName: string, mission: Mission, creeps: Creep[]): boolean {
    const room = Game.rooms[roomName];
    if (!room) return false;
    const left = room.find(FIND_HOSTILE_STRUCTURES, {
        filter: s =>
            s.structureType === STRUCTURE_SPAWN ||
            s.structureType === STRUCTURE_TOWER ||
            s.structureType === STRUCTURE_INVADER_CORE
    });
    if (left.length > 0 || lootRamparts(room).length > 0) return false;
    if (!mission.takeover || !room.controller?.owner || room.controller.my) return true;
    const inside = creeps.find(c => !c.spawning && c.room.name === roomName);
    return !!inside && !controllerBlocker(room, inside.pos);
}

/**
 * Squad and boosts against the mission's target with the margin raised by ESCALATION_STEP per
 * ESCALATION_LOSSES creeps lost, never weaker boosts than the mission's (the intel the choice was made
 * on was stale, or the model too optimistic)
 */
function escalatedPlan(mission: Mission, type?: SquadType): SquadPlan | null {
    const steps = Math.floor(mission.losses / ESCALATION_LOSSES);
    const refills = towersRefill(mission.targetRoom);
    // The stock of each base with labs (the first visible base without any): the first that holds wins
    const visible = mission.bases.map(b => Game.rooms[b]).filter((r): r is Room => !!r);
    const labRooms = visible.filter(r => canBoost(r));
    let fallback: SquadPlan | null = null;
    for (const room of labRooms.length > 0 ? labRooms : visible.slice(0, 1)) {
        const plan = planSquad(mission.targetRoom, mission.energy, type, refills, room, {
            floor: mission.boosts,
            margin: BOOST_MARGIN * (1 + ESCALATION_STEP * steps)
        });
        if (plan.feasible) return plan;
        fallback = fallback ?? plan;
    }
    return fallback;
}

/** A duo that lost a pair against a room now sized for a quad (unless the squad type is forced): the quad's plan */
function upgradePlan(duo: DuoMemory): SquadPlan | null {
    if (militaryMemory().squad || duo.losses < 2 || duo.losses >= MAX_LOSSES) return null;
    const plan = escalatedPlan(duo);
    return plan?.type === "quad" ? plan : null;
}

/** Stronger boosts for the next members once the squad lost ESCALATION_LOSSES more creeps */
function escalateBoosts(kind: "duo" | "quad", name: string, mission: Mission): void {
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
    const origin = findOrigin(target);
    if (!origin) return;
    const refills = towersRefill(target);
    const candidates = baseCandidates(origin.spawnRoom);
    // Bodies sized on the smallest capacity whose squad holds with that base's boosts (roi.ts energyBase)
    const plans = new Map<string, SquadPlan>();
    const planOf = (base: BaseCandidate & { home: Room }): SquadPlan => {
        const known = plans.get(base.room);
        if (known) return known;
        const plan = planSquad(target, base.capacity, memory.squad, refills, base.home);
        plans.set(base.room, plan);
        return plan;
    };
    const sizing = energyBase(candidates, minRcl(), base => planOf(base).feasible);
    let plan: SquadPlan;
    let energy: number;
    if (sizing) {
        plan = planOf(sizing);
        energy = sizing.capacity;
    } else if (memory.attack === target) {
        // By hand: the rally's squad, drain only
        const rally = Game.rooms[origin.spawnRoom];
        energy = rally.energyCapacityAvailable;
        plan = planSquad(target, energy, memory.squad, refills, rally);
    } else {
        if (memory.targets) memory.targets = memory.targets.filter(t => t.room !== target);
        return;
    }
    const bases = colonyBases(energy, minRcl(), candidates);
    const takeover = takeoverOf(target, bases);
    const base = {
        ...origin,
        bases,
        basesAt: Game.time,
        energy,
        targetRoom: target,
        members: [],
        losses: 0,
        boosts: plan.compounds,
        boostLosses: 0,
        ...(takeover !== undefined && { takeover })
    };
    if (plan.type === "duo") memory.duos[`duo.${target}`] = { ...base, state: "forming" };
    else {
        // Towers the quad doesn't tank: a drainer first, the quad once they are predicted empty (drainer.ts)
        const probe = !plan.tanks && (hostileRoom(target)?.towers ?? 1) > 0;
        memory.quads = {
            ...memory.quads,
            [`quad.${target}`]: { ...base, state: probe ? "probe" : "forming", ...(probe && { probeSince: Game.time }) }
        };
    }
    log.info(
        "Military",
        `${plan.type} rallying in ${origin.spawnRoom} from ${bases.join("+")}`,
        `(bodies of ${energy} energy${sizing ? `, boosts of ${sizing.room}` : ""})`,
        `to attack ${target} (staging in ${origin.stagingRoom}):`,
        `edge damage ${plan.threat.edge}, close damage ${plan.threat.close}, heal ${plan.heal},`,
        `boosts ${describeBoosts(plan.compounds)} (${plan.boostCost} energy)`,
        plan.feasible ? "" : "(not enough healing: drain only)",
        takeover ? "takeover" : ""
    );
}

/**
 * Takeover (siege.ts): a player's room whose siege fits SIEGE_MAX_TICKS with the claimer of the mission's
 * biggest base; an automatic target whose return could not carry the siege (targets.ts) is attacked
 * without it. Undefined while the room has no intel (a manual attack on a room never seen).
 */
function takeoverOf(target: string, bases: string[]): boolean | undefined {
    if (!hostileRoom(target)?.rcl) return undefined;
    const memory = militaryMemory();
    const biggest = _.max([0, ...bases.map(b => Game.rooms[b]?.energyCapacityAvailable ?? 0)]);
    const siege = siegePlan(target, biggest);
    if (!siege) return false;
    if (memory.attack !== target && memory.targets?.find(t => t.room === target)?.takeover === false) return false;
    log.info("Military", `Attack on ${target} is a takeover: siege ~${siege.ticks} ticks with ${siege.parts} CLAIM parts`);
    return true;
}

/** A mission started before its target was seen: takeover or not once the intel has it */
function resolveTakeover(mission: Mission): void {
    if (mission.takeover !== undefined) return;
    const takeover = takeoverOf(mission.targetRoom, mission.bases);
    if (takeover !== undefined) mission.takeover = takeover;
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
        next.push({
            room: auto.room,
            reason: auto.reason,
            since: Game.time,
            roi: Math.round(auto.roi * 100) / 100,
            takeover: auto.takeover
        });
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
    for (const { name, mission } of missionsInOrder()) {
        refreshBases(name, mission);
        resolveTakeover(mission);
    }

    for (const name in memory.duos) {
        const duo = memory.duos[name];
        const upgrade = upgradePlan(duo);
        if (upgrade) {
            // The duo was sized on stale intel: the threat seen in the fight calls for a quad
            delete memory.duos[name];
            // A quad that doesn't tank the towers probes them with a drainer first, like a new mission
            const probe = !upgrade.tanks && (hostileRoom(duo.targetRoom)?.towers ?? 1) > 0;
            const quad: QuadMemory = {
                ...duo,
                members: [],
                state: probe ? "probe" : "forming",
                ...(probe && { probeSince: Game.time }),
                boosts: upgrade.compounds,
                boostLosses: duo.losses
            };
            memory.quads = { ...memory.quads, [`quad.${duo.targetRoom}`]: quad };
            log.info("Military", `${name} lost ${duo.losses} creeps: a quad takes over (boosts ${describeBoosts(upgrade.compounds)})`);
            continue;
        }
        const duoEnd = isNeutralized(duo.targetRoom, duo, duoCreeps(name)) ? "success" : endReason(duo);
        if (duoEnd) finish("duo", name, duo, duoEnd);
        else {
            escalateBoosts("duo", name, duo);
            runDuo(name, duo);
        }
    }
    for (const name in memory.quads ?? {}) {
        const quad = memory.quads![name];
        // A drain the owner out-refills (quad.ts drain): abandoned, the room left alone FAILURE_MEMORY ticks
        const quadEnd = isNeutralized(quad.targetRoom, quad, quadCreeps(name))
            ? "success"
            : quad.drainStalled
              ? "abandoned"
              : endReason(quad);
        if (quadEnd) {
            finish("quad", name, quad, quadEnd);
            continue;
        }
        trackDrainer(name, quad);
        const decision = runDrainers(name, quad);
        if (decision === "noFire" || decision === "noProgress") {
            countStat(`military:drain:${decision}`);
            const why = decision === "noFire" ? "the towers never fire at the exit tile" : "the refills keep up";
            log.info("Military", `${name}: ${why}, abandoned before spawning the quad`);
            finish("quad", name, quad, "abandoned");
            continue;
        }
        if (decision === "spawn") {
            quad.state = "forming";
            countStat("military:drainSpawn");
            const eta = quad.probe?.rate ? Math.round((quad.probeEnergy ?? 0) / quad.probe.rate) : 0;
            log.info("Military", `${name}: towers at ${quad.probeEnergy ?? 0} energy, empty in ~${eta} ticks: spawning the quad`);
        }
        escalateBoosts("quad", name, quad);
        if (quad.state !== "probe") runQuad(name, quad);
    }
    runSieges();
}

/** A drainer gone before its time is a loss of the mission (MAX_LOSSES, escalation) */
function trackDrainer(name: string, quad: QuadMemory): void {
    const tracked = quad.drainer;
    if (tracked && !Game.creeps[tracked.name]) {
        if (Game.time < tracked.dies - 5) {
            quad.losses++;
            countStat("military:drainerLost");
            log.info("Military", `${name}: lost drainer ${tracked.name}`);
        }
        delete quad.drainer;
    }
    const alive = drainerCreeps(name).find(c => !c.spawning && c.ticksToLive !== undefined);
    if (alive) quad.drainer = { name: alive.name, dies: Game.time + alive.ticksToLive! };
}

/** A squad member to spawn; `started`: another member is already alive or spawning */
interface MissingMember {
    name: string;
    role: string;
    started: boolean;
    type: "duo" | "quad";
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

/** Bodies the mission is sized on (its `energy`), a base never builds bigger ones than it can */
function memberEnergy(room: Room, mission: Mission | undefined): number {
    return mission?.energy ? Math.min(room.energyCapacityAvailable, mission.energy) : room.energyCapacityAvailable;
}

function memberBody(role: string, energy: number): BodyPartConstant[] {
    if (role === DRAINER) return drainerBody(energy);
    if (role === DUO_HEALER) return duoHealerBody(energy);
    if (role === QUAD_HEALER) return quadHealerBody(energy);
    if (role === QUAD_ATTACKER) return quadAttackerBody(energy);
    return duoAttackerBody(energy);
}

/**
 * Boost routing (roi.ts offersMember): a base without the mission's compounds for the member's boosted
 * parts (labs, storage, terminal, minus other creeps' requests) leaves it to a base of the mission that
 * holds them all
 */
function offersBoosted(room: Room, mission: Mission, role: string): boolean {
    const compounds = mission.boosts;
    if (!compounds) return true;
    const counts = _.countBy(memberBody(role, memberEnergy(room, mission)));
    const needs = (Object.keys(SQUAD_BOOST_PARTS) as BoostedEffect[])
        .map(effect => ({ compound: compounds[effect], parts: counts[SQUAD_BOOST_PARTS[effect][0]] ?? 0 }))
        .filter(need => !!need.compound && need.parts > 0);
    const holds = (base: Room | undefined): boolean =>
        !!base && canBoost(base) && needs.every(n => boostableParts(base, n.compound as ResourceConstant) >= n.parts);
    const here = needs.length === 0 || holds(room);
    const elsewhere = !here && mission.bases.some(b => b !== room.name && holds(Game.rooms[b]));
    return offersMember(needs.length > 0, here, elsewhere);
}

/**
 * First member this base spawns: missions it is a base of, in the order of currentTargets(); quads are
 * refilled only while forming at the rally
 */
function missingMember(room: Room): MissingMember | null {
    for (const { kind, name, mission } of missionsInOrder()) {
        if (!mission.bases.includes(room.name)) continue;
        // One drainer at a time: alone while probing, and replaced while the quad forms (one that dies of
        // age before the quad gets there would leave the towers to refill)
        const probing = kind === "quad" && (mission.state === "probe" || (mission.state === "forming" && !!(mission as QuadMemory).probe));
        if (probing) {
            const drainers = drainerCreeps(name).length + claimedRoles(name).filter(r => r === DRAINER).length;
            if (drainers === 0) return { name, role: DRAINER, started: false, type: kind };
            if (mission.state === "probe") continue;
        }
        if (kind === "quad" && mission.state !== "forming") continue;
        const creeps = kind === "duo" ? duoCreeps(name) : quadCreeps(name);
        const pending = claimedRoles(name);
        const roster = kind === "duo" ? [DUO_HEALER, DUO_ATTACKER] : QUAD_ROSTER;
        const have = _.countBy([...creeps.map(c => c.memory.role), ...pending]);
        const wanted = _.countBy(roster);
        for (const role of _.uniq(roster)) {
            if ((have[role] ?? 0) >= wanted[role] || !offersBoosted(room, mission, role)) continue;
            return { name, role, started: creeps.length + pending.length > 0, type: kind };
        }
    }
    return null;
}

function missionOf(option: SpawnOption): Mission | undefined {
    const memory = militaryMemory();
    return option.memory?.duo ? memory.duos[option.memory.duo] : memory.quads?.[option.memory?.quad ?? ""];
}

/**
 * Spawn option of a missing member: the first one only once the room can pay for the whole squad
 * (the others then never wait for energy), the next ones back to back at BURST_PRIORITY
 */
function memberOption(room: Room, missing: MissingMember): SpawnOption[] {
    const type = missing.type;
    if (!missing.started) {
        const mission = type === "duo" ? militaryMemory().duos[missing.name] : militaryMemory().quads?.[missing.name];
        const energy = memberEnergy(room, mission);
        const squad =
            missing.role === DRAINER
                ? _.sum(drainerBody(energy), p => BODYPART_COST[p])
                : _.sum(squadMemberCosts(type, energy));
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
        const missing = missingMember(room);
        return missing ? memberOption(room, missing) : [];
    },

    body(room, option) {
        return memberBody(option.role, memberEnergy(room, missionOf(option)));
    },

    memory(room, option) {
        const name = option.memory?.duo ?? option.memory?.quad;
        if (name) {
            if (claimed.tick !== Game.time) claimed.members = [];
            claimed.tick = Game.time;
            claimed.members.push(`${name}|${option.role}`);
        }
        // A drainer is no quad member (quadCreeps, roster, formation): its own key
        if (option.role === DRAINER) return { role: option.role, room: room.name, drain: option.memory?.quad };
        return { role: option.role, room: room.name, duo: option.memory?.duo, quad: option.memory?.quad };
    },

    /**
     * The compounds the mission chose against its target (sizing.ts planSquad, boostNeed.ts: the
     * cheapest set that holds; RANGED_ATTACK stays plain). Missions started before that choice: the best
     * available boosts of the combat parts (Hivemind squad getCreepBoosts). MOVE stays unboosted: bodies
     * are sized for plain MOVE parts. The squad waits at most SQUAD_BOOST_TIMEOUT ticks for them.
     */
    boosts(room, option, body) {
        // The drainer stays plain: the compounds in stock are the quad's (its feasibility counted on them)
        if (option.role === DRAINER) return {};
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
registerRole(DRAINER, creep => {
    if (!creep.memory.drain || !militaryMemory().quads?.[creep.memory.drain]) performRecycle(creep);
});
for (const role of [QUAD_ATTACKER, QUAD_HEALER]) {
    registerRole(role, creep => {
        if (!creep.memory.quad || !militaryMemory().quads?.[creep.memory.quad]) performRecycle(creep);
    });
}
