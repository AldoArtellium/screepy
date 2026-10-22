/**
 * Move resolution for one room: picks one tile per creep from its move intent so that every move
 * reaches the engine (no two creeps on a tile, no move into a tile whose occupant stays).
 *
 * cartographer's reconcileTraffic claims tiles greedily: a creep may claim a tile whose occupant
 * then gets no move, and swaps are only found when the occupant targets the claimer's tile. The
 * engine drops a move into a tile held by a creep that stays, and every move into that creep's tile
 * in turn, so one bad claim froze two opposite flows through a one-tile choke (shard0 W28N7,
 * 2026-10-21: 15 creeps still for 200-460 ticks). Here a creep that wants an occupied tile pushes
 * the occupant along its own intent first (chains, swaps and rotations), and a lower priority mover
 * that can't advance steps back onto the tile of the creep pushing it.
 */

/** A creep and its move intent, positions packed as numbers (same room: y * 50 + x) */
export interface TrafficCreep {
    id: string;
    pos: number;
    /** cartographer scale: higher = more important */
    priority: number;
    /** Acceptable tiles in order of preference; the creep's own tile first = it wants to stay */
    targets: number[];
}

export interface TrafficResult {
    /** Tile of every creep this tick (its own tile when it stays) */
    moves: Map<string, number>;
    /** Creeps moved off their tile to let another one in */
    pushed: number;
    /** Movers (own tile not among their targets) left in place */
    blocked: number;
}

/** Longest push chain followed (W28N7's jam needed 4) */
const MAX_DEPTH = 12;

/** Push attempts per room and tick, bounds the CPU in a crowded room */
const MAX_STEPS = 2000;

export function resolveTraffic(creeps: TrafficCreep[]): TrafficResult {
    const occupant = new Map<number, TrafficCreep>();
    for (const creep of creeps) occupant.set(creep.pos, creep);
    /** Tile -> creep moving to (or staying on) it, tentative while a push chain is being tried */
    const claimed = new Map<number, TrafficCreep>();
    const assigned = new Map<TrafficCreep, number>();
    /** Creeps of the push chain being tried: their tiles are being left */
    const visiting = new Set<TrafficCreep>();
    let steps = 0;
    let pushed = 0;

    const assign = (creep: TrafficCreep, tile: number): void => {
        claimed.set(tile, creep);
        assigned.set(creep, tile);
    };

    const isMover = (creep: TrafficCreep): boolean => !creep.targets.includes(creep.pos);

    /**
     * Places the creep on one of its targets. Passes: 0 free tiles and tiles already left, 1 tiles left
     * by the chain pushing it (swap or rotation), 2 occupants pushed along their own intent.
     */
    const tryTile = (creep: TrafficCreep, tile: number, pass: number, depth: number): boolean => {
        if (claimed.has(tile)) return false;
        const other = occupant.get(tile);
        if (tile === creep.pos || !other) {
            assign(creep, tile);
            return true;
        }
        const otherTile = assigned.get(other);
        if (otherTile !== undefined) {
            if (otherTile === tile) return false; // it stays
            assign(creep, tile);
            return true;
        }
        if (visiting.has(other)) {
            if (pass < 1) return false;
            assign(creep, tile);
            return true;
        }
        if (pass < 2) return false;
        claimed.set(tile, creep);
        if (place(other, depth + 1)) {
            assigned.set(creep, tile);
            pushed++;
            return true;
        }
        // A lower priority mover that can't advance steps back onto our tile
        if (isMover(other) && other.priority < creep.priority && !claimed.has(creep.pos)) {
            assigned.set(creep, tile);
            assign(other, creep.pos);
            pushed++;
            return true;
        }
        claimed.delete(tile);
        return false;
    };

    const place = (creep: TrafficCreep, depth: number): boolean => {
        if (depth > MAX_DEPTH || ++steps > MAX_STEPS) return false;
        visiting.add(creep);
        let placed = false;
        for (let pass = 0; pass < 3; pass++) {
            for (const tile of creep.targets) {
                if (tryTile(creep, tile, pass, depth)) {
                    placed = true;
                    break;
                }
            }
            if (placed) break;
        }
        visiting.delete(creep);
        return placed;
    };

    // cartographer's order: highest priority, then fewest targets, then registration order
    const order = creeps
        .map((creep, index) => ({ creep, index }))
        .sort(
            (a, b) =>
                b.creep.priority - a.creep.priority ||
                a.creep.targets.length - b.creep.targets.length ||
                a.index - b.index
        )
        .map(({ creep }) => creep);
    let blocked = 0;
    for (const creep of order) {
        if (assigned.has(creep) || place(creep, 0)) continue;
        // Stays: its tile was never claimed (failed pushes release their claims)
        assign(creep, creep.pos);
        if (isMover(creep)) blocked++;
    }

    const moves = new Map<string, number>();
    for (const [creep, tile] of assigned) moves.set(creep.id, tile);
    return { moves, pushed, blocked };
}
