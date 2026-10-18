declare global {
    interface Memory {
        rooms: Record<string, RoomMemory>;
        creeps: Record<string, any>;
        logLevel?: number;
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
        /** Heap (Game.cpu.getHeapStatistics, every 10 ticks): used + external bytes, limit, used / limit */
        heap?: { used: number; limit: number; ratio: number };
        /** CPU of the last Memory parse (once per global reset, MemHack) */
        memoryParse?: number;
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
        avgCpu?: number;
        /** Ticks the module was due but held back by bucket throttling */
        throttled?: number;
    }

    interface CreepMemory {
        /** Role, run by the handler registered for it (roles/registry.ts) */
        role?: string;
        /** Home room */
        room?: string;
        targetRoom?: string;
    }
}

export {};
