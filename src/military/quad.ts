/**
 * Quad: four creeps in a 2x2 formation moving as one (two melee attackers in front, two healers
 * behind). Our design, after Harabi's quad posts (2x2 cost matrix, same direction for all) and
 * The International / Overmind quads for the ideas (pre-heal, mass attack).
 *
 * States: forming (gather at home until the four are out) -> travel (loose chain, the leader waits
 * for the others) -> drain (towers left: one member bounces on the border tile while the others heal
 * it, until the towers are seen empty; skipped when the quad's boosted healing covers the towers on
 * its front, canTank: towers a player refills are never seen empty) -> engage (in the target room:
 * pack into the 2x2 block, then
 * step as one) -> retreat (packed while away from the border, to a rally point in the staging room,
 * below 60% hits or when a member could not walk out under the net damage) -> travel again once
 * everyone is healed to 95%. A quad that lost a healer or two members goes home
 * to be refilled.
 *
 * Packed movement: the path is computed for the top-left tile (anchor) on a cost matrix where each
 * tile costs the most expensive tile of its 2x2 block, structures costing the ticks our squad needs
 * to break them (so the path goes through the weakest rampart); all four step in the same direction,
 * nobody moves while one is fatigued, and when the next block holds a rampart or wall, the quad
 * holds and breaks it. While holding, members swap tiles: attackers next to the focus, the member
 * with the most hits on the most exposed tile.
 */

import { quadCreeps } from "../core/roomState";
import { threatOf } from "../defense/threat";
import { needsBoosting } from "../labs/boosts";
import { trafficManager } from "../modules/TrafficManager";
import { log } from "../utils/logger";
import { parseRoomName } from "../utils/rooms";
import { countStat } from "../utils/stats";
import {
    attackPower,
    availableHealing,
    canTank,
    damageMultiplier,
    enemyTowers,
    healPower,
    incomingDamage,
    towerPower,
    verdict
} from "./combat";
import { isMine, landing, pickTarget, travelCallback } from "./duo";
import { hostileRoom } from "./intel";

export const QUAD_ATTACKER = "quadAttacker";
export const QUAD_HEALER = "quadHealer";
/** Spawn order and formation order (attackers lead) */
export const QUAD_ROSTER = [QUAD_HEALER, QUAD_HEALER, QUAD_ATTACKER, QUAD_ATTACKER];

export type QuadState = "forming" | "travel" | "drain" | "engage" | "retreat";

export interface QuadMemory {
    spawnRoom: string;
    targetRoom: string;
    /** Room just before the target on the route: where the quad heals up */
    stagingRoom: string;
    state: QuadState;
    /** Members seen alive (to count losses) */
    members: string[];
    losses: number;
    /** Top-left tile of the formation, and since when the quad tries to pack there */
    anchor?: { x: number; y: number; room: string; since: number };
    /** Where the quad heals up: a few tiles inside the staging room, next to the exit it took */
    rally?: { x: number; y: number; room: string };
    /** The target's towers were seen empty since the last retreat (no more draining from the border) */
    drained?: boolean;
    /** Member bouncing on the border to drain the towers */
    poker?: string;
}

declare global {
    interface CreepMemory {
        /** Quad the creep belongs to */
        quad?: string;
        /** Tile of the creep in the 2x2 block (0 top-left, 1 top-right, 2 bottom-left, 3 bottom-right) */
        slot?: number;
    }
}

const SLOTS: [number, number][] = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1]
];
const RETREAT_HITS = 0.6;
/** While retreating packed, the member on the most exposed tile swaps out below this share of hits */
const RETREAT_SWAP_HITS = 0.5;
/** A member pokes from this share of its hits */
const DRAIN_READY = 0.9;
/** Ticks of net damage a member must be able to take on top of its walk to the exit */
const ESCAPE_MARGIN = 3;
const READY_HITS = 0.95;
/** Ticks to pack before looking for another block */
const PACK_TIMEOUT = 12;
/** A follower farther than this from the one before stops the leader */
const COHESION = 2;
const PRIORITY = 0;
/** A swap must lower the formation cost by this much */
const SWAP_GAIN = 5;
const MELEE_MISPLACED = 50;
/** Range searched around the anchor for a better tower drain spot */
const DRAIN_SEARCH = 8;
/** A drain spot must save this much tower damage to be worth moving to */
const DRAIN_GAIN = 30;

const RANGED_MASS = [10, 10, 4, 1];

function hitsRatio(creep: Creep): number {
    return creep.hits / creep.hitsMax;
}

function parts(creep: Creep, type: BodyPartConstant): number {
    return creep.body.filter(p => p.type === type && p.hits > 0).length;
}

/** Range across room borders (world coordinates) */
function worldRange(a: RoomPosition, b: RoomPosition): number {
    if (a.roomName === b.roomName) return a.getRangeTo(b);
    const ra = parseRoomName(a.roomName);
    const rb = parseRoomName(b.roomName);
    if (!ra || !rb) return Infinity;
    return Math.max(Math.abs(ra.wx * 50 + a.x - rb.wx * 50 - b.x), Math.abs(ra.wy * 50 + a.y - rb.wy * 50 - b.y));
}

function slotPos(anchor: { x: number; y: number }, roomName: string, slot: number): RoomPosition {
    return new RoomPosition(anchor.x + SLOTS[slot][0], anchor.y + SLOTS[slot][1], roomName);
}

/** Alive members, attackers first (the leader is an attacker while one lives) */
function members(name: string): Creep[] {
    const roleOrder = (c: Creep) => (c.memory.role === QUAD_ATTACKER ? 0 : 1);
    return quadCreeps(name)
        .filter(c => !c.spawning)
        .sort((a, b) => roleOrder(a) - roleOrder(b) || a.name.localeCompare(b.name));
}

function hold(creep: Creep): void {
    trafficManager.requestMove(creep, creep.pos, { range: 0, priority: PRIORITY });
}

/** Damage share the front takes: the attackers' (they lead and stand next to the focus), else 1 */
function frontMultiplier(group: Creep[]): number {
    const attackers = group.filter(c => c.memory.role === QUAD_ATTACKER);
    return attackers.length ? Math.max(...attackers.map(c => damageMultiplier(c.body))) : 1;
}

/** Boosted enough to out-heal the target's towers on its front: no border drain (combat.ts canTank) */
function tanksTowers(group: Creep[], quad: QuadMemory): boolean {
    const room = Game.rooms[quad.targetRoom];
    const towers = room ? enemyTowers(room).length : (hostileRoom(quad.targetRoom)?.towers ?? 1);
    return canTank(_.sum(group, c => healPower(c.body)), towers, frontMultiplier(group));
}

// ---------------------------------------------------------------- damage model

interface DamageSource {
    pos: RoomPosition;
    /** Damage on a creep at a given range */
    damage: (range: number) => number;
    /** Only hits creeps within this range (towers: whole room) */
    reach: number;
}

function damageSources(room: Room): DamageSource[] {
    const sources: DamageSource[] = enemyTowers(room).map(t => ({
        pos: t.pos,
        damage: (r: number) => TOWER_POWER_ATTACK * towerPower(r),
        reach: 50
    }));
    for (const enemy of room.find(FIND_HOSTILE_CREEPS)) {
        const melee = parts(enemy, ATTACK) * ATTACK_POWER;
        const ranged = parts(enemy, RANGED_ATTACK) * RANGED_ATTACK_POWER;
        if (melee) sources.push({ pos: enemy.pos, damage: () => melee, reach: 2 });
        if (ranged) sources.push({ pos: enemy.pos, damage: () => ranged, reach: 4 });
    }
    return sources;
}

/**
 * Damage each tile of a set is expected to take next tick: every source hits the closest tile
 * (towers and invaders shoot the closest creep), ties shared.
 */
function exposure(tiles: RoomPosition[], room: Room | undefined): number[] {
    const result = tiles.map(() => 0);
    if (!room) return result;
    for (const source of damageSources(room)) {
        const ranges = tiles.map(t => (t.roomName === room.name ? source.pos.getRangeTo(t) : Infinity));
        const min = Math.min(...ranges);
        if (min > source.reach) continue;
        const closest = ranges.map((r, i) => (r === min ? i : -1)).filter(i => i >= 0);
        for (const i of closest) result[i] += source.damage(min) / closest.length;
    }
    return result;
}

// ---------------------------------------------------------------- healing and attacks

/** Members that used their ranged slot this tick (rangedHeal and rangedAttack exclude each other) */
const rangedUsed: Set<string> = new Set();

/**
 * Each healer heals the member with the lowest expected hits (hits minus the damage expected on its
 * tile next tick), then counts its healing in: pre-heals before the damage lands, spreads healing
 * when several are hit (Harabi's quad tutorial).
 */
function healQuad(group: Creep[]): void {
    const expected = new Map<string, number>();
    for (const roomName of _.uniq(group.map(c => c.pos.roomName))) {
        const inRoom = group.filter(c => c.pos.roomName === roomName);
        const damage = exposure(
            inRoom.map(c => c.pos),
            Game.rooms[roomName]
        );
        inRoom.forEach((c, i) => expected.set(c.name, c.hits - damage[i] * damageMultiplier(c.body)));
    }
    for (const healer of group) {
        // Boosts included: an XLHO2 healer heals 4 times as much
        const power = healPower(healer.body);
        if (!power) continue;
        const patients = group.filter(c => c.pos.roomName === healer.pos.roomName && c.pos.inRangeTo(healer, 3));
        const patient = _.min(patients, c => expected.get(c.name)! / c.hitsMax);
        if (!patient || typeof patient !== "object" || expected.get(patient.name)! >= patient.hitsMax) continue;
        if (healer.pos.isNearTo(patient)) {
            healer.heal(patient);
            expected.set(patient.name, expected.get(patient.name)! + power);
        } else {
            healer.rangedHeal(patient);
            rangedUsed.add(healer.name);
            expected.set(patient.name, expected.get(patient.name)! + (power * RANGED_HEAL_POWER) / HEAL_POWER);
        }
    }
}

/** What to hit through: the rampart covering a structure, else the structure */
function cover(target: Structure): Structure {
    return target.pos.lookFor(LOOK_STRUCTURES).find(s => s.structureType === STRUCTURE_RAMPART && !isMine(s)) ?? target;
}

function isFighter(creep: Creep): boolean {
    return creep.body.some(p => p.hits > 0 && (p.type === ATTACK || p.type === RANGED_ATTACK || p.type === HEAL));
}

/**
 * Attackers hit an adjacent fighter (most threat per hit, defense/threat.ts), else the focus, else the weakest adjacent hostile structure; healers with ranged parts pick a mass attack
 * when it deals more than a single shot (several hostiles close by), else shoot a fighter, the focus,
 * or any hostile in range.
 */
function attackQuad(group: Creep[], focus: Structure | null): void {
    for (const creep of group) {
        const hostiles = creep.room.find(FIND_HOSTILE_CREEPS);
        if (parts(creep, ATTACK)) {
            const enemy = _.max(
                hostiles.filter(c => creep.pos.isNearTo(c) && isFighter(c)),
                c => threatOf(c) / c.hits
            );
            const adjacent = _.min(
                creep.pos.findInRange(FIND_HOSTILE_STRUCTURES, 1).filter(s => s.structureType !== STRUCTURE_CONTROLLER),
                s => s.hits
            );
            const fallback = typeof adjacent === "object" ? adjacent : null;
            const target =
                typeof enemy === "object" ? enemy : focus && creep.pos.isNearTo(focus) ? cover(focus) : fallback;
            if (target && creep.attack(target) === OK && !(target instanceof Creep)) countStat("military:attack");
            continue;
        }
        const ranged = parts(creep, RANGED_ATTACK);
        if (!ranged || rangedUsed.has(creep.name)) continue;
        const inRange = hostiles.filter(c => creep.pos.inRangeTo(c, 3));
        const structures = creep.pos
            .findInRange(FIND_HOSTILE_STRUCTURES, 3)
            .filter(s => s.structureType !== STRUCTURE_CONTROLLER);
        // Mass attack: every hostile creep, and every hostile structure not under a rampart (the rampart takes it)
        const covered = new Set(
            structures.filter(s => s.structureType === STRUCTURE_RAMPART).map(s => s.pos.y * 50 + s.pos.x)
        );
        let mass = _.sum(inRange, c => RANGED_MASS[creep.pos.getRangeTo(c)]);
        mass += _.sum(structures, s =>
            s.structureType !== STRUCTURE_RAMPART && covered.has(s.pos.y * 50 + s.pos.x)
                ? 0
                : RANGED_MASS[creep.pos.getRangeTo(s)]
        );
        const fighter = _.max(inRange.filter(isFighter), c => threatOf(c) / c.hits);
        const single: Creep | Structure | null =
            typeof fighter === "object"
                ? fighter
                : focus && creep.pos.inRangeTo(focus, 3)
                  ? cover(focus)
                  : (inRange[0] ?? null);
        if (mass > RANGED_ATTACK_POWER) creep.rangedMassAttack();
        else if (single) creep.rangedAttack(single);
    }
}

// ---------------------------------------------------------------- cost matrices

/** Structure damage per tick of the quad, boosts included (ticks to break a tile = hits / dps) */
function structureDps(group: Creep[]): number {
    return Math.max(
        1,
        _.sum(group, c => attackPower(c.body))
    );
}

/** Breakable hostile structures and walls on a tile block; everything else that blocks is 255 */
function isBarrier(s: Structure): boolean {
    if (s.structureType === STRUCTURE_RAMPART) return !isMine(s) && !(s as StructureRampart).isPublic;
    return s.structureType === STRUCTURE_WALL || (OBSTACLE_OBJECT_TYPES as string[]).includes(s.structureType);
}

const UNBREAKABLE: StructureConstant[] = [
    STRUCTURE_CONTROLLER,
    STRUCTURE_KEEPER_LAIR,
    STRUCTURE_PORTAL,
    STRUCTURE_POWER_BANK
];

const matrices: Map<string, { tick: number; base: CostMatrix; block: CostMatrix }> = new Map();

/**
 * Cost of each tile for one creep (base) and for the formation anchored there (block: the most
 * expensive tile of the 2x2 block, 255 where the block would touch an exit).
 */
function quadMatrices(room: Room, dps: number): { base: CostMatrix; block: CostMatrix } {
    const cached = matrices.get(room.name);
    if (cached && cached.tick === Game.time) return cached;
    const terrain = room.getTerrain();
    const base = new PathFinder.CostMatrix();
    for (let x = 0; x < 50; x++) {
        for (let y = 0; y < 50; y++) {
            const t = terrain.get(x, y);
            base.set(x, y, t === TERRAIN_MASK_WALL ? 255 : t === TERRAIN_MASK_SWAMP ? 5 : 1);
        }
    }
    const hits = new Map<number, number>();
    for (const s of room.find(FIND_STRUCTURES)) {
        const key = s.pos.y * 50 + s.pos.x;
        if (
            UNBREAKABLE.includes(s.structureType) ||
            (isMine(s) && (OBSTACLE_OBJECT_TYPES as string[]).includes(s.structureType))
        ) {
            base.set(s.pos.x, s.pos.y, 255);
            hits.delete(key);
        } else if (s.structureType === STRUCTURE_ROAD) {
            if (base.get(s.pos.x, s.pos.y) < 255) base.set(s.pos.x, s.pos.y, 1);
        } else if (isBarrier(s) && base.get(s.pos.x, s.pos.y) !== 255) {
            hits.set(key, (hits.get(key) ?? 0) + s.hits);
        }
    }
    for (const [key, total] of hits) {
        const x = key % 50;
        const y = Math.floor(key / 50);
        if (base.get(x, y) === 255 && terrain.get(x, y) !== TERRAIN_MASK_WALL) continue;
        base.set(x, y, Math.min(254, 10 + Math.ceil(total / dps)));
    }
    for (const s of [...room.find(FIND_SOURCES), ...room.find(FIND_MINERALS)]) base.set(s.pos.x, s.pos.y, 255);
    const block = new PathFinder.CostMatrix();
    for (let x = 0; x < 50; x++) {
        for (let y = 0; y < 50; y++) {
            if (x < 1 || y < 1 || x > 47 || y > 47) {
                block.set(x, y, 255);
                continue;
            }
            block.set(x, y, Math.max(base.get(x, y), base.get(x + 1, y), base.get(x, y + 1), base.get(x + 1, y + 1)));
        }
    }
    const entry = { tick: Game.time, base, block };
    matrices.set(room.name, entry);
    return entry;
}

/** A barrier (rampart, wall, obstacle) on a tile: what the quad must break before stepping there */
function barrierAt(pos: RoomPosition): Structure | undefined {
    const barriers = pos.lookFor(LOOK_STRUCTURES).filter(isBarrier);
    return barriers.find(s => s.structureType === STRUCTURE_RAMPART) ?? barriers[0];
}

// ---------------------------------------------------------------- formation

/** Slots assignment minimizing the total distance of the members to their tiles */
function assignSlots(group: Creep[], anchor: { x: number; y: number }, roomName: string): void {
    let best: number[] = [];
    let bestCost = Infinity;
    const permute = (chosen: number[]) => {
        if (chosen.length === group.length) {
            const cost = _.sum(group, (c, i) => worldRange(c.pos, slotPos(anchor, roomName, chosen[i])));
            if (cost < bestCost) {
                bestCost = cost;
                best = [...chosen];
            }
            return;
        }
        for (let slot = 0; slot < 4; slot++) if (!chosen.includes(slot)) permute([...chosen, slot]);
    };
    permute([]);
    group.forEach((c, i) => (c.memory.slot = best[i]));
}

/** Free 2x2 block closest to a position (no wall, obstacle or hostile creep, a tile away from exits) */
function findBlock(room: Room, near: RoomPosition, base: CostMatrix): { x: number; y: number } | null {
    const hostile = new Set(room.find(FIND_HOSTILE_CREEPS).map(c => c.pos.y * 50 + c.pos.x));
    const free = (x: number, y: number) => base.get(x, y) < 10 && !hostile.has(y * 50 + x);
    const cx = Math.min(46, Math.max(2, near.x));
    const cy = Math.min(46, Math.max(2, near.y));
    for (let r = 0; r <= 8; r++) {
        for (let dx = -r; dx <= r; dx++) {
            for (let dy = -r; dy <= r; dy++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
                const x = cx + dx;
                const y = cy + dy;
                if (x < 2 || y < 2 || x > 46 || y > 46) continue;
                if (free(x, y) && free(x + 1, y) && free(x, y + 1) && free(x + 1, y + 1)) return { x, y };
            }
        }
    }
    return null;
}

function isPacked(group: Creep[], anchor: { x: number; y: number; room: string }): boolean {
    return group.every(
        c => c.memory.slot !== undefined && c.pos.isEqualTo(slotPos(anchor, anchor.room, c.memory.slot))
    );
}

/** Members walk to their tiles of the block (new block when it takes too long) */
function pack(quad: QuadMemory, group: Creep[], room: Room, base: CostMatrix): void {
    const leader = group[0];
    if (!quad.anchor || quad.anchor.room !== room.name || Game.time - quad.anchor.since > PACK_TIMEOUT) {
        const near = leader.pos.roomName === room.name ? leader.pos : landing(leader.pos);
        const block = findBlock(room, near.roomName === room.name ? near : new RoomPosition(25, 25, room.name), base);
        if (!block) {
            group.forEach(hold);
            return;
        }
        quad.anchor = { ...block, room: room.name, since: Game.time };
        assignSlots(group, block, room.name);
        countStat("military:quadPack");
    }
    // Closest tiles first; a member two tiles or more away walks around the others
    assignSlots(group, quad.anchor, room.name);
    for (const creep of group) {
        const tile = slotPos(quad.anchor, room.name, creep.memory.slot!);
        trafficManager.requestMove(creep, tile, {
            range: 0,
            priority: PRIORITY,
            combat: worldRange(creep.pos, tile) > 1
        });
    }
}

/**
 * Formation cost of an assignment (slot of each member): attackers away from the focus, and damage
 * expected on each tile weighed by the hits of the member standing there.
 */
function formationCost(
    group: Creep[],
    slots: number[],
    anchor: { x: number; y: number; room: string },
    focus: Structure | null,
    damage: number[]
): number {
    let cost = 0;
    group.forEach((c, i) => {
        const tile = slotPos(anchor, anchor.room, slots[i]);
        if (c.memory.role === QUAD_ATTACKER && focus && !tile.isNearTo(focus)) cost += MELEE_MISPLACED;
        cost += (damage[slots[i]] * 100) / Math.max(1, c.hits);
    });
    return cost;
}

/** Best single swap of two members (attackers to the focus, the toughest to the most exposed tile) */
function rotate(group: Creep[], anchor: { x: number; y: number; room: string }, focus: Structure | null): boolean {
    const tiles = SLOTS.map((_s, slot) => slotPos(anchor, anchor.room, slot));
    const damage = exposure(tiles, Game.rooms[anchor.room]);
    const slots = group.map(c => c.memory.slot!);
    // A focus no slot can reach does not weigh in
    const reachable = focus && tiles.some(t => t.isNearTo(focus)) ? focus : null;
    const current = formationCost(group, slots, anchor, reachable, damage);
    let best: [number, number] | null = null;
    let bestCost = current - SWAP_GAIN;
    for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
            const swapped = [...slots];
            [swapped[i], swapped[j]] = [swapped[j], swapped[i]];
            const cost = formationCost(group, swapped, anchor, reachable, damage);
            if (cost < bestCost) {
                bestCost = cost;
                best = [i, j];
            }
        }
    }
    // A member with an empty slot next to it moves into it instead of swapping (fewer than four)
    if (!best) return false;
    const [a, b] = best;
    const [creepA, creepB] = [group[a], group[b]];
    [creepA.memory.slot, creepB.memory.slot] = [creepB.memory.slot, creepA.memory.slot];
    for (const creep of group)
        trafficManager.requestMove(creep, slotPos(anchor, anchor.room, creep.memory.slot!), {
            range: 0,
            priority: PRIORITY
        });
    countStat("military:quadRotate");
    return true;
}

/** Damage of the towers on the formation anchored there (each tower on its closest tile) */
function towerDamage(towers: StructureTower[], anchor: { x: number; y: number }): number {
    return _.sum(towers, t => {
        const range = Math.min(
            ...SLOTS.map(([dx, dy]) => Math.max(Math.abs(t.pos.x - anchor.x - dx), Math.abs(t.pos.y - anchor.y - dy)))
        );
        return TOWER_POWER_ATTACK * towerPower(range);
    });
}

/** Free block (no barrier) within DRAIN_SEARCH of the anchor with the least tower damage */
function drainSpot(
    towers: StructureTower[],
    anchor: { x: number; y: number },
    block: CostMatrix
): { x: number; y: number; damage: number } | null {
    let best: { x: number; y: number; damage: number } | null = null;
    for (let x = anchor.x - DRAIN_SEARCH; x <= anchor.x + DRAIN_SEARCH; x++) {
        for (let y = anchor.y - DRAIN_SEARCH; y <= anchor.y + DRAIN_SEARCH; y++) {
            if (x < 1 || y < 1 || x > 47 || y > 47 || block.get(x, y) >= 10) continue;
            const damage = towerDamage(towers, { x, y });
            if (!best || damage < best.damage) best = { x, y, damage };
        }
    }
    return best;
}

/** Anchors from which an attacker tile is next to the target (the block never covers it) */
function goalsAround(target: Structure): RoomPosition[] {
    const goals: RoomPosition[] = [];
    for (let x = target.pos.x - 2; x <= target.pos.x + 1; x++) {
        for (let y = target.pos.y - 2; y <= target.pos.y + 1; y++) {
            if (x < 1 || y < 1 || x > 47 || y > 47) continue;
            const covers = x <= target.pos.x && target.pos.x <= x + 1 && y <= target.pos.y && target.pos.y <= y + 1;
            if (!covers) goals.push(new RoomPosition(x, y, target.pos.roomName));
        }
    }
    return goals;
}

// ---------------------------------------------------------------- states

/** Loose chain: the leader walks towards the goal room while the others keep up */
function travel(group: Creep[], goalRoom: string): void {
    const leader = group[0];
    const lagging = group.some((c, i) => i > 0 && (worldRange(c.pos, group[i - 1].pos) > COHESION || c.fatigue > 0));
    for (let i = 1; i < group.length; i++)
        trafficManager.requestMove(group[i], group[i - 1].pos, { range: 1, priority: PRIORITY });
    if (lagging || leader.fatigue > 0) {
        hold(leader);
        return;
    }
    const roomCallback = travelCallback(leader.pos.roomName, goalRoom, group.map(c => c.pos));
    if (!roomCallback) {
        hold(leader);
        return;
    }
    const result = PathFinder.search(
        leader.pos,
        { pos: new RoomPosition(25, 25, goalRoom), range: 22 },
        {
            plainCost: 2,
            swampCost: 10,
            maxOps: 4000,
            roomCallback
        }
    );
    if (result.path[0]) trafficManager.requestMove(leader, result.path[0], { range: 0, priority: PRIORITY });
    else hold(leader);
}

/**
 * Border drain: one member at a time (the one with the most hits, from 90%) stands on the exit tile
 * towards the target and bounces between the two rooms (a creep left on an exit tile changes room
 * every tick): the towers spend a shot on it every other tick, the others heal it on this side.
 * It steps back below 60%. Over once the towers are seen empty (towers that out-damage our healing
 * near the border would kill a packed quad before it gets anywhere).
 */
function drain(quad: QuadMemory, group: Creep[]): void {
    const room = Game.rooms[quad.targetRoom];
    if ((room && enemyTowers(room).length === 0) || tanksTowers(group, quad)) {
        quad.drained = true;
        quad.state = "travel";
        delete quad.poker;
        travel(group, quad.targetRoom);
        return;
    }
    const staging = Game.rooms[quad.stagingRoom];
    const exitDirection = Game.map.findExit(quad.stagingRoom, quad.targetRoom);
    const rally = quad.rally ? new RoomPosition(quad.rally.x, quad.rally.y, quad.rally.room) : null;
    let poker = quad.poker ? Game.creeps[quad.poker] : undefined;
    if (poker && hitsRatio(poker) < RETREAT_HITS) poker = undefined;
    if (!poker && !group.some(c => c.room.name === quad.targetRoom)) {
        // Attackers only (healers would die to a couple of shots)
        const ready = group.filter(c => c.memory.role === QUAD_ATTACKER && hitsRatio(c) >= DRAIN_READY);
        poker = ready.length ? _.max(ready, c => c.hits) : undefined;
    }
    quad.poker = poker?.name;
    for (const creep of group) {
        if (creep === poker) {
            if (creep.room.name === quad.targetRoom) hold(creep);
            else if (staging && exitDirection > 0) {
                const exit = creep.pos.findClosestByRange(staging.find(exitDirection as ExitConstant));
                // Lower traffic priority: the poker never shoves a healer onto the exit
                if (exit) trafficManager.requestMove(creep, exit, { range: 0, priority: PRIORITY + 1 });
                else hold(creep);
            } else hold(creep);
            countStat("military:poke");
        } else if (rally) trafficManager.requestMove(creep, rally, { range: 1, priority: PRIORITY });
        else trafficManager.moveToRoom(creep, quad.stagingRoom, { priority: PRIORITY });
    }
}

/**
 * Out of the target room to the rally point. Packed and away from the border, the block walks out as
 * one (the healers stay adjacent: running loose left a member to die alone, escorting the most hurt
 * one made the quad zigzag as the towers switched targets); near the border or unpacked, each member
 * walks to the rally point.
 */
function retreat(quad: QuadMemory, group: Creep[]): void {
    const room = Game.rooms[quad.targetRoom];
    const anchor = quad.anchor;
    if (room && anchor && anchor.room === room.name && isPacked(group, anchor)) {
        anchor.since = Game.time;
        // Packed: wait for the tired ones (swamp) rather than leave them behind
        if (group.some(c => c.fatigue > 0)) {
            group.forEach(hold);
            return;
        }
        // The towers hit the closest member: a fresher one takes its tile before it drops too low
        const tiles = SLOTS.map((_s, slot) => slotPos(anchor, room.name, slot));
        const damage = exposure(tiles, room);
        const exposed = group.find(c => c.memory.slot === damage.indexOf(Math.max(...damage)));
        if (exposed && hitsRatio(exposed) < RETREAT_SWAP_HITS && rotate(group, anchor, null)) return;
        const exitDirection = Game.map.findExit(quad.targetRoom, quad.stagingRoom);
        const exits = exitDirection > 0 ? room.find(exitDirection as ExitConstant) : [];
        const anchorPos = new RoomPosition(anchor.x, anchor.y, room.name);
        if (exits.length && !exits.some(e => e.inRangeTo(anchorPos, 2))) {
            const { block } = quadMatrices(room, structureDps(group));
            const result = PathFinder.search(
                anchorPos,
                exits.map(pos => ({ pos, range: 2 })),
                {
                    maxRooms: 1,
                    maxOps: 4000,
                    roomCallback: name => (name === room.name ? block : false)
                }
            );
            const next = result.path[0];
            if (next && SLOTS.every((_s, slot) => !barrierAt(slotPos(next, room.name, slot)))) {
                for (const creep of group)
                    trafficManager.requestMove(creep, slotPos(next, room.name, creep.memory.slot!), {
                        range: 0,
                        priority: PRIORITY
                    });
                quad.anchor = { x: next.x, y: next.y, room: room.name, since: Game.time };
                return;
            }
        }
    }
    delete quad.anchor;
    const rally =
        quad.rally?.room === quad.stagingRoom ? new RoomPosition(quad.rally.x, quad.rally.y, quad.rally.room) : null;
    for (const creep of group) {
        if (rally) trafficManager.requestMove(creep, rally, { range: 2, priority: PRIORITY });
        else trafficManager.moveToRoom(creep, quad.stagingRoom, { priority: PRIORITY });
    }
}

/**
 * A member can still walk out: its hits outlast the net damage (worst focus minus our healing) until
 * it reaches the closest exit, plus a margin (retreating later killed attackers two tiles from the exit)
 */
function canEscape(creep: Creep, group: Creep[], pos: RoomPosition = creep.pos): boolean {
    if (verdict(creep, pos, group) === "doomed") return false;
    const net = incomingDamage(pos) * damageMultiplier(creep.body) - availableHealing(pos, group);
    if (net <= 0) return true;
    const { x, y } = pos;
    const toExit = Math.min(x, y, 49 - x, 49 - y);
    return creep.hits > net * (toExit + ESCAPE_MARGIN);
}

function onEdge(pos: RoomPosition): boolean {
    return pos.x <= 0 || pos.y <= 0 || pos.x >= 49 || pos.y >= 49;
}

/** Combat trace: state changes, and every 10 ticks near the target */
const lastTrace: Record<string, string> = {};
function trace(name: string, quad: QuadMemory, group: Creep[], note: string): void {
    const engaged = group.some(c => c.room.name === quad.targetRoom);
    if (lastTrace[name] === quad.state && !(engaged && Game.time % 10 === 0)) return;
    lastTrace[name] = quad.state;
    const who = group
        .map(
            c =>
                `${c.memory.role === QUAD_ATTACKER ? "A" : "H"}${c.memory.slot ?? "-"} ${c.pos.x},${c.pos.y} ${c.hits}/${c.hitsMax}`
        )
        .join(" | ");
    log.info("Quad", `${name} ${quad.state} in ${group[0].room.name}: ${who} ${note}`);
}

/** Packed in the target room: break what blocks, step towards the target, rotate while holding */
function engage(name: string, quad: QuadMemory, group: Creep[], room: Room): string {
    const dps = structureDps(group);
    const { base, block } = quadMatrices(room, dps);
    if (!quad.anchor || !isPacked(group, quad.anchor)) {
        const target = pickTarget(room, group[0].pos);
        attackQuad(group, target);
        pack(quad, group, room, base);
        return "packing";
    }
    const anchor = quad.anchor;
    // Packed: the block stays valid while the quad holds (a failed swap repacks on the same block)
    anchor.since = Game.time;
    const anchorPos = new RoomPosition(anchor.x, anchor.y, room.name);
    const target = pickTarget(room, anchorPos);
    if (!target) {
        attackQuad(group, null);
        group.forEach(hold);
        return "no target";
    }
    const goals = goalsAround(target);
    let focus: Structure = target;
    let next: RoomPosition | null = null;
    if (!goals.some(g => g.isEqualTo(anchorPos))) {
        const result = PathFinder.search(
            anchorPos,
            goals.map(pos => ({ pos, range: 0 })),
            {
                maxRooms: 1,
                plainCost: 1,
                swampCost: 5,
                maxOps: 6000,
                roomCallback: name => (name === room.name ? block : false)
            }
        );
        next = result.path[0] ?? null;
    }
    // Tower drain: while the towers have energy and out-damage our healing, no step closer to them;
    // move to the spot around with the least tower damage and soak shots there (retreat, heal, again)
    const towers = enemyTowers(room);
    let draining = false;
    if (next && towers.length) {
        const heal = _.sum(group, c => healPower(c.body));
        const here = towerDamage(towers, anchor);
        const ahead = towerDamage(towers, next);
        // The towers hit the closest member: the attackers in front, their boosted TOUGH taking a share
        if (ahead * frontMultiplier(group) > heal && ahead >= here) {
            draining = true;
            next = null;
            const spot = drainSpot(towers, anchor, block);
            if (spot && spot.damage < here - DRAIN_GAIN) {
                const result = PathFinder.search(
                    anchorPos,
                    { pos: new RoomPosition(spot.x, spot.y, room.name), range: 0 },
                    {
                        maxRooms: 1,
                        maxOps: 2000,
                        roomCallback: name => (name === room.name ? block : false)
                    }
                );
                const step = result.path[0];
                if (step && SLOTS.every((_s, slot) => !barrierAt(slotPos(step, room.name, slot)))) next = step;
            }
            countStat("military:drain");
        }
    }
    if (next && !draining) {
        // The next block holds a barrier: break the weakest first
        const barriers = SLOTS.map((_s, slot) => barrierAt(slotPos(next!, room.name, slot))).filter(
            (s): s is Structure => !!s
        );
        if (barriers.length) {
            focus = _.min(barriers, s => s.hits);
            next = null;
            countStat("military:breach");
        }
    }
    attackQuad(group, focus);
    const fatigued = group.some(c => c.fatigue > 0);
    if (next && !fatigued) {
        // Survival gate on the tiles they would land on (drain moves go to less damage anyway)
        const doomed = !draining && group.some(c => !canEscape(c, group, slotPos(next!, room.name, c.memory.slot!)));
        if (!doomed) {
            for (const creep of group)
                trafficManager.requestMove(creep, slotPos(next, room.name, creep.memory.slot!), {
                    range: 0,
                    priority: PRIORITY
                });
            quad.anchor = { x: next.x, y: next.y, room: room.name, since: Game.time };
            return `${draining ? "drain " : ""}step ${next.x},${next.y} -> ${target.structureType}`;
        }
        countStat("military:hold");
    }
    if (!fatigued && rotate(group, anchor, focus)) return `rotate, focus ${focus.structureType}`;
    group.forEach(hold);
    return `${draining ? "drain " : ""}hold, focus ${focus.structureType} ${cover(focus).hits}`;
}

/** Runs a quad for one tick */
export function runQuad(name: string, quad: QuadMemory): void {
    rangedUsed.clear();
    const group = members(name);
    for (const member of group) if (!quad.members.includes(member.name)) quad.members.push(member.name);
    for (const member of quad.members) {
        if (Game.creeps[member]) continue;
        quad.losses++;
        countStat("military:lost");
        log.info("Quad", `${name}: lost ${member} (state ${quad.state})`);
    }
    quad.members = quad.members.filter(m => Game.creeps[m]);
    if (group.length === 0) return;

    healQuad(group);
    const healers = group.filter(c => c.memory.role === QUAD_HEALER).length;
    const full = group.length === QUAD_ROSTER.length;
    if (quad.state !== "forming" && (healers === 0 || group.length < 3)) {
        quad.state = "forming";
        countStat("military:quadRefill");
    }

    let note = "";
    if (quad.state === "forming") {
        // Gather at home (spawning refills the missing members)
        for (const creep of group) {
            // Getting boosted at the labs (CreepRunner moves it)
            if (needsBoosting(creep)) continue;
            if (creep.room.name !== quad.spawnRoom)
                trafficManager.moveToRoom(creep, quad.spawnRoom, { priority: PRIORITY });
            else {
                const idle = trafficManager.findIdlePosition(creep);
                trafficManager.requestMove(creep, idle ?? creep.pos, { range: 0, priority: PRIORITY });
            }
        }
        attackQuad(group, null);
        if (full && group.every(c => c.room.name === quad.spawnRoom && !needsBoosting(c))) quad.state = "travel";
    } else if (quad.state === "retreat") {
        retreat(quad, group);
        attackQuad(group, null);
        const home = group.every(c => c.room.name === quad.stagingRoom && !onEdge(c.pos));
        if (home && group.every(c => hitsRatio(c) >= READY_HITS)) quad.state = "travel";
    } else {
        const leader = group[0];
        if (quad.state === "travel" && leader.room.name === quad.targetRoom && !onEdge(leader.pos))
            quad.state = "engage";
        if (quad.state === "travel") {
            if (leader.room.name === quad.stagingRoom) {
                // Rally point: a few tiles inside the staging room, where the leader leaves it
                const clamp = (v: number) => Math.min(46, Math.max(3, v));
                quad.rally = { x: clamp(leader.pos.x), y: clamp(leader.pos.y), room: leader.room.name };
            }
            attackQuad(group, null);
            // Towers left: drain them from the border before going in
            const target = Game.rooms[quad.targetRoom];
            const intel = hostileRoom(quad.targetRoom);
            // Never seen: poke first (the poker gives vision)
            const towersLeft = target ? enemyTowers(target).length > 0 : !intel || intel.towers > 0;
            const { x, y } = leader.pos;
            const atBorder = leader.room.name === quad.stagingRoom && Math.min(x, y, 49 - x, 49 - y) <= 2;
            const shouldDrain = !quad.drained && towersLeft && atBorder && quad.stagingRoom !== quad.targetRoom;
            if (shouldDrain && !tanksTowers(group, quad)) {
                quad.state = "drain";
                drain(quad, group);
            } else travel(group, quad.targetRoom);
        } else if (quad.state === "drain") {
            attackQuad(group, null);
            drain(quad, group);
        } else {
            const room = Game.rooms[quad.targetRoom];
            const danger = group.some(c => hitsRatio(c) < RETREAT_HITS || !canEscape(c, group));
            if (danger && room) {
                quad.state = "retreat";
                quad.drained = false;
                countStat("military:retreat");
                attackQuad(group, pickTarget(room, leader.pos));
                retreat(quad, group);
            } else if (room) note = engage(name, quad, group, room);
            else travel(group, quad.targetRoom);
        }
    }
    trace(name, quad, group, note);
}
