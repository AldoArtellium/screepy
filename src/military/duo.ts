/**
 * Duo: an attacker (ATTACK) and a healer moving as one. The attacker only steps when
 * the healer is next to it and neither is tired; the healer then takes the attacker's tile.
 *
 * States: forming (gather at home) -> advance (towards the target, breaching the weakest ramparts)
 * -> retreat (out of the target room) when one of them drops below 60% hits or the next tile would
 * kill it within 3 ticks; back to advance once both are healed to 95%. Against towers that out-damage
 * the healer, this in-and-out dance drains them. Target in the room: towers, then spawns, then other
 * structures, attacking what blocks the path.
 * Our design; see docs/superpowers/roadmap.md (J7) and Harabi's "Combat Blob" log for the ideas.
 */

import { duoCreeps } from "../core/roomState";
import { threatOf } from "../defense/threat";
import { needsBoosting } from "../labs/boosts";
import { trafficManager } from "../modules/TrafficManager";
import { jitter } from "../utils/jitter";
import { log } from "../utils/logger";
import { countStat } from "../utils/stats";
import { onRoomEdge } from "../utils/rooms";
import { attackPower, hitsRatio, incomingDamage, verdict } from "./combat";
import { DuoPath, STILL_TICKS, StillState, cachedStep, newPath, noteStep, stillFor } from "./duoPath";
import { lootRamparts } from "./loot";
import { CRITICAL_CLASS, TARGET_CLASS, TargetDescriptor, barrierCost, chooseTarget, targetClass } from "./targetChoice";
import { cachedObstacles, routeRooms } from "./route";

export const DUO_ATTACKER = "duoAttacker";
export const DUO_HEALER = "duoHealer";

export type DuoState = "forming" | "advance" | "retreat";

export interface DuoMemory {
    /** Rally room: the base closest to the target, where the squad forms */
    spawnRoom: string;
    /** Bases spawning members (roi.ts colonyBases, refreshed every 100 ticks), who walk to spawnRoom to form */
    bases: string[];
    /** Tick the bases were chosen */
    basesAt?: number;
    /** Energy capacity the bodies are sized on (roi.ts energyBase) */
    energy: number;
    targetRoom: string;
    state: DuoState;
    /** Room just before the target on the route: where the duo heals up */
    stagingRoom: string;
    /** Members seen alive (to count losses) */
    members: string[];
    losses: number;
    /** Compounds the members get (military.ts startMission; absent: the strongest in stock) */
    boosts?: import("./boostNeed").SquadCompounds;
    /** Losses when the boosts were chosen (escalation) */
    boostLosses?: number;
    /** Takeover mission: the way to the controller is broken, a siege follows the success (siege.ts) */
    takeover?: boolean;
}

declare global {
    interface CreepMemory {
        /** Duo the creep belongs to */
        duo?: string;
    }
}

const RETREAT_HITS = 0.6;
/** Traffic priorities (lower = more important): the attacker never shoves its healer onto an exit */
const HEALER_PRIORITY = 1;
const ATTACKER_PRIORITY = 2;
const READY_HITS = 0.95;
const IGNORED: StructureConstant[] = [STRUCTURE_CONTROLLER, STRUCTURE_RAMPART, STRUCTURE_WALL, STRUCTURE_ROAD, STRUCTURE_CONTAINER, STRUCTURE_EXTRACTOR, STRUCTURE_KEEPER_LAIR, STRUCTURE_PORTAL];

function members(name: string): { attacker?: Creep; healer?: Creep } {
    const all = duoCreeps(name).filter(c => !c.spawning);
    return { attacker: all.find(c => c.memory.role === DUO_ATTACKER), healer: all.find(c => c.memory.role === DUO_HEALER) };
}

export interface PickOptions {
    /**
     * Takeover mission (controller attack): once no tower or spawn is left, break the way to the
     * controller when no tile next to it can be reached (controllerBlocker)
     */
    takeover?: boolean;
}

/** Hostile rampart on a tile (a structure under it can only be hit through it) */
export function coverOf(s: Structure): StructureRampart | undefined {
    return s.pos
        .lookFor(LOOK_STRUCTURES)
        .find((r): r is StructureRampart => r.structureType === STRUCTURE_RAMPART && !(r as StructureRampart).my);
}

/**
 * Structure a squad goes for in the target room (targetChoice.ts): armed towers and the invader core,
 * spawns, empty towers, extensions, storage and terminal, then the ramparts over loot (loot.ts: a store
 * can't be withdrawn from under them), then the rest; the cheapest to break at `dps` within the best class.
 * With `takeover`, the first barrier on the way to an enclosed controller once towers and spawns are gone.
 */
export function pickTarget(room: Room, from: RoomPosition, dps = 1, options: PickOptions = {}): Structure | null {
    const hostile = room.find(FIND_HOSTILE_STRUCTURES).filter(s => !IGNORED.includes(s.structureType));
    const byId = new Map<string, Structure>();
    const targets: TargetDescriptor[] = [];
    for (const s of hostile) {
        const energy = s.structureType === STRUCTURE_TOWER ? (s as StructureTower).store.getUsedCapacity(RESOURCE_ENERGY) : 0;
        byId.set(s.id, s);
        targets.push({ id: s.id, cls: targetClass(s.structureType, energy), hits: s.hits ?? 0, coverHits: coverOf(s)?.hits ?? 0, range: from.getRangeTo(s) });
    }
    const critical = targets.some(t => t.cls <= CRITICAL_CLASS);
    if (!critical && options.takeover) {
        const blocker = controllerBlocker(room, from);
        if (blocker) return blocker;
    }
    // Loot ramparts only matter once the better classes are gone (lootRamparts walks every store)
    if (!targets.some(t => t.cls < TARGET_CLASS.lootRampart)) {
        for (const r of lootRamparts(room)) {
            if (byId.has(r.id)) continue;
            byId.set(r.id, r);
            targets.push({ id: r.id, cls: TARGET_CLASS.lootRampart, hits: r.hits, coverHits: 0, range: from.getRangeTo(r) });
        }
    }
    const best = chooseTarget(targets, dps);
    return best ? (byId.get(best.id) ?? null) : null;
}

/** Barrier cost matrices of controllerBlocker (heap), rebuilt when the structure count changes or after ~20 ticks */
const BLOCKER_TTL = 20;
const blockers: Map<string, { count: number; until: number; id: Id<Structure> | null }> = new Map();

/** A wall, or a rampart neither ours nor public: what a squad breaks to pass */
export function isHostileBarrier(s: Structure): boolean {
    if (s.structureType === STRUCTURE_WALL) return true;
    if (s.structureType !== STRUCTURE_RAMPART) return false;
    const rampart = s as StructureRampart;
    return !rampart.my && !rampart.isPublic;
}

/**
 * First hostile rampart or wall on the cheapest way from `from` to a tile next to the controller, when no
 * such tile can be reached without breaking one (null: the controller is open, or no path at all).
 * Barriers cost by their hits (targetChoice.ts barrierCost), other obstacles block.
 */
export function controllerBlocker(room: Room, from: RoomPosition): Structure | null {
    const controller = room.controller;
    if (!controller) return null;
    const count = room.find(FIND_STRUCTURES).length;
    const cached = blockers.get(room.name);
    if (cached && cached.count === count && cached.until > Game.time) {
        return cached.id ? Game.getObjectById(cached.id) : null;
    }
    const structures = room.find(FIND_STRUCTURES);
    const barriers = structures.filter(isHostileBarrier);
    const maxHits = _.max([1, ...barriers.map(b => b.hits ?? 0)]);
    const closed = new PathFinder.CostMatrix();
    const open = new PathFinder.CostMatrix();
    for (const s of structures) {
        if (s.structureType === STRUCTURE_ROAD) continue;
        if (isHostileBarrier(s)) {
            closed.set(s.pos.x, s.pos.y, 255);
            if (open.get(s.pos.x, s.pos.y) !== 255) open.set(s.pos.x, s.pos.y, barrierCost(s.hits ?? 0, maxHits));
        } else if ((OBSTACLE_OBJECT_TYPES as string[]).includes(s.structureType)) {
            closed.set(s.pos.x, s.pos.y, 255);
            open.set(s.pos.x, s.pos.y, 255);
        }
    }
    const search = (matrix: CostMatrix) =>
        PathFinder.search(from, { pos: controller.pos, range: 1 }, {
            maxRooms: 1,
            plainCost: 2,
            swampCost: 10,
            roomCallback: roomName => (roomName === room.name ? matrix : false)
        });
    let id: Id<Structure> | null = null;
    countStat("military:controllerSearch");
    if (search(closed).incomplete) {
        const result = search(open);
        if (!result.incomplete) {
            for (const pos of result.path) {
                const barrier = pos.lookFor(LOOK_STRUCTURES).find(isHostileBarrier);
                if (barrier) {
                    id = barrier.id;
                    break;
                }
            }
        }
    }
    if (blockers.size > 20) blockers.clear();
    blockers.set(room.name, { count, until: Game.time + jitter(BLOCKER_TTL), id });
    return id ? Game.getObjectById(id) : null;
}

/**
 * Structures of a room as a cost matrix: roads 1, hostile barriers (isHostileBarrier) `barrierCost`,
 * other obstacles 255; `skip` left out
 */
function structureMatrix(room: Room, barrierCost: (s: Structure) => number, skip?: string): CostMatrix {
    const matrix = new PathFinder.CostMatrix();
    for (const s of room.find(FIND_STRUCTURES)) {
        if (s.id === skip) continue;
        if (s.structureType === STRUCTURE_ROAD) {
            if (matrix.get(s.pos.x, s.pos.y) === 0) matrix.set(s.pos.x, s.pos.y, 1);
        } else if (isHostileBarrier(s)) {
            matrix.set(s.pos.x, s.pos.y, barrierCost(s));
        } else if ((OBSTACLE_OBJECT_TYPES as string[]).includes(s.structureType)) {
            matrix.set(s.pos.x, s.pos.y, 255);
        }
    }
    return matrix;
}

/** Ramparts and walls cost by their hits (the path goes through the weakest), other obstacles block */
function computeBreachMatrix(room: Room, target: Structure): CostMatrix {
    return structureMatrix(room, s => Math.min(250, 20 + Math.floor(s.hits / 2000)), target.id);
}

/** Breach matrix of a room: rebuilt when the target or the structure count changes, else every ~20 ticks (hits) */
const BREACH_TTL = 20;
const breachMatrices: Map<string, { target: string; count: number; until: number; matrix: CostMatrix; version: number }> = new Map();
let breachVersion = 0;

function breachMatrix(room: Room, target: Structure): { matrix: CostMatrix; version: number } {
    const count = room.find(FIND_STRUCTURES).length;
    const entry = breachMatrices.get(room.name);
    if (entry && entry.target === target.id && entry.count === count && entry.until > Game.time) return entry;
    if (breachMatrices.size > 20) breachMatrices.clear();
    const fresh = { target: target.id, count, until: Game.time + jitter(BREACH_TTL), matrix: computeBreachMatrix(room, target), version: ++breachVersion };
    breachMatrices.set(room.name, fresh);
    return fresh;
}

/** Path of each duo's attacker (heap, duoPath.ts): searched again only when it no longer applies */
const PATH_TTL = 50;
const paths: Map<string, DuoPath<RoomPosition>> = new Map();
/** Still attacker of each duo (heap): an advancing duo stuck outside the target room */
const still: Map<string, StillState> = new Map();

function prune(): void {
    if (paths.size <= 10 && still.size <= 10) return;
    for (const [name, state] of still) if (state.seen < Game.time - 100) still.delete(name);
    for (const [name, cache] of paths) if (cache.until < Game.time - 100) paths.delete(name);
}

export function isMine(s: Structure): boolean {
    return "my" in s && !!(s as OwnedStructure).my;
}

/** Wall, hostile rampart or hostile obstacle on a tile of the target room (what the attacker breaks to pass) */
function blockerAt(pos: RoomPosition, targetRoom: string): Structure | undefined {
    if (pos.roomName !== targetRoom || !Game.rooms[pos.roomName]) return undefined;
    return pos.lookFor(LOOK_STRUCTURES).find(s => {
        if (isMine(s)) return false;
        if (s.structureType === STRUCTURE_WALL) return true;
        if (s.structureType === STRUCTURE_RAMPART) return !(s as StructureRampart).isPublic;
        return (OBSTACLE_OBJECT_TYPES as string[]).includes(s.structureType);
    });
}

function avoiding(matrix: CostMatrix | boolean, roomName: string, avoid?: RoomPosition): CostMatrix | boolean {
    if (!avoid || avoid.roomName !== roomName || typeof matrix === "boolean") return matrix;
    const copy = matrix.clone();
    copy.set(avoid.x, avoid.y, 255);
    return copy;
}

/**
 * Rooms on the way: structures that block movement, roads cheap (no creeps: the pair moves through
 * traffic). A room out of sight keeps the obstacles seen last (route.ts), else it looks empty.
 */
export function travelMatrix(roomName: string): CostMatrix | boolean {
    return cachedObstacles(roomName, obstacleMatrix) ?? true;
}

/**
 * PathFinder room callback of a squad's travel: only the rooms of its room route (route.ts), with
 * their travel matrix; null when every route crosses another player's room
 */
export function travelCallback(
    from: string,
    to: string,
    members: RoomPosition[],
    avoid?: RoomPosition
): ((roomName: string) => CostMatrix | boolean) | null {
    const allowed = routeRooms(from, to, members);
    if (!allowed) {
        countStat("military:noRoute");
        return null;
    }
    return name => (allowed.has(name) ? avoiding(travelMatrix(name), name, avoid) : false);
}

/** Every barrier and obstacle blocks */
function obstacleMatrix(room: Room): CostMatrix {
    return structureMatrix(room, () => 255);
}

/**
 * Next tile of the attacker towards another room (`range` of its center), on the duo's cached path
 * when it still applies, else from a new search held to the room route
 */
function travelStep(attacker: Creep, name: string, goalRoom: string, range: number, maxOps: number, healerPos?: RoomPosition): RoomPosition | null {
    const room = attacker.room.name;
    const allowed = routeRooms(room, goalRoom, healerPos ? [healerPos] : []);
    if (!allowed) {
        countStat("military:noRoute");
        return null;
    }
    const key = `travel:${goalRoom}`;
    const cached = cachedStep(paths.get(name), key, attacker.pos, Game.time, healerPos, allowed);
    if (cached) return cached;
    const roomCallback = travelCallback(room, goalRoom, healerPos ? [healerPos] : [], healerPos);
    if (!roomCallback) return null;
    countStat("military:duoSearch");
    const result = PathFinder.search(attacker.pos, { pos: new RoomPosition(25, 25, goalRoom), range }, {
        plainCost: 2,
        swampCost: 10,
        maxOps,
        roomCallback
    });
    if (!result.path[0]) {
        paths.delete(name);
        return null;
    }
    paths.set(name, newPath(key, attacker.pos, result.path, Game.time, jitter(PATH_TTL)));
    return result.path[0];
}

/** Next tile of the attacker towards its goal (null: there, or no path) */
function nextStep(attacker: Creep, name: string, duo: DuoMemory, healerPos?: RoomPosition): { pos: RoomPosition; target?: Structure } | null {
    const room = attacker.room;
    if (room.name === duo.targetRoom) {
        const target = pickTarget(room, attacker.pos, Math.max(1, attackPower(attacker.body)), { takeover: duo.takeover });
        if (!target) return null;
        if (attacker.pos.isNearTo(target)) return { pos: attacker.pos, target };
        const { matrix, version } = breachMatrix(room, target);
        const key = `breach:${target.id}:${version}`;
        const cached = cachedStep(paths.get(name), key, attacker.pos, Game.time, healerPos);
        if (cached) return { pos: cached, target };
        countStat("military:duoSearch");
        const result = PathFinder.search(attacker.pos, { pos: target.pos, range: 1 }, {
            maxRooms: 1,
            plainCost: 2,
            swampCost: 10,
            roomCallback: roomName => (roomName === room.name ? avoiding(matrix, roomName, healerPos) : false)
        });
        if (!result.path[0]) {
            paths.delete(name);
            return null;
        }
        paths.set(name, newPath(key, attacker.pos, result.path, Game.time, jitter(PATH_TTL)));
        return { pos: result.path[0], target };
    }
    const pos = travelStep(attacker, name, duo.targetRoom, 22, 4000, healerPos);
    return pos ? { pos } : null;
}

/** Last action results of each duo, for the trace */
const actions: Record<string, string> = {};
const previousActions: Record<string, string> = {};

/** Heals the most hurt of the pair; with both full, pre-heals the attacker when damage is coming */
function heal(healer: Creep, attacker: Creep): void {
    const hurt = [attacker, healer].filter(c => c.hits < c.hitsMax).sort((a, b) => hitsRatio(a) - hitsRatio(b));
    const patient = hurt[0] ?? (incomingDamage(attacker.pos) > 0 ? attacker : null);
    if (!patient) return;
    if (healer.pos.isNearTo(patient)) actions[healer.memory.duo ?? ""] = `heal ${healer.heal(patient)}`;
    else if (healer.pos.inRangeTo(patient, 3)) healer.rangedHeal(patient);
}

/**
 * Attack what is adjacent: dangerous creeps first (most threat per hit, defense/threat.ts), then the
 * target, then what blocks the way
 */
function strike(attacker: Creep, step: { pos: RoomPosition; target?: Structure } | null, targetRoom: string): void {
    const fighters = attacker.pos
        .findInRange(FIND_HOSTILE_CREEPS, 1)
        .filter(c => c.body.some(p => p.hits > 0 && (p.type === ATTACK || p.type === RANGED_ATTACK || p.type === HEAL)));
    const enemy = _.max(fighters, c => threatOf(c) / c.hits);
    if (typeof enemy === "object") {
        attacker.attack(enemy);
        return;
    }
    if (step?.target && !isMine(step.target) && attacker.pos.isNearTo(step.target)) {
        // A structure under a rampart can only be hit through the rampart
        const cover = step.target.pos.lookFor(LOOK_STRUCTURES).find(s => s.structureType === STRUCTURE_RAMPART && !(s as StructureRampart).my);
        if (attacker.attack(cover ?? step.target) === OK) countStat("military:attack");
        return;
    }
    const blocker = step && !step.pos.isEqualTo(attacker.pos) ? blockerAt(step.pos, targetRoom) : undefined;
    const code = blocker ? attacker.attack(blocker) : null;
    actions[attacker.memory.duo ?? ""] += ` step ${step?.pos} target ${step?.target?.structureType} blocker ${blocker?.structureType} attack ${code}`;
    if (code === OK) countStat("military:breach");
}

/** Where a creep stepping onto pos ends up: exit tiles carry it to the mirrored tile of the next room */
export function landing(pos: RoomPosition): RoomPosition {
    if (pos.x !== 0 && pos.x !== 49 && pos.y !== 0 && pos.y !== 49) return pos;
    const exits = Game.map.describeExits(pos.roomName) ?? {};
    if (pos.x === 0 && exits[LEFT]) return new RoomPosition(49, pos.y, exits[LEFT]!);
    if (pos.x === 49 && exits[RIGHT]) return new RoomPosition(0, pos.y, exits[RIGHT]!);
    if (pos.y === 0 && exits[TOP]) return new RoomPosition(pos.x, 49, exits[TOP]!);
    if (pos.y === 49 && exits[BOTTOM]) return new RoomPosition(pos.x, 0, exits[BOTTOM]!);
    return pos;
}

/** The healer never steps where it would die within 3 ticks (it stays put instead) */
function moveHealer(healer: Creep, to: RoomPosition, range: number): void {
    const next = healer.pos.roomName === to.roomName && healer.pos.getRangeTo(to) <= range ? healer.pos : to;
    // An exit tile of its own room carries it over; a tile of another room is where it ends up
    const lands = next.roomName === healer.pos.roomName ? landing(next) : next;
    if (!next.isEqualTo(healer.pos) && verdict(healer, lands, [healer]) === "doomed") {
        trafficManager.requestMove(healer, healer.pos, { range: 0, priority: HEALER_PRIORITY });
        return;
    }
    trafficManager.requestMove(healer, to, { range, priority: HEALER_PRIORITY });
}

/**
 * Keeps a creep where it is. On an exit tile outside the target room it steps off the edge instead:
 * the engine carries a creep left there to the next room every tick, so a pair holding on both sides
 * of a border swapped rooms every tick and never met (shard0 W28N5 / W27N5, 2026-10-26)
 */
function hold(creep: Creep, priority: number, targetRoom?: string): void {
    if (onRoomEdge(creep.pos) && creep.room.name !== targetRoom) {
        trafficManager.moveToRoom(creep, creep.room.name, { priority });
    } else {
        trafficManager.requestMove(creep, creep.pos, { range: 0, priority });
    }
}

/** Moves the pair one tile: the attacker to `to` when the healer is next to it, the healer behind */
function movePair(attacker: Creep, healer: Creep, to: RoomPosition | null, solo = false, targetRoom?: string): void {
    const together = attacker.pos.roomName === healer.pos.roomName && attacker.pos.isNearTo(healer);
    if (!together) {
        // Apart: an attacker inside the target room comes back to its healer (tower drain dance),
        // else the healer catches up
        if (attacker.room.name === targetRoom && healer.room.name !== targetRoom) {
            if (verdict(healer, attacker.pos, [healer]) !== "doomed") {
                // Safe in there (towers drained): the attacker frees the entry tile, the healer joins
                const { x, y } = attacker.pos;
                const inward = new RoomPosition(x === 0 ? 1 : x === 49 ? 48 : x, y === 0 ? 1 : y === 49 ? 48 : y, attacker.pos.roomName);
                trafficManager.requestMove(attacker, inward, { range: 0, priority: ATTACKER_PRIORITY });
                moveHealer(healer, attacker.pos, 1);
            } else {
                trafficManager.moveToRoom(attacker, healer.room.name, { priority: ATTACKER_PRIORITY });
                trafficManager.requestMove(healer, healer.pos, { range: 0, priority: HEALER_PRIORITY });
            }
        } else {
            hold(attacker, ATTACKER_PRIORITY, targetRoom);
            moveHealer(healer, attacker.pos, 1);
        }
        return;
    }
    if (solo && to && attacker.fatigue === 0) {
        // The healer can't follow there: the attacker goes alone, the healer holds (`to` is the next
        // tile of a PathFinder path: no second search, see quad.ts travel)
        trafficManager.requestStep(attacker, to, ATTACKER_PRIORITY);
        noteStep(paths.get(attacker.memory.duo ?? ""), attacker.pos, Game.time);
        trafficManager.requestMove(healer, healer.pos, { range: 0, priority: HEALER_PRIORITY });
        return;
    }
    if (!to || to.isEqualTo(attacker.pos) || attacker.fatigue > 0 || healer.fatigue > 0 || blockerAt(to, targetRoom ?? "")) {
        hold(attacker, ATTACKER_PRIORITY, targetRoom);
        hold(healer, HEALER_PRIORITY, targetRoom);
        return;
    }
    trafficManager.requestStep(attacker, to, ATTACKER_PRIORITY);
    noteStep(paths.get(attacker.memory.duo ?? ""), attacker.pos, Game.time);
    // The healer keeps adjacent: it takes the attacker's tile unless it is already next to the new one
    if (healer.pos.isNearTo(to) && to.roomName === healer.pos.roomName) hold(healer, HEALER_PRIORITY, targetRoom);
    else moveHealer(healer, attacker.pos, 0);
}

/** Combat trace: state changes, and every 10 ticks near the target */
function traceDuo(name: string, duo: DuoMemory, attacker: Creep, healer: Creep, state: DuoState): void {
    const engaged = attacker.room.name === duo.targetRoom || healer.room.name === duo.targetRoom;
    const last = (traceDuo as unknown as { last?: Record<string, string> }).last ?? {};
    (traceDuo as unknown as { last: Record<string, string> }).last = last;
    if (last[name] === state && !(engaged && Game.time % 10 === 0)) return;
    last[name] = state;
    log.info(
        "Duo",
        `${name} ${state}: A ${attacker.pos} ${attacker.hits}/${attacker.hitsMax} dmg ${Math.round(incomingDamage(attacker.pos))}`,
        `H ${healer.pos} ${healer.hits}/${healer.hitsMax} dmg ${Math.round(incomingDamage(healer.pos))} | last tick: ${previousActions[name] ?? ""}`
    );
}

/** Records the duo's new members and counts the ones lost since the last tick */
function trackMembers(name: string, duo: DuoMemory, attacker: Creep | undefined, healer: Creep | undefined): void {
    for (const member of [attacker, healer]) if (member && !duo.members.includes(member.name)) duo.members.push(member.name);
    for (const member of duo.members) {
        if (Game.creeps[member]) continue;
        duo.losses++;
        countStat("military:lost");
        log.info("Duo", `${name}: lost ${member} (state ${duo.state})`);
    }
    duo.members = duo.members.filter(m => Game.creeps[m]);
}

/**
 * An advancing attacker standing still outside the target room (shard0 W29N3: 5-47 moves per 1000
 * ticks while its healer moved ~900): its path is dropped and searched again
 */
function dropStuckPath(name: string, attacker: Creep, targetRoom: string): void {
    if (attacker.room.name === targetRoom) return;
    const state = still.get(name) ?? { pos: "", since: Game.time, seen: Game.time };
    still.set(name, state);
    if (stillFor(state, attacker.pos, Game.time, STILL_TICKS)) {
        countStat("military:duoStuck");
        paths.delete(name);
    }
}

/** Runs a duo for one tick */
export function runDuo(name: string, duo: DuoMemory): void {
    previousActions[name] = actions[name] ?? "";
    actions[name] = "";
    const { attacker, healer } = members(name);
    trackMembers(name, duo, attacker, healer);

    // A member getting boosted at the labs (CreepRunner moves it): the duo waits (timeout in labs/boosts.ts)
    if ((attacker && needsBoosting(attacker)) || (healer && needsBoosting(healer))) {
        duo.state = "forming";
        return;
    }

    if (!attacker || !healer) {
        // Alone: leave the target room and wait for the partner at home
        duo.state = "forming";
        const lone = attacker ?? healer;
        if (!lone) return;
        trafficManager.moveToRoom(lone, lone.room.name === duo.targetRoom ? duo.stagingRoom : duo.spawnRoom, { priority: 0 });
        if (healer && healer.hits < healer.hitsMax) healer.heal(healer);
        return;
    }

    heal(healer, attacker);
    const before = duo.state;
    traceDuo(name, duo, attacker, healer, before);
    if (duo.state === "forming") {
        if (attacker.pos.roomName === healer.pos.roomName && attacker.pos.isNearTo(healer)) duo.state = "advance";
        movePair(attacker, healer, null);
        return;
    }

    const weakest = Math.min(hitsRatio(attacker), hitsRatio(healer));
    if (duo.state === "retreat") {
        if (weakest >= READY_HITS) duo.state = "advance";
        else {
            const out = attacker.room.name === duo.targetRoom || onRoomEdge(attacker.pos);
            // PathFinder's default maxOps (2000), as before the cache
            const to = out ? travelStep(attacker, name, duo.stagingRoom, 20, 2000, healer.pos) : null;
            movePair(attacker, healer, to, false, duo.targetRoom);
            return;
        }
    }

    dropStuckPath(name, attacker, duo.targetRoom);
    prune();
    const step = nextStep(attacker, name, duo, healer.pos);
    strike(attacker, step, duo.targetRoom);
    if (weakest < RETREAT_HITS) {
        duo.state = "retreat";
        countStat("military:retreat");
        movePair(attacker, healer, null, false, duo.targetRoom);
        return;
    }
    if (step && !step.pos.isEqualTo(attacker.pos)) {
        // Survival gate on the tiles they really land on: the attacker may not step onto a tile that
        // kills it within 3 ticks; when only the healer would be doomed, the attacker goes alone
        const healers = [healer];
        if (verdict(attacker, landing(step.pos), healers) === "doomed") {
            countStat("military:hold");
            movePair(attacker, healer, null, false, duo.targetRoom);
            return;
        }
        if (verdict(healer, landing(attacker.pos), healers) === "doomed") {
            countStat("military:solo");
            movePair(attacker, healer, step.pos, true, duo.targetRoom);
            return;
        }
    }
    movePair(attacker, healer, step?.pos ?? null, false, duo.targetRoom);
}
