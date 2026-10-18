/**
 * Expansion score of a room (higher = better place for a new base): sources, minerals we don't
 * have yet, remote sources around, remotes shared with our rooms, exits, walls and swamps, distance
 * to our rooms. Cached 20000 ticks per room in the heap.
 * Ported from Hivemind (MIT), src/process/strategy/scout.ts calculateExpansionScore and
 * getHarvestRoomScore. See docs/hivemind/hivemind-expansion.md §3.2.
 * Simplified: no exit direction is considered safe (Hivemind calculateAdjacentRoomSafety), so the
 * "safe exits" terms are 0 and every exit counts as unsafe.
 */

import { intelManager } from "../modules/IntelManager";
import { isHighway, roomStatus } from "../utils/rooms";

const SCORE_CACHE_TTL = 20000;
const MAX_ROOM_DISTANCE = 3;

const cache: Map<string, { tick: number; score: number }> = new Map();

function exitsOf(roomName: string): string[] {
    return Object.values(Game.map.describeExits(roomName) ?? {}) as string[];
}

function myRoomNames(): string[] {
    return _.filter(Game.rooms, r => !!r.controller?.my).map(r => r.name);
}

/** Value of a room as a remote of the candidate (Hivemind getHarvestRoomScore) */
export function harvestRoomScore(roomName: string): number {
    if (isHighway(roomName)) return 0;
    if (Game.rooms[roomName]?.controller?.my) return 0;
    const intel = intelManager.getIntel(roomName);
    if (!intel) return 0;
    let sourceFactor = intel.hasSourceKeepers ? 0.15 : 0.25;
    if (intel.owner && intel.owner !== "Invader" && intel.owner !== Memory.username) return -0.5;
    if (intel.reserver && intel.reserver !== "Invader" && intel.reserver !== Memory.username) sourceFactor = 0.1;
    return intelManager.sourceCount(roomName) * sourceFactor;
}

/** Exit, wall and swamp tiles (walls and swamps inside 1..48, exits = non-wall border tiles) */
function terrainCounts(roomName: string): { exit: number; wall: number; swamp: number } {
    const terrain = Game.map.getRoomTerrain(roomName);
    const counts = { exit: 0, wall: 0, swamp: 0 };
    for (let x = 0; x < 50; x++) {
        for (let y = 0; y < 50; y++) {
            const t = terrain.get(x, y);
            const border = x === 0 || y === 0 || x === 49 || y === 49;
            if (border) {
                if (t !== TERRAIN_MASK_WALL) counts.exit++;
            } else if (t === TERRAIN_MASK_WALL) counts.wall++;
            else if (t === TERRAIN_MASK_SWAMP) counts.swamp++;
        }
    }
    return counts;
}

function calculate(roomName: string): number {
    const intel = intelManager.getIntel(roomName);
    if (!intel?.controllerPos || intel.hasSourceKeepers) return 0;
    if (roomStatus(roomName) === "closed") return 0;

    let score = 2 * intelManager.sourceCount(roomName) - 2;
    const mine = myRoomNames();
    if (intel.mineralType) {
        // Our rooms are always visible: their mineral is read directly
        const owned = mine.filter(r => Game.rooms[r].find(FIND_MINERALS)[0]?.mineralType === intel.mineralType).length;
        score += 1 / (owned + 1);
    }

    // Remote rooms around: 1 for neighbours, 0.5 two exits away (Hivemind overwrites a neighbour's 1
    // with 0.5 when it is also two exits away; kept)
    const influence: { [room: string]: number } = {};
    for (const adjacent of exitsOf(roomName)) {
        influence[adjacent] = 1;
        for (const second of exitsOf(adjacent)) influence[second] = 0.5;
    }
    for (const room in influence) if (room !== roomName) score += influence[room] * harvestRoomScore(room);

    // Remotes shared with our rooms within 2, and losing the candidate as a remote of a neighbour
    for (const other of mine) {
        if (other === roomName) continue;
        const distance = Game.map.getRoomLinearDistance(roomName, other);
        if (distance > 2) continue;
        for (const adjacent of exitsOf(other)) {
            if (adjacent === roomName) score -= harvestRoomScore(adjacent);
            if (exitsOf(roomName).includes(adjacent)) score -= harvestRoomScore(adjacent);
        }
        if (distance > 1) continue;
        if (exitsOf(roomName).includes(other)) score -= harvestRoomScore(roomName);
    }

    // Defensibility: few exit tiles, few walls and swamps
    const tiles = terrainCounts(roomName);
    const exits = Math.max(1, exitsOf(roomName).length);
    score += 1 - tiles.exit * 0.005 * (4 / exits);
    score += 0.5 - tiles.wall * 0.0002;
    score += 0.25 - tiles.swamp * 0.0001;

    const others = mine.filter(r => r !== roomName);
    if (others.length > 0) {
        const distance = _.min(others.map(r => Game.map.getRoomLinearDistance(roomName, r)));
        if (distance > MAX_ROOM_DISTANCE) score -= distance - MAX_ROOM_DISTANCE;
    }
    return score;
}

export function expansionScore(roomName: string): number {
    const cached = cache.get(roomName);
    if (cached && Game.time - cached.tick < SCORE_CACHE_TTL) return cached.score;
    const score = calculate(roomName);
    cache.set(roomName, { tick: Game.time, score });
    return score;
}
