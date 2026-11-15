/**
 * Incoming nukes in our rooms (FIND_NUKES), on top of the pure rules of ./nukeDefense.ts:
 * - ramparts over the valued structures in the radius (RoomBuilder `nukeRampartPositions`), repaired up to the
 *   damage by the builders first (`nukeRampartTarget`), with the builder WORK it takes (`nukeRepairWork`);
 * - no construction site in the radius, none at all right before the impact (`nukeSiteAllowed`);
 * - no spawn right before the impact (`nukeHoldsSpawn`), every creep out of the room in time and kept off the
 *   neighbour rooms' border until the impact (`evacuateFromNukes`, CreepRunner).
 * Not in Hivemind (it only skips some construction sites within range 2 of a nuke).
 */

import { effectiveEnergy, tickCache } from "../core/roomState";
import { trafficManager } from "../modules/TrafficManager";
import { log } from "../utils/logger";
import { countStat } from "../utils/stats";
import {
    BORDER_GUARD_RANGE,
    BORDER_GUARD_TICKS,
    evacuationTicks,
    NukeDefensePlan,
    NukeInput,
    planNukeDefense,
    repairWork,
    siteAllowed,
    SPAWN_HOLD_TICKS,
    STRUCTURE_WORTH,
    ticksPerTile
} from "./nukeDefense";

/** Energy kept for the spawns while the ramparts are pumped */
const ENERGY_RESERVE = 20000;
/** Income counted on top of the stock until the impact (energy per tick, a low guess for an RCL 6+ room) */
const INCOME_PER_TICK = 10;
/** The plan is recomputed this often (rampart hits move slowly) */
const PLAN_TTL = 25;

/** Incoming nukes of an owned (visible) room */
export function incomingNukes(room: Room): NukeInput[] {
    return tickCache(`nukes:${room.name}`, () =>
        room.find(FIND_NUKES).map(n => ({ x: n.pos.x, y: n.pos.y, timeToLand: n.timeToLand }))
    );
}

/** Our rooms with an incoming nuke (every tick) and the targets of our own nukes in flight */
function nukedRooms(): Map<string, number> {
    return tickCache("nukedRooms", () => {
        const rooms = new Map<string, number>();
        for (const name in Game.rooms) {
            const room = Game.rooms[name];
            if (!room.controller?.my) continue;
            const nukes = incomingNukes(room);
            if (nukes.length > 0) rooms.set(name, Math.min(...nukes.map(n => n.timeToLand)));
        }
        // Our own nukes in flight (military/nukeStrike.ts): our squads keep out of the target until it lands
        for (const room in Memory.military?.nukes ?? {}) {
            const timeToLand = Memory.military!.nukes![room].landTime - Game.time;
            if (timeToLand >= 0 && !rooms.has(room)) rooms.set(room, timeToLand);
        }
        return rooms;
    });
}

interface CachedPlan {
    plan: NukeDefensePlan;
    key: string;
    until: number;
}

const plans = new Map<string, CachedPlan>();
const notified = new Set<string>();

/** Rampart plan of a room with incoming nukes, null without */
export function nukePlan(room: Room): NukeDefensePlan | null {
    return tickCache(`nukePlan:${room.name}`, () => computePlan(room));
}

/** Cached PLAN_TTL ticks per set of nukes; the entry outlives them until nukeDefenseModule reports the impact */
function computePlan(room: Room): NukeDefensePlan | null {
    const nukes = incomingNukes(room);
    if (nukes.length === 0) return null;
    const key = room.find(FIND_NUKES).map(n => n.id).sort().join(",");
    const cached = plans.get(room.name);
    if (cached && cached.key === key && cached.until > Game.time) return cached.plan;
    const structures: { x: number; y: number; type: string }[] = [];
    const ramparts: { x: number; y: number; hits: number }[] = [];
    for (const s of room.find(FIND_MY_STRUCTURES)) {
        if (s.structureType === STRUCTURE_RAMPART) ramparts.push({ x: s.pos.x, y: s.pos.y, hits: s.hits });
        else if (STRUCTURE_WORTH[s.structureType]) structures.push({ x: s.pos.x, y: s.pos.y, type: s.structureType });
    }
    const rcl = room.controller?.level ?? 0;
    const timeToLand = Math.min(...nukes.map(n => n.timeToLand));
    const budget = Math.max(0, effectiveEnergy(room) - ENERGY_RESERVE) + INCOME_PER_TICK * timeToLand;
    const plan = planNukeDefense(nukes, structures, ramparts, RAMPART_HITS_MAX[rcl] ?? 0, budget);
    plans.set(room.name, { plan, key, until: Game.time + PLAN_TTL });
    if (!notified.has(key)) {
        notified.add(key);
        const what = (tiles: typeof plan.protect) => tiles.map(t => `${t.types.join("+")}@${t.x},${t.y}`).join(" ") || "-";
        const message =
            `${nukes.length} nuke(s) incoming in ${room.name}, first landing in ${timeToLand} ticks: ` +
            `protecting ${what(plan.protect)} (${Math.round(plan.deficit / 1000)}k hits to repair), abandoning ${what(plan.abandon)}`;
        log.warn("Nukes", message);
        Game.notify(message);
        countStat("nuke:incoming", nukes.length);
    }
    return plan;
}

/** Tiles that need a rampart (RoomBuilder) */
export function nukeRampartPositions(room: Room): RoomPosition[] {
    const plan = nukePlan(room);
    if (!plan) return [];
    return plan.protect.map(t => new RoomPosition(t.x, t.y, room.name));
}

/** Hits a rampart is repaired up to before the impact, undefined when no nuke threatens its tile */
export function nukeRampartTarget(structure: Structure): number | undefined {
    if (structure.structureType !== STRUCTURE_RAMPART) return undefined;
    const plan = nukePlan(structure.room);
    if (!plan) return undefined;
    return plan.protect.find(t => t.x === structure.pos.x && t.y === structure.pos.y)?.needed;
}

/** Builder WORK parts the ramparts still need before the impact (0 without nuke) */
export function nukeRepairWork(room: Room): number {
    const plan = nukePlan(room);
    if (!plan) return 0;
    return repairWork(plan.deficit, plan.timeToLand - SPAWN_HOLD_TICKS);
}

/** Whether a construction site may be placed at `pos` */
export function nukeSiteAllowed(pos: RoomPosition, type: BuildableStructureConstant): boolean {
    const room = Game.rooms[pos.roomName];
    if (!room) return true;
    return siteAllowed(incomingNukes(room), pos.x, pos.y, type === STRUCTURE_RAMPART);
}

/** No spawning: a creep spawned now could not leave before the impact */
export function nukeHoldsSpawn(room: Room): boolean {
    const timeToLand = nukedRooms().get(room.name);
    if (timeToLand === undefined || timeToLand > SPAWN_HOLD_TICKS) return false;
    countStat("nuke:spawnHold");
    return true;
}

/** Tiles to the closest edge with an exit (no path search) */
function rangeToExit(pos: RoomPosition): number {
    const exits = Game.map.describeExits(pos.roomName) ?? {};
    const ranges: number[] = [];
    if (exits[TOP]) ranges.push(pos.y);
    if (exits[BOTTOM]) ranges.push(49 - pos.y);
    if (exits[LEFT]) ranges.push(pos.x);
    if (exits[RIGHT]) ranges.push(49 - pos.x);
    return ranges.length > 0 ? Math.min(...ranges) : 25;
}

/** Exit tile each evacuating creep heads for (heap) */
const evacuationExits = new Map<string, RoomPosition>();

function leaveRoom(creep: Creep): void {
    let exit = evacuationExits.get(creep.name);
    if (!exit || exit.roomName !== creep.room.name) {
        exit = creep.pos.findClosestByPath(FIND_EXIT) ?? creep.pos.findClosestByRange(FIND_EXIT) ?? undefined;
        if (!exit) return;
        evacuationExits.set(creep.name, exit);
    }
    trafficManager.requestMove(creep, exit, { range: 0, priority: 0 });
}

/** Side of a neighbour room that borders `nuked`, as the tile range to it */
function rangeToBorder(pos: RoomPosition, nuked: string): number | null {
    const exits = Game.map.describeExits(pos.roomName) ?? {};
    if (exits[TOP] === nuked) return pos.y;
    if (exits[BOTTOM] === nuked) return 49 - pos.y;
    if (exits[LEFT] === nuked) return pos.x;
    if (exits[RIGHT] === nuked) return 49 - pos.x;
    return null;
}

/**
 * Takes over a creep that must get out of a nuked room in time (every creep in the room dies at impact) or
 * keep off the border of a room about to be hit. True when the creep was handled this tick.
 */
export function evacuateFromNukes(creep: Creep): boolean {
    const rooms = nukedRooms();
    if (rooms.size === 0) {
        if (evacuationExits.size > 0) evacuationExits.clear();
        return false;
    }
    const here = rooms.get(creep.room.name);
    if (here !== undefined) {
        const range = rangeToExit(creep.pos);
        // Upper bound first (a single MOVE part): most ticks of the flight end here without counting parts
        if (here > evacuationTicks(range, creep.body.length)) return false;
        const move = creep.getActiveBodyparts(MOVE);
        if (here > evacuationTicks(range, ticksPerTile(move, creep.body.length - move))) return false;
        leaveRoom(creep);
        countStat("nuke:evacuate");
        return true;
    }
    for (const [nuked, timeToLand] of rooms) {
        if (timeToLand > BORDER_GUARD_TICKS) continue;
        const range = rangeToBorder(creep.pos, nuked);
        if (range === null || range > BORDER_GUARD_RANGE) continue;
        trafficManager.requestMove(creep, new RoomPosition(25, 25, creep.room.name), { range: 22, priority: 0 });
        countStat("nuke:borderGuard");
        return true;
    }
    return false;
}

/** Logs the outcome once a nuke landed: what was protected, what is gone */
export function nukeDefenseModule(): void {
    for (const name of nukedRooms().keys()) if (Game.rooms[name]?.controller?.my) nukePlan(Game.rooms[name]);
    for (const [name, cached] of plans) {
        const room = Game.rooms[name];
        if (room && incomingNukes(room).length > 0) continue;
        plans.delete(name);
        if (!room) continue;
        const lost = cached.plan.protect.filter(t => !room.lookForAt(LOOK_STRUCTURES, t.x, t.y).some(s => t.types.includes(s.structureType)));
        log.warn("Nukes", `${name}: impact over, ${cached.plan.protect.length - lost.length}/${cached.plan.protect.length} protected tiles kept`);
        countStat("nuke:landed");
        if (lost.length > 0) countStat("nuke:protectedLost", lost.length);
    }
}
