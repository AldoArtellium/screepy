/**
 * Owned room defense state: enemy strength, rampart integrity, wanted rampart hits, and the tower
 * target (the hostile where our damage beats its healing by the most, weighted by its value).
 * Ported from Hivemind (MIT), src/room-defense.ts and src/manager.military.ts. Allies and rampart
 * opening for friendly creeps are left out (no diplomacy yet).
 */

import { tickCache } from "../core/roomState";
import { roomPlanner } from "../planner/RoomPlanner";

declare global {
    interface RoomMemory {
        /** Threat level (The International `threatened`): rises with serious player attacks, decays over time */
        threat?: number;
    }
}

export const ENEMY_STRENGTH_NONE = 0;
/** Towers can take them out */
export const ENEMY_STRENGTH_WEAK = 1;
/** Unboosted active defense can probably handle them */
export const ENEMY_STRENGTH_NORMAL = 2;
/** Boosted active defense can probably handle them */
export const ENEMY_STRENGTH_STRONG = 3;
/** We need help from outside */
export const ENEMY_STRENGTH_DEADLY = 4;
export type EnemyStrength = 0 | 1 | 2 | 3 | 4;

/** Wall / rampart hits wanted per RCL (Hivemind settings maxWallHealth) */
export const MAX_WALL_HEALTH: { [rcl: number]: number } = {
    0: 1,
    1: 5000,
    2: 10000,
    3: 20000,
    4: 100000,
    5: 500000,
    6: 2000000,
    7: 3000000,
    8: 20000000
};

const PART_STRENGTH: Partial<Record<BodyPartConstant, number>> = {
    [ATTACK]: ATTACK_POWER,
    [RANGED_ATTACK]: RANGED_ATTACK_POWER,
    [HEAL]: HEAL_POWER,
    [CLAIM]: ATTACK_POWER / 2,
    [WORK]: DISMANTLE_POWER
};
const BOOST_ATTRIBUTE: Partial<Record<BodyPartConstant, string>> = {
    [ATTACK]: "attack",
    [RANGED_ATTACK]: "rangedAttack",
    [HEAL]: "heal",
    [WORK]: "dismantle"
};

function myRooms(): Room[] {
    return tickCache("myRooms", () => _.filter(Game.rooms, r => !!r.controller?.my));
}

/** Hostile creeps of other players (no allies yet), towers' and guardians' candidates */
export function hostileCreeps(room: Room): Creep[] {
    return tickCache(`hostiles:${room.name}`, () => room.find(FIND_HOSTILE_CREEPS));
}

/** Hivemind isDangerous: a part other than MOVE/TOUGH (outside our rooms, WORK/CARRY don't count either) */
export function isDangerous(creep: Creep): boolean {
    const mine = !!creep.room.controller?.my;
    return creep.body.some(p => p.type !== MOVE && p.type !== TOUGH && (mine || (p.type !== WORK && p.type !== CARRY)));
}

function enemyInfo(room: Room): { attack: number; heal: number; invaderOnly: boolean } {
    let attack = 0;
    let heal = 0;
    let invaderOnly = true;
    for (const creep of hostileCreeps(room)) {
        if (creep.owner.username !== "Invader") invaderOnly = false;
        for (const part of creep.body) {
            let power = PART_STRENGTH[part.type] ?? 0;
            let boost = 1;
            if (part.boost && typeof part.boost === "string") {
                const effect = (BOOSTS as unknown as Record<string, Record<string, Record<string, number>>>)[part.type]?.[part.boost] ?? {};
                boost = effect[BOOST_ATTRIBUTE[part.type] ?? ""] || 1;
                if (part.type === TOUGH) {
                    power = 100;
                    boost = 1 / (effect.damage || 1);
                }
            }
            if (part.type === ATTACK || part.type === RANGED_ATTACK || part.type === CLAIM || part.type === WORK) attack += power * boost;
            if (part.type === HEAL) heal += power * boost;
        }
    }
    return { attack, heal, invaderOnly };
}

/** Hits of the weakest planned main rampart, 0 when one is missing (Hivemind getLowestWallStrength) */
export function lowestWallStrength(room: Room): number {
    return tickCache(`lowestWall:${room.name}`, () => {
        const plan = roomPlanner.getPlan(room.name);
        if (!plan) return 0;
        const ramparts = new Map<number, number>();
        for (const s of room.find(FIND_MY_STRUCTURES)) {
            if (s.structureType === STRUCTURE_RAMPART) ramparts.set(s.pos.x + 50 * s.pos.y, s.hits);
        }
        let min = Infinity;
        for (const pos of plan.getLocations("rampart")) {
            if (plan.has(pos, "rampart.ramp")) continue;
            const hits = ramparts.get(pos.x + 50 * pos.y);
            if (hits === undefined) return 0;
            min = Math.min(min, hits);
        }
        return min === Infinity ? 0 : min;
    });
}

/** Every planned main rampart is built */
export function isWallIntact(room: Room): boolean {
    if (!roomPlanner.getPlan(room.name)) return true;
    return lowestWallStrength(room) > 0;
}

export function enemyStrength(room: Room): EnemyStrength {
    return tickCache(`enemyStrength:${room.name}`, () => {
        const towers = room.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_TOWER }).length;
        const towerStrength = (TOWER_POWER_ATTACK * towers) / 2;
        // Active defense: 2 creeps with as many ATTACK as MOVE parts
        const defenders =
            2 * ATTACK_POWER * Math.min(MAX_CREEP_SIZE / 2, Math.floor(room.energyCapacityAvailable / (BODYPART_COST[ATTACK] + BODYPART_COST[MOVE])));
        // A wall down in < 3000 ticks is a problem, in < 1000 ticks a big one
        const lowest = lowestWallStrength(room);
        const normalThreshold = lowest / 3000;
        const highThreshold = lowest / 1000;
        const { attack, heal, invaderOnly } = enemyInfo(room);
        if (attack === 0) return ENEMY_STRENGTH_NONE;
        if (invaderOnly || (heal < towerStrength && attack < highThreshold)) return ENEMY_STRENGTH_WEAK;
        if (heal < towerStrength + defenders && attack > normalThreshold) return ENEMY_STRENGTH_NORMAL;
        if (heal < towerStrength + defenders && attack > highThreshold) return ENEMY_STRENGTH_STRONG;
        return ENEMY_STRENGTH_DEADLY;
    }) as EnemyStrength;
}

/** Threat decay per tick without a serious attack (half-life ~6900 ticks; TI: 0.99999) */
const THREAT_DECAY = 0.9999;
/** Threat per infamy point (energy value of a player's creeps seen in our rooms and remotes) */
const INFAMY_THREAT = 0.1;
/** Lowest rampart target from RCL 3 (TI minRampartHits fallback) */
const MIN_WALL_TARGET = 20000;

/**
 * Threat of the player creeps in the room (TI findPresentThreat): dismantle + melee x 1.2 + ranged x 3.5
 * + heal, boosts included. NPC invaders never count.
 */
export function presentThreat(room: Room): number {
    let threat = 0;
    for (const creep of hostileCreeps(room)) {
        if (creep.owner.username === "Invader" || creep.owner.username === "Source Keeper") continue;
        threat += DISMANTLE_POWER * activePower(creep, WORK, "dismantle");
        threat += ATTACK_POWER * activePower(creep, ATTACK, "attack") * 1.2;
        threat += RANGED_ATTACK_POWER * activePower(creep, RANGED_ATTACK, "rangedAttack") * 3.5;
        threat += HEAL_POWER * activePower(creep, HEAL, "heal");
    }
    return Math.floor(threat);
}

/**
 * Every tick (TI manageThreat): a player attack the towers alone can't handle (NORMAL or stronger)
 * raises the room's threat to its strength, otherwise it decays.
 */
export function updateThreat(room: Room): void {
    const memory = room.memory;
    if (enemyStrength(room) >= ENEMY_STRENGTH_NORMAL) {
        const present = presentThreat(room);
        if (present > (memory.threat ?? 0)) memory.threat = present;
        return;
    }
    if (memory.threat === undefined) return;
    memory.threat *= THREAT_DECAY;
    if (memory.threat < 1) delete memory.threat;
}

/** Room threat, at least the infamy of the worst player who came into our rooms or remotes */
export function roomThreat(room: Room): number {
    let infamy = 0;
    const players = Memory.military?.infamy ?? {};
    for (const player in players) infamy = Math.max(infamy, players[player]);
    return Math.max(room.memory.threat ?? 0, infamy * INFAMY_THREAT);
}

/**
 * Rampart hits wanted for an RCL and a threat (TI minRampartHits): ((rcl - 3) x 50)^2.5 + threat x 5 x rcl^2,
 * at least 20k, never above Hivemind's maxWallHealth: RCL 4 20k, 5 100k, 6 276k, 7 566k, 8 988k without threat.
 */
export function wallTarget(rcl: number, threat: number): number {
    const max = MAX_WALL_HEALTH[rcl] ?? 0;
    const base = Math.max(MIN_WALL_TARGET, Math.pow(Math.max(0, rcl - 3) * 50, 2.5));
    return Math.min(max, Math.floor(base + threat * 5 * rcl * rcl));
}

/** Rampart hits builders aim for: x2 during the safe mode cooldown, x1.5 while one of our rooms is safe-moded */
export function desiredWallStrength(room: Room): number {
    const rcl = room.controller?.level ?? 0;
    let multiplier = 1;
    if (room.controller?.safeModeCooldown) multiplier = 2;
    else if (myRooms().some(r => r.controller?.safeMode)) multiplier = 1.5;
    return tickCache(`wallTarget:${room.name}`, () => wallTarget(rcl, roomThreat(room))) * multiplier;
}

/** Tower power at a range: 1 up to TOWER_OPTIMAL_RANGE, 1 - TOWER_FALLOFF at TOWER_FALLOFF_RANGE */
export function towerPowerAtRange(range: number): number {
    const r = Math.min(Math.max(range, TOWER_OPTIMAL_RANGE), TOWER_FALLOFF_RANGE);
    return 1 - ((r - TOWER_OPTIMAL_RANGE) / (TOWER_FALLOFF_RANGE - TOWER_OPTIMAL_RANGE)) * TOWER_FALLOFF;
}

/** Damage actually dealt once boosted TOUGH parts absorb their share (Hivemind getEffectiveDamage) */
function effectiveDamage(creep: Creep, potential: number): number {
    let total = 0;
    let taken = 0;
    for (const part of creep.body) {
        if (taken >= potential) break;
        if (part.hits === 0) continue;
        let multiplier = 1;
        if (part.type === TOUGH && part.boost) {
            const effect = (BOOSTS as unknown as Record<string, Record<string, Record<string, number>>>)[TOUGH]?.[part.boost as string];
            if (effect?.damage) multiplier = 1 / effect.damage;
        }
        const damage = Math.min(part.hits * multiplier, potential - taken);
        total += damage / multiplier;
        taken += damage;
    }
    return total + potential - taken;
}

/** Hits once boosted TOUGH parts absorb their share (Hivemind getEffectiveHealth) */
export function effectiveHits(creep: Creep): number {
    let total = 0;
    for (const part of creep.body) {
        const effect = part.type === TOUGH && part.boost
            ? (BOOSTS as unknown as Record<string, Record<string, Record<string, number>>>)[TOUGH]?.[part.boost as string]
            : undefined;
        total += part.hits / (effect?.damage ?? 1);
    }
    return total;
}

/** Moves at full speed on plains: a melee creep this fast can't be kited (fatigue = 2 per part, MOVE boosts included) */
export function isFast(creep: Creep): boolean {
    const others = creep.body.filter(p => p.type !== MOVE && p.type !== CARRY).length;
    return activePower(creep, MOVE, "fatigue") >= others;
}

const PART_VALUE: Partial<Record<BodyPartConstant, number>> = { [ATTACK]: 1, [CLAIM]: 10, [HEAL]: 5, [RANGED_ATTACK]: 2, [WORK]: 1 };

function militaryValue(creep: Creep): number {
    return _.sum(creep.body, p => (0.1 + (0.9 * p.hits) / 100) * (PART_VALUE[p.type] ?? 0));
}

/** Active parts of a creep, boosts included */
export function activePower(creep: Creep, type: BodyPartConstant, attribute: string): number {
    let total = 0;
    for (const part of creep.body) {
        if (part.type !== type || part.hits === 0) continue;
        const effect = part.boost
            ? (BOOSTS as unknown as Record<string, Record<string, Record<string, number>>>)[type]?.[part.boost as string]
            : undefined;
        total += effect?.[attribute] ?? 1;
    }
    return total;
}

interface MilitarySituation {
    /** Dangerous hostiles and their target priority (> 0: our damage beats their healing) */
    targets: { creep: Creep; priority: number }[];
    /** Our potential damage on a tile */
    myDamage: Map<number, number>;
}

/** Our damage and their healing on every dangerous hostile's tile (Hivemind assertMilitarySituation) */
export function militarySituation(room: Room): MilitarySituation {
    return tickCache(`military:${room.name}`, () => {
        const hostiles = hostileCreeps(room).filter(isDangerous);
        const mine = room.find(FIND_MY_CREEPS);
        const myDamage = new Map<number, number>();
        const healing = new Map<number, number>();
        const add = (map: Map<number, number>, pos: RoomPosition, amount: number): void => {
            if (amount > 0) map.set(pos.x + 50 * pos.y, (map.get(pos.x + 50 * pos.y) ?? 0) + amount);
        };
        for (const tower of room.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_TOWER }) as StructureTower[]) {
            // Almost empty towers are not counted, so we don't shoot at targets we can't kill
            if (tower.store.energy < TOWER_ENERGY_COST * 10) continue;
            for (const h of hostiles) add(myDamage, h.pos, towerPowerAtRange(tower.pos.getRangeTo(h)) * TOWER_POWER_ATTACK);
        }
        for (const creep of mine) {
            const attack = activePower(creep, ATTACK, "attack");
            const ranged = activePower(creep, RANGED_ATTACK, "rangedAttack");
            for (const h of hostiles) {
                const range = creep.pos.getRangeTo(h);
                if (range <= 1) add(myDamage, h.pos, ATTACK_POWER * attack);
                if (range <= 3) add(myDamage, h.pos, RANGED_ATTACK_POWER * ranged);
            }
        }
        for (const healer of hostiles) {
            const heal = activePower(healer, HEAL, "heal");
            if (heal === 0) continue;
            for (const h of hostiles) {
                const range = healer.pos.getRangeTo(h);
                if (range <= 3) add(healing, h.pos, RANGED_HEAL_POWER * heal);
                if (range <= 1) add(healing, h.pos, (HEAL_POWER - RANGED_HEAL_POWER) * heal);
            }
        }
        const targets = hostiles.map(creep => {
            const i = creep.pos.x + 50 * creep.pos.y;
            const damage = effectiveDamage(creep, myDamage.get(i) ?? 0);
            const heal = healing.get(i) ?? 0;
            const factor = creep.hits === creep.hitsMax ? 1.1 : 1;
            const priority =
                damage > heal * factor
                    ? (militaryValue(creep) * (damage - heal) * (creep.hitsMax / creep.hits) * (creep.ticksToLive ?? CREEP_LIFE_TIME)) / CREEP_LIFE_TIME
                    : 0;
            return { creep, priority };
        });
        return { targets, myDamage };
    });
}

/** Hostile with the highest positive priority (last one on ties, like Hivemind), or null */
export function towerTarget(room: Room): Creep | null {
    let best: { creep: Creep; priority: number } | null = null;
    for (const target of militarySituation(room).targets) {
        if (target.priority <= 0) continue;
        if (best && best.priority > target.priority) continue;
        best = target;
    }
    return best?.creep ?? null;
}

/** Could our damage kill it before it reaches the exit? (Hivemind canKillBeforeFleeing) */
export function canKillBeforeFleeing(room: Room, target: Creep): boolean {
    const potential = militarySituation(room).myDamage.get(target.pos.x + 50 * target.pos.y) ?? 0;
    const distanceToExit = 24 - target.pos.getRangeTo(25, 25);
    if (distanceToExit <= 0) return false;
    return effectiveDamage(target, potential) * distanceToExit > target.hits;
}

export { myRooms };
