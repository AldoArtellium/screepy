/**
 * Respawn and novice area walls: no `hits` (shard0 W24N8: `hitsMax` 300M and a real-time `decayTime`,
 * which the engine never turns into `ticksToLive`). destroy() returns OK on them but the engine drops
 * the intent. `ticksToLive` is still checked for older engines that set it.
 */
export function isIndestructible(structure: Structure): boolean {
    return typeof structure.hits !== "number" || (structure as StructureWall).ticksToLive !== undefined;
}
