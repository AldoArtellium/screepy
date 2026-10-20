/**
 * Structures that block a remote path outside our rooms, and what a dismantler can remove.
 * Hivemind (MIT) lets remote paths ignore structures out of its rooms and sends a dismantler to the
 * blocked tiles (operation/remote-mining.ts getDismantlePositions); here a visible blocker is priced
 * by its hits instead, so a path only goes through walls that are cheap to open.
 * No imports: used by RemoteMining's cost matrix and by the dismantler code alike.
 */

/** Above this many hits a blocker is walked around (a 10 WORK dismantler takes 400 ticks for 200k) */
export const MAX_DISMANTLE_HITS = 200000;

/** Creeps can't step on it: obstacles, and ramparts neither ours nor public */
export function isBlocking(structure: Structure): boolean {
    if (structure.structureType === STRUCTURE_RAMPART) {
        const rampart = structure as StructureRampart;
        return !rampart.my && !rampart.isPublic;
    }
    return (OBSTACLE_OBJECT_TYPES as string[]).includes(structure.structureType);
}

/**
 * A dismantler can take it down: not ours, buildable (not invader cores, keeper lairs, power banks,
 * portals), not a novice area wall, with at most MAX_DISMANTLE_HITS hits
 */
export function canDismantle(structure: Structure): boolean {
    if ((structure as OwnedStructure).my) return false;
    if (!(structure.structureType in CONSTRUCTION_COST)) return false;
    // Novice area walls (they disappear on their own)
    if ((structure as StructureWall).ticksToLive !== undefined) return false;
    return typeof structure.hits === "number" && structure.hits > 0 && structure.hits <= MAX_DISMANTLE_HITS;
}

/**
 * Remote path cost of a structure's tile in a room we don't own: 0 when walkable, 255 when it can't
 * be dismantled, else 10 + 1 per 1000 hits (a 1-hit wall is worth a ~5 tile detour on plains)
 */
export function blockerCost(structure: Structure): number {
    if (!isBlocking(structure)) return 0;
    if (!canDismantle(structure)) return 255;
    return Math.min(254, 10 + Math.ceil(structure.hits / 1000));
}
