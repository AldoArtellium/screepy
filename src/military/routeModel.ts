/**
 * Room route of a squad and the obstacles of the rooms on it, from plain values (no game objects:
 * offline check node tests/squadRoute/run.mjs). See military/route.ts for how they are read.
 */

import { isKeeperRoom } from "../utils/rooms";

/**
 * Cost of a room entered on the route (Game.map.findRoute): our rooms and remotes, then neutral
 * rooms, then other players' remotes; their rooms (towers) and source keeper rooms are never crossed,
 * except the target.
 * With these, an enemy remote is crossed rather than a detour of 3+ neutral rooms.
 */
export const ROUTE_COST = { ally: 1, neutral: 2, enemyRemote: 5 };

export interface RouteRoomInfo {
    owner?: string;
    reserver?: string;
}

// Keeper rooms (utils/rooms.ts isKeeperRoom): shard0 2026-10-25, the W27N9 quad routed through W26N5 got
// ERR_NO_PATH from cartographer on every step, ~5 CPU per tick, and keepers around
export function routeRoomCost(
    roomName: string,
    target: string,
    info: RouteRoomInfo | undefined,
    me: string | undefined,
    ourRemote: boolean
): number {
    if (roomName === target) return ROUTE_COST.ally;
    if (isKeeperRoom(roomName)) return Infinity;
    if (info?.owner) return info.owner === me ? ROUTE_COST.ally : Infinity;
    // A reservation by another player wins over our selection: their creeps are around
    if (info?.reserver && info.reserver !== me && info.reserver !== "Invader") return ROUTE_COST.enemyRemote;
    if (info?.reserver === me || ourRemote) return ROUTE_COST.ally;
    return ROUTE_COST.neutral;
}

/**
 * Last obstacle matrix of each room, kept once the room is out of sight (without it an unseen room
 * looked empty to PathFinder). Recomputed every `refresh` ticks while visible, dropped `ttl` ticks
 * after it was last computed, at most `capacity` rooms (the least recently computed go first).
 */
export class ObstacleCache<T> {
    private readonly entries: Map<string, { tick: number; value: T }> = new Map();

    constructor(
        private readonly refresh: number,
        private readonly ttl: number,
        private readonly capacity: number
    ) {}

    get size(): number {
        return this.entries.size;
    }

    /** The room's matrix, undefined when out of sight and unknown or too old */
    get(roomName: string, now: number, visible: boolean, compute: () => T): T | undefined {
        const entry = this.entries.get(roomName);
        if (visible) {
            if (entry && now - entry.tick < this.refresh) return entry.value;
            const value = compute();
            // Re-inserted: the map's order stays the order of the last computation
            this.entries.delete(roomName);
            this.entries.set(roomName, { tick: now, value });
            while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value as string);
            return value;
        }
        if (entry && now - entry.tick < this.ttl) return entry.value;
        if (entry) this.entries.delete(roomName);
        return undefined;
    }
}
