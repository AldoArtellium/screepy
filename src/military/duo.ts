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
import { trafficManager } from "../modules/TrafficManager";
import { log } from "../utils/logger";
import { countStat } from "../utils/stats";
import { incomingDamage, verdict } from "./combat";

export const DUO_ATTACKER = "duoAttacker";
export const DUO_HEALER = "duoHealer";

export type DuoState = "forming" | "advance" | "retreat";

export interface DuoMemory {
    spawnRoom: string;
    targetRoom: string;
    state: DuoState;
    /** Room just before the target on the route: where the duo heals up */
    stagingRoom: string;
    /** Members seen alive (to count losses) */
    members: string[];
    losses: number;
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
const TARGET_ORDER: StructureConstant[] = [STRUCTURE_TOWER, STRUCTURE_INVADER_CORE, STRUCTURE_SPAWN, STRUCTURE_EXTENSION, STRUCTURE_STORAGE, STRUCTURE_TERMINAL];
const IGNORED: StructureConstant[] = [STRUCTURE_CONTROLLER, STRUCTURE_RAMPART, STRUCTURE_WALL, STRUCTURE_ROAD, STRUCTURE_CONTAINER, STRUCTURE_EXTRACTOR, STRUCTURE_KEEPER_LAIR, STRUCTURE_PORTAL];

function hitsRatio(creep: Creep): number {
    return creep.hits / creep.hitsMax;
}

function members(name: string): { attacker?: Creep; healer?: Creep } {
    const all = duoCreeps(name).filter(c => !c.spawning);
    return { attacker: all.find(c => c.memory.role === DUO_ATTACKER), healer: all.find(c => c.memory.role === DUO_HEALER) };
}

/** Structure a squad goes for in the target room: towers, the invader core, spawns, then the rest */
export function pickTarget(room: Room, from: RoomPosition): Structure | null {
    const hostile = room.find(FIND_HOSTILE_STRUCTURES).filter(s => !IGNORED.includes(s.structureType));
    for (const type of TARGET_ORDER) {
        const target = from.findClosestByRange(hostile.filter(s => s.structureType === type));
        if (target) return target;
    }
    return from.findClosestByRange(hostile);
}

/** Ramparts and walls cost by their hits (the path goes through the weakest), other obstacles block */
function breachMatrix(room: Room, target: Structure): CostMatrix {
    const matrix = new PathFinder.CostMatrix();
    for (const s of room.find(FIND_STRUCTURES)) {
        if (s.id === target.id) continue;
        if (s.structureType === STRUCTURE_ROAD) {
            if (matrix.get(s.pos.x, s.pos.y) === 0) matrix.set(s.pos.x, s.pos.y, 1);
        } else if (s.structureType === STRUCTURE_RAMPART) {
            const rampart = s as StructureRampart;
            if (rampart.my || rampart.isPublic) continue;
            matrix.set(s.pos.x, s.pos.y, Math.min(250, 20 + Math.floor(s.hits / 2000)));
        } else if (s.structureType === STRUCTURE_WALL) {
            matrix.set(s.pos.x, s.pos.y, Math.min(250, 20 + Math.floor(s.hits / 2000)));
        } else if ((OBSTACLE_OBJECT_TYPES as string[]).includes(s.structureType)) {
            matrix.set(s.pos.x, s.pos.y, 255);
        }
    }
    return matrix;
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

/** Rooms on the way: structures that block movement, roads cheap (no creeps: the pair moves through traffic) */
const travelMatrices: Map<string, { tick: number; matrix: CostMatrix }> = new Map();
function avoiding(matrix: CostMatrix | boolean, roomName: string, avoid?: RoomPosition): CostMatrix | boolean {
    if (!avoid || avoid.roomName !== roomName || typeof matrix === "boolean") return matrix;
    const copy = matrix.clone();
    copy.set(avoid.x, avoid.y, 255);
    return copy;
}

export function travelMatrix(roomName: string): CostMatrix | boolean {
    const room = Game.rooms[roomName];
    if (!room) return true;
    const cached = travelMatrices.get(roomName);
    if (cached && Game.time - cached.tick < 20) return cached.matrix;
    const matrix = new PathFinder.CostMatrix();
    for (const s of room.find(FIND_STRUCTURES)) {
        if (s.structureType === STRUCTURE_ROAD) {
            if (matrix.get(s.pos.x, s.pos.y) === 0) matrix.set(s.pos.x, s.pos.y, 1);
        } else if (s.structureType === STRUCTURE_RAMPART) {
            if (!isMine(s) && !(s as StructureRampart).isPublic) matrix.set(s.pos.x, s.pos.y, 255);
        } else if ((OBSTACLE_OBJECT_TYPES as string[]).includes(s.structureType)) {
            matrix.set(s.pos.x, s.pos.y, 255);
        }
    }
    travelMatrices.set(roomName, { tick: Game.time, matrix });
    return matrix;
}

/** Next tile of the attacker towards its goal (null: there, or no path) */
function nextStep(attacker: Creep, duo: DuoMemory, healerPos?: RoomPosition): { pos: RoomPosition; target?: Structure } | null {
    const room = attacker.room;
    if (room.name === duo.targetRoom) {
        const target = pickTarget(room, attacker.pos);
        if (!target) return null;
        if (attacker.pos.isNearTo(target)) return { pos: attacker.pos, target };
        const matrix = breachMatrix(room, target);
        const result = PathFinder.search(attacker.pos, { pos: target.pos, range: 1 }, {
            maxRooms: 1,
            plainCost: 2,
            swampCost: 10,
            roomCallback: name => (name === room.name ? avoiding(matrix, name, healerPos) : false)
        });
        return result.path[0] ? { pos: result.path[0], target } : null;
    }
    const goal = new RoomPosition(25, 25, duo.targetRoom);
    const result = PathFinder.search(attacker.pos, { pos: goal, range: 22 }, {
        plainCost: 2,
        swampCost: 10,
        maxOps: 4000,
        roomCallback: name => avoiding(travelMatrix(name), name, healerPos)
    });
    return result.path[0] ? { pos: result.path[0] } : null;
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

/** Attack what is adjacent: dangerous creeps first, then the target, then what blocks the way */
function strike(attacker: Creep, step: { pos: RoomPosition; target?: Structure } | null, targetRoom: string): void {
    const enemy = attacker.pos
        .findInRange(FIND_HOSTILE_CREEPS, 1)
        .find(c => c.body.some(p => p.hits > 0 && (p.type === ATTACK || p.type === RANGED_ATTACK || p.type === HEAL)));
    if (enemy) {
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
            trafficManager.requestMove(attacker, attacker.pos, { range: 0, priority: ATTACKER_PRIORITY });
            moveHealer(healer, attacker.pos, 1);
        }
        return;
    }
    if (solo && to && attacker.fatigue === 0) {
        // The healer can't follow there: the attacker goes alone, the healer holds
        trafficManager.requestMove(attacker, to, { range: 0, priority: ATTACKER_PRIORITY });
        trafficManager.requestMove(healer, healer.pos, { range: 0, priority: HEALER_PRIORITY });
        return;
    }
    if (!to || to.isEqualTo(attacker.pos) || attacker.fatigue > 0 || healer.fatigue > 0 || blockerAt(to, targetRoom ?? "")) {
        trafficManager.requestMove(attacker, attacker.pos, { range: 0, priority: ATTACKER_PRIORITY });
        trafficManager.requestMove(healer, healer.pos, { range: 0, priority: HEALER_PRIORITY });
        return;
    }
    trafficManager.requestMove(attacker, to, { range: 0, priority: ATTACKER_PRIORITY });
    // The healer keeps adjacent: it takes the attacker's tile unless it is already next to the new one
    if (healer.pos.isNearTo(to) && to.roomName === healer.pos.roomName) trafficManager.requestMove(healer, healer.pos, { range: 0, priority: HEALER_PRIORITY });
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

/** Runs a duo for one tick */
export function runDuo(name: string, duo: DuoMemory): void {
    previousActions[name] = actions[name] ?? "";
    actions[name] = "";
    const { attacker, healer } = members(name);
    for (const member of [attacker, healer]) if (member && !duo.members.includes(member.name)) duo.members.push(member.name);
    for (const member of duo.members) {
        if (Game.creeps[member]) continue;
        duo.losses++;
        countStat("military:lost");
        log.info("Duo", `${name}: lost ${member} (state ${duo.state})`);
    }
    duo.members = duo.members.filter(m => Game.creeps[m]);

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
            const out = attacker.room.name === duo.targetRoom || attacker.pos.x === 0 || attacker.pos.y === 0 || attacker.pos.x === 49 || attacker.pos.y === 49;
            const result = out
                ? PathFinder.search(attacker.pos, { pos: new RoomPosition(25, 25, duo.stagingRoom), range: 20 }, {
                      plainCost: 2,
                      swampCost: 10,
                      roomCallback: name => avoiding(travelMatrix(name), name, healer.pos)
                  })
                : null;
            movePair(attacker, healer, result?.path[0] ?? null, false, duo.targetRoom);
            return;
        }
    }

    const step = nextStep(attacker, duo, healer.pos);
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
