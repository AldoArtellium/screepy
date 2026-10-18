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

/** Healing our healers can give a creep standing on a tile (adjacent heal, else ranged heal) */
export function availableHealing(pos: RoomPosition, healers: Creep[]): number {
    let heal = 0;
    for (const healer of healers) {
        const range = healer.pos.roomName === pos.roomName ? healer.pos.getRangeTo(pos) : Infinity;
        // A healer next to the creep (or about to be) heals at full power
        if (range <= 2) heal += HEAL_POWER * activeParts(healer, HEAL);
        else if (range <= 3) heal += RANGED_HEAL_POWER * activeParts(healer, HEAL);
    }
    return heal;
}

/**
 * Safe: healing outpaces the damage (flow); rescue: damaged faster than healed, but the creep's hits
 * last SURVIVAL_TICKS (stock); doomed: it would die within SURVIVAL_TICKS.
 */
export function verdict(creep: Creep, pos: RoomPosition, healers: Creep[]): Verdict {
    const net = incomingDamage(pos) - availableHealing(pos, healers);
    if (net <= 0) return "safe";
    if (creep.hits > net * SURVIVAL_TICKS) return "rescue";
    return "doomed";
}
