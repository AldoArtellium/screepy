/**
 * Power bank model (pure, offline check: tests/power/run.mjs), used by highway/PowerMining.ts.
 *
 * Sizing from Hivemind (MIT, process/strategy/power-mining.ts, spawn-role/power-harvester.ts): the time
 * left minus the spawn delay and the travel gives the damage per tick needed (x1.2), at most 2 attackers
 * per spawn room and 6 in all (or the free tiles), healers for the hit back (half the damage), haulers for
 * 1.2 x the power. Not in Hivemind: the return (power x its price in energy over the energy of every
 * creep, a second wave when the bank outlives the attackers) must reach minRoi, like the deposits.
 */

/** Hivemind powerBankMinAmount (POWER_BANK_CAPACITY_MAX / 4) */
export const POWER_BANK_MIN_AMOUNT = 1250;
/** Hivemind: first attackers spawned (CREEP_SPAWN_TIME x MAX_CREEP_SIZE) plus 2/3 of that for busy spawns */
const SPAWN_DELAY = 250;
const ATTACKERS_PER_HOME = 2;
const MAX_ATTACKERS = 6;
const DPS_MARGIN = 1.2;
/** POWER_BANK_HIT_BACK, ATTACK_POWER, HEAL_POWER, CARRY_CAPACITY, CREEP_LIFE_TIME (literal for the offline check) */
const HIT_BACK = 0.5;
const ATTACK_DAMAGE = 30;
const HEAL_AMOUNT = 12;
const CARRY_PART_CAPACITY = 50;
const LIFE = 1500;
/** RESOURCE_POWER */
const POWER = "power" as ResourceConstant;

export interface PowerBankInfo {
    id: string;
    room: string;
    x: number;
    y: number;
    power: number;
    hits: number;
    decayAt: number;
    free: number;
}

/** A room that can spawn for a power bank, with the parts and cost of its bodies */
export interface PowerHome {
    name: string;
    /** Ticks from its storage to the bank room */
    travel: number;
    attack: number;
    heal: number;
    carry: number;
    attackerCost: number;
    healerCost: number;
    haulerCost: number;
}

export interface PowerPlan {
    id: string;
    room: string;
    x: number;
    y: number;
    power: number;
    /** Spawn rooms, closest first */
    homes: string[];
    /** Travel of the farthest spawn room */
    travel: number;
    attackers: number;
    healers: number;
    haulers: number;
    timeToKill: number;
    waves: number;
    roi: number;
}

/** Creeps a power bank takes and its return; null when it can't be cracked in time or doesn't pay minRoi */
export function planPowerBank(
    bank: PowerBankInfo,
    homes: PowerHome[],
    price: (resource: ResourceConstant) => number,
    now: number,
    minRoi: number
): PowerPlan | null {
    if (bank.power < POWER_BANK_MIN_AMOUNT) return null;
    const timeLeft = bank.decayAt - now - SPAWN_DELAY;
    const used: PowerHome[] = [];
    let attackers = 0;
    for (const home of [...homes].sort((a, b) => a.travel - b.travel)) {
        used.push(home);
        const window = timeLeft - home.travel;
        if (window <= 0) break;
        const damage = Math.min(...used.map(h => h.attack)) * ATTACK_DAMAGE;
        const needed = Math.max(1, Math.ceil((bank.hits * DPS_MARGIN) / window / damage));
        if (needed > Math.min(MAX_ATTACKERS, bank.free)) break;
        if (used.length * ATTACKERS_PER_HOME >= needed) {
            attackers = needed;
            break;
        }
    }
    if (attackers === 0) return null;

    const worst = (key: "attack" | "heal" | "carry") => Math.min(...used.map(h => h[key]));
    const dearest = (key: "attackerCost" | "healerCost" | "haulerCost") => Math.max(...used.map(h => h[key]));
    const damage = worst("attack") * ATTACK_DAMAGE;
    const travel = Math.max(...used.map(h => h.travel));
    const healers = Math.ceil((attackers * damage * HIT_BACK) / (worst("heal") * HEAL_AMOUNT));
    const haulers = Math.ceil((bank.power * DPS_MARGIN) / (worst("carry") * CARRY_PART_CAPACITY));
    const timeToKill = Math.ceil(bank.hits / (attackers * damage));
    const waves = Math.max(1, Math.ceil(timeToKill / (LIFE - travel)));
    const cost = waves * (attackers * dearest("attackerCost") + healers * dearest("healerCost")) + haulers * dearest("haulerCost");
    const roi = (bank.power * price(POWER)) / cost;
    if (roi < minRoi) return null;
    return {
        id: bank.id, room: bank.room, x: bank.x, y: bank.y, power: bank.power, homes: used.map(h => h.name), travel,
        attackers, healers, haulers, timeToKill, waves, roi
    };
}

/** Best paying power bank, null when none */
export function choosePowerBank(
    banks: PowerBankInfo[],
    homesFor: (room: string) => PowerHome[],
    price: (resource: ResourceConstant) => number,
    now: number,
    minRoi: number
): PowerPlan | null {
    let best: PowerPlan | null = null;
    for (const bank of banks) {
        const plan = planPowerBank(bank, homesFor(bank.room), price, now, minRoi);
        if (plan && (!best || plan.roi > best.roi)) best = plan;
    }
    return best;
}
