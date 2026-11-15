/**
 * Source keeper mining rules (pure, offline check: tests/remoteRooms/run.mjs). Our design on Harabi's
 * recipe (an unboosted ATTACK19 HEAL6 MOVE25 killer per keeper room, waiting at the lair whose keeper
 * spawns first); Hivemind ports no keeper mining. shard0 2026-11-14: 6 remote sources left, every other
 * room within reach another player's, contested or a keeper room (W26N4-6, W25N4, W24N4), while the CPU
 * sat at ~20 of 70. See docs/decisions/economy.md.
 */

export const SOURCE_KEEPER = "Source Keeper";
/** Owners of NPC creeps and reservations: never another player */
export const NPC_OWNERS = ["Invader", SOURCE_KEEPER];

/**
 * The keeper killer fights at range 3: RANGED_ATTACK and HEAL (killerParts). Harabi's melee ATTACK19
 * HEAL6 MOVE25 (the spec's recipe) loses to the engine (@screeps/engine 2026-11-14): HEAL cancels a melee
 * ATTACK the same tick (creeps/intents.js priorities) and a keeper hits back 300 per melee hit
 * (_damage.js attackBackPower) on top of its 300 melee and 100 ranged, ~700 per tick against 5000 hits:
 * dead in 9 ticks, the keeper at 2870 (offline duel). At range 3 a keeper only deals 100 per tick (no
 * chase: it walks to its source) while RANGED_ATTACK and HEAL run together: RANGED12 HEAL5 MOVE17 kills
 * it in 42 ticks keeping 2260 of 3400 hits, RANGED17 HEAL7 in ~30.
 */
const RANGED_COST = 150;
const HEAL_COST = 250;
const MOVE_COST = 50;
const MIN_RANGED = 12;
const MAX_RANGED = 18;
const MIN_HEAL = 5;
const MAX_HEAL = 7;

export interface KillerParts {
    ranged: number;
    heal: number;
    move: number;
}

export function partsCost(p: KillerParts): number {
    return p.ranged * RANGED_COST + p.heal * HEAL_COST + p.move * MOVE_COST;
}

/** The biggest killer a home of `capacity` energy spawns (HEAL ~5/12 of RANGED, one MOVE each), none under the least */
export function killerParts(capacity: number): KillerParts | undefined {
    for (let ranged = MAX_RANGED; ranged >= MIN_RANGED; ranged--) {
        const heal = Math.min(MAX_HEAL, Math.max(MIN_HEAL, Math.round((ranged * MIN_HEAL) / MIN_RANGED)));
        const parts = { ranged, heal, move: ranged + heal };
        if (partsCost(parts) <= capacity) return parts;
    }
    return undefined;
}

/** Energy of the least keeper killer, RANGED12 HEAL5 MOVE17 */
export const KEEPER_KILLER_COST = partsCost({ ranged: MIN_RANGED, heal: MIN_HEAL, move: MIN_RANGED + MIN_HEAL });
/** Its parts (the selection prices the least killer) */
export const KEEPER_KILLER_PARTS = 2 * (MIN_RANGED + MIN_HEAL);

/** Least RCL of a home mining a keeper room: 5600 energy for the 4270 killer */
export const KEEPER_MIN_RCL = 7;
/** Rooms (route length) between a home and a keeper room it mines */
export const KEEPER_RANGE = 2;
/** Civilians stay out of this range of a live keeper (its ranged attack reaches 3) */
export const KEEPER_FLEE_RANGE = 3;
/** A lair whose keeper spawns within this many ticks counts as a keeper */
export const LAIR_WARNING = 10;

export interface Point {
    x: number;
    y: number;
}

export interface KeeperFacts {
    /** Home controller level */
    rcl: number;
    /** Home energy capacity: the whole killer (KEEPER_KILLER_COST) or none */
    capacity: number;
    /** Rooms between the home and the keeper room (route length) */
    distance: number;
    /** An invader stronghold is active in the room (military intel coreLevel, before its collapse) */
    stronghold: boolean;
}

/**
 * A keeper room a home may mine: RCL 7+ with the energy for the whole killer, within 2 rooms, no active
 * stronghold. Mockup W7N3 rcl7 (2026-11-14): at 3300 capacity, extensions still building, the killer
 * came out at 36 parts (3190 energy) and three of them died for one keeper killed.
 */
export function keeperRoomCandidate(facts: KeeperFacts): boolean {
    if (facts.rcl < KEEPER_MIN_RCL || facts.capacity < KEEPER_KILLER_COST) return false;
    return facts.distance <= KEEPER_RANGE && !facts.stronghold;
}

function sectorCoords(roomName: string): { x: number; y: number } | undefined {
    const match = /^[WE](\d+)[NS](\d+)$/.exec(roomName);
    if (!match) return undefined;
    return { x: Number(match[1]) % 10, y: Number(match[2]) % 10 };
}

/** The room at the center (5,5) of its sector: no keepers, no controller, 3 sources of 4000 */
export function isSectorCenter(roomName: string): boolean {
    const c = sectorCoords(roomName);
    return !!c && c.x === 5 && c.y === 5;
}

/** A keeper room (name or intel) or a sector center: its sources hold 4000 and it has no controller */
export function isKeeperOrCenter(roomName: string, hasSourceKeepers = false): boolean {
    if (hasSourceKeepers) return true;
    const c = sectorCoords(roomName);
    return !!c && c.x >= 4 && c.x <= 6 && c.y >= 4 && c.y <= 6;
}

function range(a: Point, b: Point): number {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

export interface LairState extends Point {
    id: string;
    /** Undefined while its keeper is alive */
    ticksToSpawn?: number;
}

/**
 * The killer's target: the closest live keeper by the guarded sources, else the guarded lair whose keeper
 * spawns first (ties: closest), so it stands there when the keeper appears
 */
export function keeperTarget(
    pos: Point,
    keepers: (Point & { id: string })[],
    lairs: LairState[]
): { kind: "keeper" | "lair"; id: string } | undefined {
    if (keepers.length > 0) {
        const keeper = keepers.reduce((best, k) => (range(pos, k) < range(pos, best) ? k : best));
        return { kind: "keeper", id: keeper.id };
    }
    if (lairs.length === 0) return undefined;
    const spawnIn = (lair: LairState) => lair.ticksToSpawn ?? Infinity;
    const lair = lairs.reduce((best, l) => {
        const diff = spawnIn(l) - spawnIn(best);
        return diff < 0 || (diff === 0 && range(pos, l) < range(pos, best)) ? l : best;
    });
    return { kind: "lair", id: lair.id };
}

/** A keeper walks from its lair to the resource within this range (engine keepers/pretick.js) */
const KEEPER_SOURCE_RANGE = 5;

/**
 * Points a civilian keeps out of KEEPER_FLEE_RANGE of: live keepers, lairs spawning within LAIR_WARNING
 * and the sources such a lair's keeper walks to. Mockup W7N3 rcl7 (2026-11-14): with the lair alone,
 * W6N4:15:43 lost 7 harvesters: the keeper spawned 4 tiles away and walked onto the source, the
 * harvester on its container (out of range 3 of the lair) only fled once hit, too slow on road MOVE.
 */
export function keeperDangers(
    keepers: Point[],
    lairs: (Point & { ticksToSpawn?: number })[],
    sources: Point[] = []
): Point[] {
    const soon = lairs.filter(l => l.ticksToSpawn !== undefined && l.ticksToSpawn <= LAIR_WARNING);
    const walkedTo = sources.filter(s => soon.some(l => range(l, s) <= KEEPER_SOURCE_RANGE));
    return [...keepers, ...soon, ...walkedTo].map(p => ({ x: p.x, y: p.y }));
}

export function inKeeperDanger(pos: Point, dangers: Point[]): boolean {
    return dangers.some(d => range(pos, d) <= KEEPER_FLEE_RANGE);
}

/**
 * The move targets a civilian keeps: out of a keeper's reach it never steps into it (only the safe
 * targets, else it stays put); inside, every target stays so it can flee. shard0 2026-11-15: civilians
 * fled out of range 3 of a keeper once hit, then their path stepped back in the next tick, hit again
 * on every pickup attempt until the killer cleared the keeper (mockup W6N4: harvesters 28,7 <-> 27,6,
 * hit every other tick). Targets in another room (`roomName` set and different from the creep's) are
 * kept: the dangers are the creep's room's. Nothing dropped: the same array (callers compare references).
 */
export function safeStepTargets<T extends Point & { roomName?: string }>(from: T, targets: T[], dangers: Point[]): T[] {
    if (dangers.length === 0 || inKeeperDanger(from, dangers)) return targets;
    const safe = targets.filter(t => (t.roomName !== undefined && t.roomName !== from.roomName) || !inKeeperDanger(t, dangers));
    if (safe.length === targets.length) return targets;
    return safe.length > 0 ? safe : [from];
}

/**
 * A keeper room's harvesters are spawned only while a killer is in the room. shard0 2026-11-14: with
 * "spawning or alive", harvesters (69 ticks to spawn) reached W26N4 before their killer (150 ticks):
 * W27N5 spawned 24 remote harvesters in 700 ticks and its storage fell from 49k to 21k.
 */
export function keeperRoomHeld(killers: { spawning?: boolean; inRoom: boolean }[]): boolean {
    return killers.some(k => !k.spawning && k.inRoom);
}

/**
 * A new killer is due once none spawning or alive outlives `lead` ticks (its spawn time and travel):
 * the successor reaches the room as the old one dies
 */
export function killerNeeded(killers: { spawning?: boolean; ticksToLive?: number }[], lead: number): boolean {
    return !killers.some(k => k.spawning || (k.ticksToLive ?? 0) > lead);
}
