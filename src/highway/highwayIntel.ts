/**
 * Highway intel (pure, offline check: tests/highway/run.mjs): deposits and power banks seen in highway
 * rooms, recorded by modules/IntelManager.ts in `Memory.highwayIntel`.
 *
 * Measurement only, not in Hivemind's port: before harvesting deposits or power banks (Hivemind's
 * harvester.deposit, harvester.power, hauler.power), count how many usable ones appear around our rooms
 * per 10000 ticks (`node scripts/live-inspect.mjs`, section "Highway"). Below ~1 the feature is not built.
 */

/** Rooms from the closest owned room within which an object counts as usable */
export const HIGHWAY_MAX_DISTANCE = 3;
/** Highest deposit cooldown (lastCooldown) still worth harvesting: it grows with every harvest */
export const DEPOSIT_MAX_COOLDOWN = 50;
/** Smallest power bank worth a squad */
export const POWER_BANK_MIN_POWER = 1000;
/** Power bank ticks left at first sighting: spawn, travel and 2M hits for a few attack / heal duos */
export const POWER_BANK_MIN_TICKS = 3000;
/** Attack tiles a power bank needs (one duo attacker per tile) */
export const POWER_BANK_MIN_FREE = 2;
/** Entries are kept this long after they decayed, so the rate covers a long window */
export const HIGHWAY_LOG_KEEP = 50000;

export interface HighwaySighting {
    id: string;
    kind: "deposit" | "powerBank";
    x: number;
    y: number;
    /** Deposit type */
    type?: DepositConstant;
    /** Deposit lastCooldown */
    cooldown?: number;
    /** Power bank power and hits */
    power?: number;
    hits?: number;
    ticksToDecay: number;
    /** Walkable tiles around the object */
    free: number;
}

export interface HighwayObject {
    room: string;
    kind: HighwaySighting["kind"];
    x: number;
    y: number;
    type?: DepositConstant;
    cooldown?: number;
    power?: number;
    hits?: number;
    free: number;
    firstSeen: number;
    lastSeen: number;
    /** Tick it decays at, as of the last sighting (a harvested deposit pushes it back) */
    decayAt: number;
    /** Closest owned room and its linear distance at the first sighting */
    home?: string;
    distance?: number;
    /** Usable on at least one sighting */
    usable: boolean;
}

export interface HighwayLog {
    /** First tick of the measurement window */
    since: number;
    objects: { [id: string]: HighwayObject };
}

export interface HighwayHome {
    name: string;
    distance: number;
}

function usableNow(sighting: HighwaySighting, home: HighwayHome | undefined): boolean {
    if (!home || home.distance > HIGHWAY_MAX_DISTANCE) return false;
    if (sighting.kind === "deposit") return (sighting.cooldown ?? Infinity) <= DEPOSIT_MAX_COOLDOWN;
    return (
        (sighting.power ?? 0) >= POWER_BANK_MIN_POWER &&
        sighting.ticksToDecay >= POWER_BANK_MIN_TICKS &&
        sighting.free >= POWER_BANK_MIN_FREE
    );
}

/** Record the deposits and power banks visible in a highway room */
export function recordSightings(
    log: HighwayLog,
    room: string,
    sightings: HighwaySighting[],
    now: number,
    home: HighwayHome | undefined
): void {
    for (const s of sightings) {
        const known = log.objects[s.id];
        if (known) {
            known.lastSeen = now;
            known.decayAt = now + s.ticksToDecay;
            known.cooldown = s.cooldown;
            known.hits = s.hits;
            // A power bank is judged on its first sighting: its ticks left only shrink
            if (s.kind === "deposit") known.usable = known.usable || usableNow(s, home);
            continue;
        }
        log.objects[s.id] = {
            room,
            kind: s.kind,
            x: s.x,
            y: s.y,
            type: s.type,
            cooldown: s.cooldown,
            power: s.power,
            hits: s.hits,
            free: s.free,
            firstSeen: now,
            lastSeen: now,
            decayAt: now + s.ticksToDecay,
            home: home?.name,
            distance: home?.distance,
            usable: usableNow(s, home)
        };
    }
}

/** Drop entries that decayed more than HIGHWAY_LOG_KEEP ticks ago */
export function pruneHighwayLog(log: HighwayLog, now: number): void {
    for (const id in log.objects) {
        if (now - log.objects[id].decayAt > HIGHWAY_LOG_KEEP) delete log.objects[id];
    }
}

export interface HighwaySummary {
    ticks: number;
    deposits: number;
    usableDeposits: number;
    powerBanks: number;
    usablePowerBanks: number;
    usableDepositsPer10k: number;
    usablePowerBanksPer10k: number;
}

/** Objects seen and usable since the window start, and the usable ones per 10000 ticks */
export function summarizeHighwayLog(log: HighwayLog, now: number): HighwaySummary {
    const objects = Object.values(log.objects);
    const count = (kind: HighwayObject["kind"], usable: boolean) =>
        objects.filter(o => o.kind === kind && (!usable || o.usable)).length;
    const ticks = Math.max(0, now - log.since);
    const per10k = (n: number) => (ticks > 0 ? (n * 10000) / ticks : 0);
    const usableDeposits = count("deposit", true);
    const usablePowerBanks = count("powerBank", true);
    return {
        ticks,
        deposits: count("deposit", false),
        usableDeposits,
        powerBanks: count("powerBank", false),
        usablePowerBanks,
        usableDepositsPer10k: per10k(usableDeposits),
        usablePowerBanksPer10k: per10k(usablePowerBanks)
    };
}
