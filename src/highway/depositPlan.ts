/**
 * Deposit mining model (pure, offline check: tests/deposits/run.mjs), used by highway/DepositMining.ts.
 *
 * Hivemind (MIT, strategy.deposit_mining, spawn-role/harvester.deposit) activates every deposit with a
 * cooldown up to 100 within 5 rooms of an RCL 8 room and sends one harvester per free tile. Not in
 * Hivemind: a deposit is mined only when a harvester's life pays its body (yield x market price in energy
 * over the body cost, like the military ROI), with as many harvesters as keep one at the deposit.
 */

/** Ticks a creep lives (CREEP_LIFE_TIME, kept literal for the offline check) */
const LIFE = 1500;
/** Resources one CARRY part holds (CARRY_CAPACITY) */
const CARRY_PART_CAPACITY = 50;
/** Hivemind maxDepositCooldown */
export const DEPOSIT_MINING_MAX_COOLDOWN = 100;
/** Harvesters per deposit (CPU: one 50-part creep per tile at most) */
export const MAX_HARVESTERS = 3;

export interface DepositYieldInput {
    work: number;
    carry: number;
    /** Deposit lastCooldown: ticks between two harvests */
    cooldown: number;
    /** Ticks from the home storage to the deposit */
    travel: number;
}

/** Ticks a harvester alone spends filling up at the deposit, and one round trip */
function tripTicks(input: DepositYieldInput): { fill: number; trip: number } {
    const capacity = input.carry * CARRY_PART_CAPACITY;
    const fill = Math.ceil(capacity / input.work) * Math.max(1, input.cooldown);
    return { fill, trip: 2 * input.travel + fill };
}

/** Resources one harvester brings home in its life: full trips, then what the time left lets it harvest */
export function lifetimeYield(input: DepositYieldInput): number {
    const capacity = input.carry * CARRY_PART_CAPACITY;
    const { trip } = tripTicks(input);
    const trips = Math.floor(LIFE / trip);
    const left = LIFE - trips * trip - 2 * input.travel;
    const partial = Math.min(capacity, Math.floor(Math.max(0, left) / Math.max(1, input.cooldown)) * input.work);
    return trips * capacity + partial;
}

/** Harvesters that keep one at the deposit while the others travel, capped by its free tiles */
export function harvestersFor(input: DepositYieldInput, freeTiles: number): number {
    const { fill, trip } = tripTicks(input);
    return Math.max(1, Math.min(freeTiles, MAX_HARVESTERS, Math.ceil(trip / fill)));
}

export interface DepositCandidate {
    id: string;
    room: string;
    x: number;
    y: number;
    type: DepositConstant;
    cooldown: number;
    decayAt: number;
    free: number;
}

export interface DepositHome {
    name: string;
    /** Ticks from its storage to the deposit room */
    travel: number;
}

export interface DepositChoice {
    id: string;
    room: string;
    x: number;
    y: number;
    type: DepositConstant;
    home: string;
    travel: number;
    harvesters: number;
    /** Lifetime yield x price in energy over the body cost */
    roi: number;
}

/**
 * Best deposit to mine: cooldown up to DEPOSIT_MINING_MAX_COOLDOWN, lasting at least a creep life, from
 * its closest eligible home, with the highest return of at least minRoi; null when none
 */
export function chooseDeposit(
    candidates: DepositCandidate[],
    homesFor: (room: string) => DepositHome[],
    price: (type: DepositConstant) => number,
    body: { work: number; carry: number },
    bodyCost: number,
    now: number,
    minRoi: number
): DepositChoice | null {
    let best: DepositChoice | null = null;
    for (const c of candidates) {
        if (c.cooldown > DEPOSIT_MINING_MAX_COOLDOWN || c.decayAt - now < LIFE) continue;
        const homes = homesFor(c.room);
        if (homes.length === 0) continue;
        const home = homes.reduce((a, b) => (b.travel < a.travel ? b : a));
        const input = { ...body, cooldown: c.cooldown, travel: home.travel };
        const roi = (lifetimeYield(input) * price(c.type)) / bodyCost;
        if (roi < minRoi || (best && roi <= best.roi)) continue;
        best = {
            id: c.id, room: c.room, x: c.x, y: c.y, type: c.type, home: home.name, travel: home.travel,
            harvesters: harvestersFor(input, c.free), roi
        };
    }
    return best;
}
