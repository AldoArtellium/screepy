/**
 * Path reuse of a duo's attacker (pure, offline check: tests/duoPath/run.mjs), used by duo.ts.
 *
 * Not in Hivemind or The International. shard0 2026-10-26: a duo against W29N3 kept the Military module
 * at ~1.9 CPU per tick for ~4000 ticks (0.1 before) while its attacker barely moved: a multi-room
 * PathFinder search (maxOps 4000) every tick outside the target room, a structure scan and a search
 * every tick inside. A path is now searched once and its next tile reused while the attacker stands on
 * it; it is searched again when the goal changes (key), the attacker is off the path, the next tile is
 * the healer's, leaves the allowed rooms, a requested step left the attacker in place BLOCKED_TICKS
 * ticks in a row, or after its lifetime.
 */

export interface Tile {
    x: number;
    y: number;
    roomName: string;
}

export interface DuoPath<T extends Tile = Tile> {
    /** Goal of the path (mode, goal room or target id): another goal searches again */
    key: string;
    /** Tile the search started from (PathFinder paths leave it out) */
    origin: T;
    path: T[];
    /** Expiry tick */
    until: number;
    /** Index in `path` of the tile the attacker was last seen on (-1: the origin) */
    index: number;
    /** Requested steps in a row that left the attacker where it was */
    blocked: number;
    /** Tile and tick of the last requested step */
    stepFrom?: string;
    stepAt?: number;
}

/** Requested steps without moving before the path is searched again */
export const BLOCKED_TICKS = 3;
/** Ticks an advancing attacker outside the target room may stand still before its path is dropped */
export const STILL_TICKS = 50;

export function tileKey(t: Tile): string {
    return `${t.roomName}:${t.x}:${t.y}`;
}

export function sameTile(a: Tile, b: Tile): boolean {
    return a.x === b.x && a.y === b.y && a.roomName === b.roomName;
}

export function newPath<T extends Tile>(key: string, origin: T, path: T[], now: number, ttl: number): DuoPath<T> {
    return { key, origin, path, until: now + ttl, index: -1, blocked: 0 };
}

/** Index of pos on the path (-1: the origin), null when off it; looks ahead of the last index first */
function indexOn(cache: DuoPath, pos: Tile): number | null {
    if (sameTile(cache.origin, pos)) return -1;
    const { path } = cache;
    for (let i = Math.max(0, cache.index); i < path.length; i++) if (sameTile(path[i], pos)) return i;
    for (let i = 0; i < Math.max(0, cache.index) && i < path.length; i++) if (sameTile(path[i], pos)) return i;
    return null;
}

/**
 * Next tile of the cached path for an attacker on pos, null when the path must be searched again.
 * `avoid`: the healer's tile (the search keeps off it); `allowed`: rooms the squad may enter now.
 */
export function cachedStep<T extends Tile>(
    cache: DuoPath<T> | undefined,
    key: string,
    pos: Tile,
    now: number,
    avoid?: Tile,
    allowed?: Set<string>
): T | null {
    if (!cache || cache.key !== key || now >= cache.until) return null;
    if (cache.stepAt === now - 1) {
        cache.blocked = cache.stepFrom === tileKey(pos) ? cache.blocked + 1 : 0;
        if (cache.blocked >= BLOCKED_TICKS) return null;
    }
    const i = indexOn(cache, pos);
    if (i === null) return null;
    const next = cache.path[i + 1];
    if (!next || (avoid && sameTile(next, avoid))) return null;
    if (allowed) for (let j = i + 1; j < cache.path.length; j++) if (!allowed.has(cache.path[j].roomName)) return null;
    cache.index = i;
    return next;
}

/** Records a step requested from pos (blocked detection on the next tick) */
export function noteStep(cache: DuoPath | undefined, pos: Tile, now: number): void {
    if (!cache) return;
    cache.stepFrom = tileKey(pos);
    cache.stepAt = now;
}

export interface StillState {
    pos: string;
    since: number;
    /** Last tick the creep was tracked */
    seen: number;
}

/**
 * Whether a creep has stood on the same tile for `limit` ticks (the count then restarts); a tick
 * without tracking (another state) restarts it too. Updates the state in place.
 */
export function stillFor(state: StillState, pos: Tile, now: number, limit: number): boolean {
    const key = tileKey(pos);
    const restart = state.pos !== key || state.seen < now - 1;
    state.seen = now;
    if (restart || now - state.since >= limit) {
        const still = !restart;
        state.pos = key;
        state.since = now;
        return still;
    }
    return false;
}
