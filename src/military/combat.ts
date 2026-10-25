/**
 * Combat prediction for our squads: the worst damage a creep could take on a tile next tick (every
 * enemy tower focusing it, enemy melee creeps that can step next to it, ranged ones within reach)
 * against the healing our squad can put on it.
 * Our design (no open-source bot publishes its offense); the approach follows Harabi's "Combat
 * Blob" research log: assume the worst focus, gate moves on survival, reason on flows.
 */

export type Verdict = "safe" | "rescue" | "doomed";

/** Ticks a creep must be able to survive on a tile before it may step there */
const SURVIVAL_TICKS = 3;

export function towerPower(range: number): number {
    const r = Math.min(Math.max(range, TOWER_OPTIMAL_RANGE), TOWER_FALLOFF_RANGE);
    return 1 - ((r - TOWER_OPTIMAL_RANGE) / (TOWER_FALLOFF_RANGE - TOWER_OPTIMAL_RANGE)) * TOWER_FALLOFF;
}

function activeParts(creep: Creep, type: BodyPartConstant): number {
    return creep.body.filter(p => p.type === type && p.hits > 0).length;
}

/** A body part as the engine exposes it (Creep.body); plain objects in the offline check (tests/combat) */
export interface BodyPart {
    type: BodyPartConstant;
    hits: number;
    /** @types/screeps types a CLAIM part's boost as string | number */
    boost?: string | number;
}

type BoostTable = Record<string, Record<string, Record<string, number>>>;

/** Multiplier a part's boost gives an effect (1 unboosted) */
function boostFactor(part: BodyPart, effect: string): number {
    if (!part.boost) return 1;
    return (BOOSTS as unknown as BoostTable)[part.type]?.[part.boost]?.[effect] ?? 1;
}

/** Healing per tick of a body at range 1, boosts included (a ranged heal: x RANGED_HEAL_POWER / HEAL_POWER) */
export function healPower(body: BodyPart[]): number {
    let heal = 0;
    for (const p of body) if (p.type === HEAL && p.hits > 0) heal += HEAL_POWER * boostFactor(p, "heal");
    return heal;
}

/** Damage per tick of a body (melee and single ranged shots), boosts included */
export function attackPower(body: BodyPart[]): number {
    let damage = 0;
    for (const p of body) {
        if (p.hits <= 0) continue;
        if (p.type === ATTACK) damage += ATTACK_POWER * boostFactor(p, "attack");
        else if (p.type === RANGED_ATTACK) damage += RANGED_ATTACK_POWER * boostFactor(p, "rangedAttack");
    }
    return damage;
}

/**
 * Share of the damage a body takes while its boosted TOUGH parts stand: the lowest multiplier of
 * those left (1 without). The engine reduces the damage those parts absorb; once they are almost gone
 * the hits behind them take full damage, so this is optimistic for a creep about to lose them.
 */
export function damageMultiplier(body: BodyPart[]): number {
    let multiplier = 1;
    for (const p of body) {
        if (p.type === TOUGH && p.hits > 0) multiplier = Math.min(multiplier, boostFactor(p, "damage"));
    }
    return multiplier;
}

/**
 * The squad out-heals `towers` towers focusing its front at close range (the front's damage share
 * applied): it can walk in without draining them first, even when the owner refills them. shard0
 * W28N8 (one RCL 4 tower, refilled by a tower feeder): an RCL 6 quad with GHO2 TOUGH and XLHO2 HEAL
 * takes 300 for 576 of healing; unboosted, 600 for 144.
 */
export function canTank(heal: number, towers: number, frontMultiplier: number): boolean {
    return towers * TOWER_POWER_ATTACK * frontMultiplier <= heal;
}

/** Hostile towers of a room that can still shoot (enough energy for one shot) */
export function enemyTowers(room: Room | undefined): StructureTower[] {
    if (!room) return [];
    return room.find(FIND_HOSTILE_STRUCTURES, {
        filter: s => s.structureType === STRUCTURE_TOWER && s.store.energy >= TOWER_ENERGY_COST
    }) as StructureTower[];
}

/** Worst damage per tick on a tile next tick */
export function incomingDamage(pos: RoomPosition): number {
    const room = Game.rooms[pos.roomName];
    if (!room) return 0;
    let damage = 0;
    for (const tower of enemyTowers(room)) damage += TOWER_POWER_ATTACK * towerPower(tower.pos.getRangeTo(pos));
    for (const enemy of room.find(FIND_HOSTILE_CREEPS)) {
        const range = enemy.pos.getRangeTo(pos);
        // One move then strike: melee reaches range 2, ranged range 4
        if (range <= 2) damage += ATTACK_POWER * activeParts(enemy, ATTACK);
        if (range <= 4) damage += RANGED_ATTACK_POWER * activeParts(enemy, RANGED_ATTACK);
    }
    return damage;
}

/** Healing our healers can give a creep standing on a tile (adjacent heal, else ranged heal), boosts included */
export function availableHealing(pos: RoomPosition, healers: Creep[]): number {
    let heal = 0;
    for (const healer of healers) {
        const range = healer.pos.roomName === pos.roomName ? healer.pos.getRangeTo(pos) : Infinity;
        // A healer next to the creep (or about to be) heals at full power
        if (range <= 2) heal += healPower(healer.body);
        else if (range <= 3) heal += (healPower(healer.body) * RANGED_HEAL_POWER) / HEAL_POWER;
    }
    return heal;
}

/**
 * Safe: healing outpaces the damage (flow); rescue: damaged faster than healed, but the creep's hits
 * last SURVIVAL_TICKS (stock); doomed: it would die within SURVIVAL_TICKS. Boosted TOUGH parts
 * lower the damage (damageMultiplier), boosted HEAL parts raise the healing.
 */
export function verdict(creep: Creep, pos: RoomPosition, healers: Creep[]): Verdict {
    const net = incomingDamage(pos) * damageMultiplier(creep.body) - availableHealing(pos, healers);
    if (net <= 0) return "safe";
    if (creep.hits > net * SURVIVAL_TICKS) return "rescue";
    return "doomed";
}
