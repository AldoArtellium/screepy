declare global {
    interface Memory {
        rooms: Record<string, RoomMemory>;
        creeps: Record<string, any>;
        logLevel?: number;
        // Traffic system
        pathCache?: {
            [key: string]: {
                /** Serialized path */
                p: string;
                /** Energy cost of path */
                c: number;
                /** Last used tick */
                u: number;
                /** Hit count for popularity */
                h: number;
            };
        };
        traffic?: {
            lastCleanup: number;
            invalidatedRooms: string[];
        };
        // Player username
        username?: string;
        // Module state for CPU optimization (skip tracking, lastRun persistence)
        moduleState?: { [name: string]: ModuleState };
        // Last module errors (ring buffer, read by the local test harness)
        moduleErrors?: { tick: number; module: string; message: string }[];
        // Bot stats for the local test harness
        stats?: BotStats;
    }

    interface BotStats {
        tick: number;
        cpu: number;
        cpuAvg: number;
        cpuMax: number;
        bucket: number;
        counters: { [name: string]: number };
        samples?: { [name: string]: string[] };
        rooms: {
            [roomName: string]: {
                rcl: number;
                progress: number;
                energyAvailable: number;
                energyCapacity: number;
                creeps: number;
                /** Creeps in the room by role */
                roles: { [role: string]: number };
                structures: number;
                constructionSites: number;
            };
        };
    }

    interface ModuleState {
        lastRun: number;
        consecutiveSkips: number;
        sleepUntil?: number;
        avgCpu?: number;
    }

    interface CreepMemory {
        /** Role, run by the handler registered for it (roles/registry.ts) */
        role?: string;
        /** Home room */
        room?: string;
        targetRoom?: string;
        targetId?: Id<any>;
        // Traffic system
        _path?: string;
        _pathTick?: number;
        _pathTarget?: string;
    }

    interface RoomMemory {
        // Traffic system
        idlePositions?: { x: number; y: number }[];
        // Remote/expansion system
        bootstrapTargets?: string[];
        remoteRooms?: string[];
        claimTarget?: string;
    }

    interface RemoteSummary {
        roomName: string;
        baseRoom: string;
        sourceCount: number;
        threat: boolean;
        miners: number;
        haulers: number;
    }
}

export {};
