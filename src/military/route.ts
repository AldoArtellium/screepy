/**
 * Squad travel between rooms: the room route first (Game.map.findRoute, rooms ranked by
 * routeModel.ts: ours, neutral, other players' remotes, never their rooms but the target), then
 * PathFinder held to the rooms of that route; and the obstacles of each room kept once out of sight.
 */

import { intelManager } from "../modules/IntelManager";
import { jitter } from "../utils/jitter";
import { roomStatus } from "../utils/rooms";
import { ObstacleCache, RouteRoomInfo, routeRoomCost } from "./routeModel";

/** Route of a pair of rooms, reused this long (intel changes slowly, the squad moves room by room) */
const ROUTE_TTL = 50;
/** Obstacles of a visible room recomputed every 20 ticks, kept 20000 ticks out of sight, 100 rooms */
const obstacles = new ObstacleCache<CostMatrix>(20, 20000, 100);

const routes: Map<string, { until: number; rooms: string[] | null }> = new Map();

/** Owner and reserver of a room: live when visible, else the intel */
function roomInfo(roomName: string): RouteRoomInfo | undefined {
    const controller = Game.rooms[roomName]?.controller;
    if (controller) return { owner: controller.owner?.username, reserver: controller.reservation?.username };
    return intelManager.getIntel(roomName);
}

/** Rooms of the selected remote sources (ours even before our reserver gets there) */
function remoteRooms(): Set<string> {
    const rooms = new Set<string>();
    for (const key in Memory.remoteMining?.sources ?? {}) rooms.add(Memory.remoteMining!.sources[key].room);
    return rooms;
}

/** Rooms from `from` to `to` (both included), null when every route crosses another player's room */
export function squadRoute(from: string, to: string): string[] | null {
    if (from === to) return [from];
    const key = `${from}>${to}`;
    const cached = routes.get(key);
    if (cached && cached.until > Game.time) return cached.rooms;
    const ours = remoteRooms();
    const zone = roomStatus(from);
    const route = Game.map.findRoute(from, to, {
        routeCallback: roomName =>
            routeRoomCost(roomName, to, roomInfo(roomName), Memory.username, ours.has(roomName), roomStatus(roomName) === zone)
    });
    const rooms = route === ERR_NO_PATH ? null : [from, ...route.map(step => step.room)];
    if (routes.size > 200) routes.clear();
    routes.set(key, { until: Game.time + jitter(ROUTE_TTL), rooms });
    return rooms;
}

/**
 * Rooms a squad's PathFinder search may enter: its room route plus the rooms its members stand in
 * (one pushed off the route by an exit tile walks back). Null when there is no route.
 */
export function routeRooms(from: string, to: string, members: RoomPosition[] = []): Set<string> | null {
    const rooms = squadRoute(from, to);
    if (!rooms) return null;
    const allowed = new Set(rooms);
    for (const pos of members) allowed.add(pos.roomName);
    return allowed;
}

/** Obstacle matrix of a room: computed while visible, the last one seen once out of sight */
export function cachedObstacles(roomName: string, compute: (room: Room) => CostMatrix): CostMatrix | undefined {
    const room = Game.rooms[roomName];
    return obstacles.get(roomName, Game.time, !!room, () => compute(room));
}
