/**
 * Drain forecast (pure, offline check `node tests/drainForecast/run.mjs`): a drainer (military/drainer.ts)
 * bounces on the exit tile towards a target whose towers the quad can't tank, measures how fast the
 * towers' energy goes down net of the owner's refills, and the quad is spawned only once the towers are
 * predicted empty by the time it arrives. Towers that never fire at the exit tile (shard0 2026-11-14:
 * Blindfold's W29N4 and W28N3 repaired walls instead) or a drain the refills cancel end the mission with
 * only the drainer spent. Our design.
 */

/** Ticks of a rate window (refills come in bursts: a filler empties its carry at once) */
export const RATE_WINDOW = 100;
/** Ticks in the target room without a hit before the towers are judged not to fire at the exit tile */
export const NO_FIRE_TICKS = 20;
/** Ticks the drain gets before a rate below MIN_RATE ends it */
export const FORECAST_PATIENCE = 500;
/** Net energy per tick under which the drain is not progressing */
export const MIN_RATE = 1;
/** Ticks without a sample after which the rate window restarts */
export const SAMPLE_GAP = 20;
/** Ticks a mission may probe without ever seeing the target's towers (the drainer never got there) */
export const PROBE_TIMEOUT = 2000;
/** Ticks per room of the quad's route (loose chain, the leader waits for the others) */
const TRAVEL_PER_ROOM = 50;
/** Ticks the members spend at the labs */
const BOOST_LEAD = 60;
/** Ticks to gather and form at the rally */
const FORM_TICKS = 20;
/** Members of a quad: no more spawns than that work in parallel */
const QUAD_MEMBERS = 4;

export interface DrainForecast {
    /** First sample */
    since: number;
    /** Checkpoint of the current rate window */
    at: number;
    energy: number;
    /** Last sample */
    seen?: number;
    /** Smoothed net drain rate (energy per tick, positive: the towers empty), once a window is complete */
    rate?: number;
    /** Ticks the drainer started in the target room, and those it was hit */
    inTicks: number;
    hitTicks: number;
}

export type DrainDecision = "wait" | "spawn" | "noFire" | "noProgress";

/**
 * A tower refill seen at once from which the drain is hopeless (combat.ts largestRefill): mockup level 1
 * stronghold W7N4 (2026-11-15), the core refills its tower from empty to 990-1000 every 200-300 ticks; the
 * quad then held where it could still escape such a refill, short of the core, and retreated at each one
 * until its members aged. The mockup's player feeder brings 5 at a time.
 */
export const BURST_REFILL = 200;

/** The towers are refilled in bursts no drain keeps down */
export function refillsInBursts(largestRefill: number): boolean {
    return largestRefill >= BURST_REFILL;
}

/**
 * The towers' total energy seen now: a new window each RATE_WINDOW ticks, averaged with the last one. After
 * more than SAMPLE_GAP ticks unseen (drainer dead or resting) the window restarts from now: the refills of
 * the gap, with nobody draining, would count against the drain.
 */
export function sampleEnergy(forecast: DrainForecast | undefined, now: number, energy: number): DrainForecast {
    if (!forecast) return { since: now, at: now, energy, seen: now, inTicks: 0, hitTicks: 0 };
    if (now - (forecast.seen ?? forecast.at) > SAMPLE_GAP) return { ...forecast, at: now, energy, seen: now };
    if (now - forecast.at < RATE_WINDOW) return { ...forecast, seen: now };
    const window = (forecast.energy - energy) / (now - forecast.at);
    const rate = forecast.rate === undefined ? window : (forecast.rate + window) / 2;
    return { ...forecast, at: now, energy, seen: now, rate };
}

/**
 * A new wait of the quad at the border (first one, or back from a retreat): the patience and the rate
 * window start over from now. The old rate holds the fight's and the retreat's refills, and a patience
 * counted from the first probe sample would end the mission on the wait's first tick. The hit counts are
 * kept: towers that fired at the drainer still do.
 */
export function restartPatience(forecast: DrainForecast, now: number, energy: number): DrainForecast {
    return { ...forecast, since: now, at: now, energy, seen: now, rate: undefined };
}

/** One tick of the drainer in the target room, hit or not */
export function recordPoke(forecast: DrainForecast, hit: boolean): DrainForecast {
    return { ...forecast, inTicks: forecast.inTicks + 1, hitTicks: forecast.hitTicks + (hit ? 1 : 0) };
}

/**
 * The drainer was hit during its tick in the target room: its hits after the tick are below its hits
 * before plus what it healed (capped at hitsMax). It heals there only when already hurt, so a creep at
 * full hits shows any hit.
 */
export function wasHit(before: number, after: number, healed: number, hitsMax: number): boolean {
    return after < Math.min(hitsMax, before + healed);
}

/** Ticks until the towers are empty at the net rate (never when the refills keep up) */
export function etaToEmpty(energy: number, rate: number | undefined): number {
    if (energy <= 0) return 0;
    if (rate === undefined || rate <= 0) return Infinity;
    return energy / rate;
}

/**
 * Ticks between the decision and the quad at the border: its parts' spawn time spread over the
 * mission's spawns (one member each at most), the labs when boosted, the route from the spawn room
 */
export function quadLeadTime(o: { spawnParts: number; spawns: number; boosted: boolean; routeRooms: number }): number {
    const spawns = Math.max(1, Math.min(QUAD_MEMBERS, o.spawns));
    return (
        Math.ceil((o.spawnParts * CREEP_SPAWN_TIME) / spawns) +
        (o.boosted ? BOOST_LEAD : 0) +
        o.routeRooms * TRAVEL_PER_ROOM +
        FORM_TICKS
    );
}

/**
 * Spawn the quad once the towers are empty or predicted empty within its lead time; give up when the
 * towers never hit the drainer, or the drain stays below MIN_RATE after FORECAST_PATIENCE ticks
 */
export function drainDecision(forecast: DrainForecast, now: number, energy: number, lead: number): DrainDecision {
    if (energy <= 0) return "spawn";
    if (forecast.inTicks >= NO_FIRE_TICKS && forecast.hitTicks === 0) return "noFire";
    if (etaToEmpty(energy, forecast.rate) <= lead) return "spawn";
    if (now - forecast.since >= FORECAST_PATIENCE && (forecast.rate === undefined || forecast.rate < MIN_RATE))
        return "noProgress";
    return "wait";
}
