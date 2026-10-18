/**
 * RoomPlan - planned positions by location type ("extension.bay.0", "road.source", "harvester.<id>"...)
 *
 * A tile can carry several types. Positions are kept as `x + 50 * y` and returned in that order
 * (row by row), like Hivemind's RoomPlan (MIT, src/room/planner/room-plan.ts).
 * Stored packed (RoomPlanner, RawMemory segments): one UTF-16 char per position, ((x << 6) | y) + 65.
 */

/** Bump to replan every room (format or algorithm change) */
export const PLAN_VERSION = 4;
/** Older version still used as is, then extended in place (RoomPlanner extendRoomPlan): 3 = no labs,
 * power spawn, nuker, observer nor helper parking */
export const EXTENDABLE_PLAN_VERSION = 3;

export interface PlanMemory {
    /** Plan version (PLAN_VERSION) */
    v: number;
    /** Packed positions by location type */
    t: { [type: string]: string };
    /** Variation key and score (RoomPlanner) */
    k?: string;
    s?: number;
    /** Every variation was tried */
    done?: boolean;
}

declare global {
    interface RoomMemory {
        /** Legacy: plans live in segments now (RoomPlanner), migrated then deleted */
        plan?: PlanMemory;
    }
}

export class RoomPlan {
    private readonly positions: Map<string, Set<number>> = new Map();

    constructor(readonly roomName: string) {}

    add(type: string, x: number, y: number): void {
        let set = this.positions.get(type);
        if (!set) {
            set = new Set();
            this.positions.set(type, set);
        }
        set.add(x + 50 * y);
    }

    remove(type: string, x: number, y: number): void {
        this.positions.get(type)?.delete(x + 50 * y);
    }

    removeType(type: string): void {
        this.positions.delete(type);
    }

    has(pos: { x: number; y: number }, type: string): boolean {
        return this.positions.get(type)?.has(pos.x + 50 * pos.y) ?? false;
    }

    count(type: string): number {
        return this.positions.get(type)?.size ?? 0;
    }

    types(): string[] {
        return [...this.positions.keys()];
    }

    /** Positions of a type, row by row (y then x) */
    getLocations(type: string): RoomPosition[] {
        const set = this.positions.get(type);
        if (!set) return [];
        return [...set].sort((a, b) => a - b).map(i => new RoomPosition(i % 50, Math.floor(i / 50), this.roomName));
    }

    /** Base center: energy is dropped there before the storage exists */
    getCenter(): RoomPosition | null {
        return this.getLocations("center")[0] ?? null;
    }

    serialize(): PlanMemory {
        const t: { [type: string]: string } = {};
        for (const [type, set] of this.positions) {
            if (set.size === 0) continue;
            t[type] = [...set]
                .sort((a, b) => a - b)
                .map(i => String.fromCharCode((((i % 50) << 6) | Math.floor(i / 50)) + 65))
                .join("");
        }
        return { v: PLAN_VERSION, t };
    }

    static deserialize(roomName: string, memory: PlanMemory): RoomPlan {
        const plan = new RoomPlan(roomName);
        for (const type in memory.t) {
            const packed = memory.t[type];
            for (let i = 0; i < packed.length; i++) {
                const code = packed.charCodeAt(i) - 65;
                plan.add(type, code >> 6, code & 63);
            }
        }
        return plan;
    }
}
