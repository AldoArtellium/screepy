/**
 * Body builder: grows a body part by part towards target weights, adding the MOVE parts the
 * movement mode needs. Ported from Hivemind (MIT), src/creep/body-builder.ts.
 *
 * Quirk kept on purpose: when the next wanted part hits its limit or the energy limit, building
 * stops (no cheaper part is tried). A 300-energy builder is therefore WORK, CARRY, MOVE.
 */

export const enum MoveMode {
    /** 1 MOVE per 2 parts */
    ROAD = 0,
    /** 1 MOVE per part */
    PLAINS = 1,
    SWAMP = 2,
    /** 1 MOVE per 5 parts */
    SLOW = 3,
    /** A single MOVE */
    MINIMAL = 4,
    NONE = 5
}

const FATIGUE: Record<MoveMode, number> = {
    [MoveMode.ROAD]: 1,
    [MoveMode.PLAINS]: 2,
    [MoveMode.SWAMP]: 10,
    [MoveMode.SLOW]: 0.4,
    [MoveMode.MINIMAL]: 0.001,
    [MoveMode.NONE]: 0
};

const MOVE_STRENGTH = 2;
const MILITARY_PARTS: BodyPartConstant[] = [ATTACK, RANGED_ATTACK, HEAL];

export interface BodyOptions {
    /** Target proportions (MOVE excluded); key order matters for ties */
    weights: Partial<Record<BodyPartConstant, number>>;
    partLimits?: Partial<Record<BodyPartConstant, number>>;
    moveMode?: MoveMode;
    /** Falsy = no limit */
    energyLimit?: number;
    maxSize?: number;
    /** Fatigue multiplier of CARRY parts (0 = carried empty, e.g. harvesters) */
    carryContentLevel?: number;
    /** Share of the body at the end where all remaining MOVE parts go */
    moveBufferRatio?: number;
}

export function buildBody(options: BodyOptions): BodyPartConstant[] {
    const counts = calculatePartCounts(options);
    if (!counts) return [];
    return sortParts(counts, options);
}

export function bodyCost(body: BodyPartConstant[]): number {
    return _.sum(body, part => BODYPART_COST[part]);
}

function fatigueOf(part: BodyPartConstant, options: BodyOptions): number {
    if (part === MOVE) return 0;
    const mode = options.moveMode ?? MoveMode.PLAINS;
    const multiplier = part === CARRY ? options.carryContentLevel ?? 1 : 1;
    return FATIGUE[mode] * multiplier;
}

function normalize(weights: Partial<Record<BodyPartConstant, number>>): Partial<Record<BodyPartConstant, number>> {
    let total = 0;
    for (const part in weights) {
        const value = weights[part as BodyPartConstant] ?? 0;
        if (part === MOVE || value <= 0) continue;
        total += value;
    }
    const result: Partial<Record<BodyPartConstant, number>> = {};
    if (total === 0) return result;
    for (const part in weights) {
        const value = weights[part as BodyPartConstant] ?? 0;
        if (part === MOVE || value <= 0) continue;
        result[part as BodyPartConstant] = value / total;
    }
    return result;
}

function calculatePartCounts(options: BodyOptions): Partial<Record<BodyPartConstant, number>> | null {
    const weights = normalize(options.weights);
    const parts = Object.keys(weights) as BodyPartConstant[];
    const maxSize = options.maxSize ?? MAX_CREEP_SIZE;
    const limits = options.partLimits ?? {};

    const counts: Partial<Record<BodyPartConstant, number>> = { [MOVE]: 0 };
    const fatigueWith = (extra: BodyPartConstant) =>
        fatigueOf(extra, options) + _.sum(Object.keys(counts) as BodyPartConstant[], p => (counts[p] ?? 0) * fatigueOf(p, options));

    let size = 0;
    let cost = 0;
    for (const part of parts) {
        counts[part] = 1;
        size++;
        cost += BODYPART_COST[part];
    }
    counts[MOVE] = Math.ceil(fatigueWith(MOVE) / MOVE_STRENGTH);
    size += counts[MOVE]!;
    cost += BODYPART_COST[MOVE] * counts[MOVE]!;
    if (size > maxSize) return null;
    if (options.energyLimit && cost > options.energyLimit) return null;

    while (size < maxSize) {
        const next = nextPart(counts, weights, parts);
        if (limits[next] && (counts[next] ?? 0) >= limits[next]!) break;
        const neededMoves = Math.ceil(fatigueWith(next) / MOVE_STRENGTH) - counts[MOVE]!;
        const partCost = BODYPART_COST[next] + neededMoves * BODYPART_COST[MOVE];
        if (options.energyLimit && cost + partCost > options.energyLimit) break;
        if (size + neededMoves + 1 > maxSize) break;
        counts[next] = (counts[next] ?? 0) + 1;
        counts[MOVE]! += neededMoves;
        size += 1 + neededMoves;
        cost += partCost;
    }
    return counts;
}

/** First part (in weight order) below its target proportion, else the first part */
function nextPart(
    counts: Partial<Record<BodyPartConstant, number>>,
    weights: Partial<Record<BodyPartConstant, number>>,
    parts: BodyPartConstant[]
): BodyPartConstant {
    const current = normalize(counts);
    for (const part of parts) {
        if ((current[part] ?? 0) < weights[part]!) return part;
    }
    return parts[0];
}

function sortParts(counts: Partial<Record<BodyPartConstant, number>>, options: BodyOptions): BodyPartConstant[] {
    const remaining = { ...counts };
    const body: BodyPartConstant[] = [];
    for (let i = 0; i < (remaining[TOUGH] ?? 0); i++) body.push(TOUGH);
    remaining[TOUGH] = 0;

    // Round robin over non-military parts, in key order (MOVE first in the object, skipped)
    let pushed = true;
    while (pushed) {
        pushed = false;
        for (const part of Object.keys(remaining) as BodyPartConstant[]) {
            if (part === MOVE || MILITARY_PARTS.includes(part) || !remaining[part]) continue;
            body.push(part);
            remaining[part]!--;
            pushed = true;
        }
    }
    for (const part of [RANGED_ATTACK, ATTACK, HEAL] as BodyPartConstant[]) {
        for (let i = 0; i < (remaining[part] ?? 0); i++) body.push(part);
    }
    return interweaveMoves(body, counts[MOVE] ?? 0, options);
}

function interweaveMoves(body: BodyPartConstant[], moves: number, options: BodyOptions): BodyPartConstant[] {
    let totalFatigue = _.sum(body, part => fatigueOf(part, options));
    let movePower = moves * MOVE_STRENGTH;
    const bufferRatio = options.moveBufferRatio ?? 0;
    const result: BodyPartConstant[] = [];
    let functional = 0;
    for (const part of body) {
        while (movePower - totalFatigue >= MOVE_STRENGTH) {
            result.push(MOVE);
            movePower -= MOVE_STRENGTH;
        }
        if (1 - functional / body.length <= bufferRatio) {
            while (movePower > 0) {
                result.push(MOVE);
                movePower -= MOVE_STRENGTH;
            }
        }
        result.push(part);
        functional++;
        // An empty CARRY part generates no fatigue
        if (part === CARRY) totalFatigue -= fatigueOf(CARRY, options);
    }
    while (movePower > 0) {
        result.push(MOVE);
        movePower -= MOVE_STRENGTH;
    }
    return result;
}
