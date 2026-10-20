/**
 * Remote paths blocked by structures (walls, others' ramparts, abandoned buildings) and the spawn
 * role of the dismantler that opens them.
 * Ported from Hivemind (MIT): operation/remote-mining.ts needsDismantler / getDismantlePositions,
 * spawn-role/dismantler.ts addOperationDismantlers (priority 3, weight 0, WORK body). The
 * International (remoteDismantler) does the same per remote.
 *
 * Deviations: one dismantler per home room for every blocked tile of its remotes (Hivemind: one per
 * source, while remotes often share the blocked part of their paths); a blocker no dismantler can
 * remove (too many hits, novice wall, invader core) makes the path searched again around it.
 */

import { buildBody, MoveMode } from "../core/bodyBuilder";
import { creepsByRole } from "../core/roomState";
import { ENEMY_STRENGTH_NORMAL, enemyStrength } from "../defense/RoomDefense";
import type { SpawnOption, SpawnRole } from "../spawning/spawnRoles";
import { jitter } from "../utils/jitter";
import { canDismantle, isBlocking } from "./blockers";
import { forgetRemotePath, isRemoteUnderAttack, remotePath, RemoteSource, remoteSources } from "./RemoteMining";

export const DISMANTLER = "dismantler";

/** Positions are refreshed every ~50 ticks; the dismantler checks its own target every tick */
const BLOCKED_TTL = 50;
/** A path is searched again at most once per 1000 ticks per source */
const REPATH_INTERVAL = 1000;
/** 25 WORK: 1250 hits per tick, a 200k wall in 160 ticks */
const MAX_WORK = 25;

/** Blocked tiles of each source's path (heap); tiles of rooms out of sight keep their last state */
const blockedCache: Map<string, { until: number; positions: RoomPosition[] }> = new Map();
const repathedAt: Map<string, number> = new Map();

function blockersAt(pos: RoomPosition): Structure[] {
    return pos.lookFor(LOOK_STRUCTURES).filter(isBlocking);
}

/**
 * Tiles of a source's path, outside our rooms, with a structure creeps can't cross, from the home
 * side to the source (Hivemind walks the path from the storage too): a dismantler reaches each one
 * from the open side
 */
export function dismantlePositions(source: RemoteSource): RoomPosition[] {
    const cached = blockedCache.get(source.key);
    if (cached && cached.until > Game.time) return cached.positions;
    const known = new Set((cached?.positions ?? []).map(p => `${p.roomName}:${p.x}:${p.y}`));
    const path = remotePath(source);
    const positions: RoomPosition[] = [];
    for (let i = path.length - 1; i >= 0; i--) {
        const pos = path[i];
        const room = Game.rooms[pos.roomName];
        if (room?.controller?.my) continue;
        if (!room) {
            if (known.has(`${pos.roomName}:${pos.x}:${pos.y}`)) positions.push(pos);
            continue;
        }
        const blockers = blockersAt(pos);
        if (blockers.length === 0) continue;
        if (!blockers.every(canDismantle)) {
            // Walk around it instead (the cost matrix now prices it 255)
            if (Game.time - (repathedAt.get(source.key) ?? -REPATH_INTERVAL) >= REPATH_INTERVAL) {
                repathedAt.set(source.key, Game.time);
                forgetRemotePath(source, pos.roomName);
            }
            blockedCache.set(source.key, { until: Game.time + jitter(BLOCKED_TTL), positions: [] });
            return [];
        }
        positions.push(pos);
    }
    blockedCache.set(source.key, { until: Game.time + jitter(BLOCKED_TTL), positions });
    return positions;
}

/** Blocked tiles of a home's remotes not under attack, closest source first, without duplicates */
export function dismantleTargets(homeRoom: string): RoomPosition[] {
    const seen = new Set<string>();
    const targets: RoomPosition[] = [];
    for (const source of remoteSources(homeRoom)) {
        if (isRemoteUnderAttack(source)) continue;
        for (const pos of dismantlePositions(source)) {
            const key = `${pos.roomName}:${pos.x}:${pos.y}`;
            if (seen.has(key)) continue;
            seen.add(key);
            targets.push(pos);
        }
    }
    return targets;
}

/** The blocker a dismantler works on at a tile (a rampart first: dismantle hits it anyway) */
export function dismantleTarget(pos: RoomPosition): Structure | undefined {
    const blockers = blockersAt(pos).filter(canDismantle);
    return blockers.find(s => s.structureType === STRUCTURE_RAMPART) ?? blockers[0];
}

/** Hivemind spawn-role/dismantler.ts: one per home with blocked remote paths, priority 3, weight 0 */
export const dismantlerSpawnRole: SpawnRole = {
    id: DISMANTLER,
    emptyTimeout: 50,

    options(home: Room): SpawnOption[] {
        if (enemyStrength(home) >= ENEMY_STRENGTH_NORMAL) return [];
        if (creepsByRole(home.name, DISMANTLER).length > 0) return [];
        if (dismantleTargets(home.name).length === 0) return [];
        return [{ role: DISMANTLER, priority: 3, weight: 0 }];
    },

    body(home: Room): BodyPartConstant[] {
        return buildBody({
            weights: { [WORK]: 1 },
            partLimits: { [WORK]: MAX_WORK },
            moveMode: MoveMode.PLAINS,
            energyLimit: Math.min(home.energyCapacityAvailable, Math.max(home.energyCapacityAvailable * 0.9, home.energyAvailable))
        });
    },

    memory(home: Room): Partial<CreepMemory> {
        return { role: DISMANTLER, room: home.name };
    }
};
