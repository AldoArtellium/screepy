import { BodyType } from "./config/bodyTypes";
import { CreepTaskState, PartDemand, Task } from "./types/TaskTypes";

declare global {
    interface Memory {
        rooms: Record<string, RoomMemory>;
        creeps: Record<string, any>;
        spawn: {
            // Legacy - kept for compatibility during transition
            desiredCounts?: { [role: string]: number };
            currentCounts?: { [role: string]: number };
        };
        init: boolean;
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
    }

    interface CreepMemory {
        // Body type for task assignment
        bodyType?: BodyType;
        // Home room assignment
        room?: string;
        // Current task state
        currentTask?: CreepTaskState;
        // Legacy fields - kept for compatibility
        role?: string;
        state?: "acquiring" | "executing";
        targetRoom?: string;
        targetId?: Id<any>;
        targetTick?: number;
        patrolIndex?: number;
        // Traffic system
        _path?: string;
        _pathTick?: number;
        _pathTarget?: string;
        squad?: string;
    }

    interface ObserverMemory {
        targetRoom?: string;
    }

    interface RoomMemory {
        sources: { [id: Id<Source>]: ISourceMemory };
        constructionSites: { [id: Id<ConstructionSite>]: boolean };
        threatLevel?: number;
        threatLevelLastTick?: number;
        phase?: RoomPhase;
        defenseMode?: boolean;
        phaseData?: {
            lastEvaluation: number;
            transitionTick?: number;
            targetPhase?: RoomPhase;
            extensionsPlanned?: boolean;
            roadsPlanned?: boolean;
        };
        patrolPoints?: { x: number; y: number }[];
        // Task system
        taskQueue?: Task[];
        partDemand?: PartDemand;
        // Traffic system
        idlePositions?: { x: number; y: number }[];
        lastConstructionChange?: number;
        // Remote/expansion system
        bootstrapTargets?: string[];
        intel?: RoomIntel;
        remoteRooms?: string[];
        claimTarget?: string;
    }

    const enum RoomPhase {
        EMERGENCY = 0,
        BOOTSTRAP = 1,
        FOUNDATION = 2,
        EXPANSION = 3,
        ESTABLISHED = 4,
        ADVANCED = 5,
        DOMINANT = 6
    }

    interface ISourceMemory {
        distance: number;
        miners: string[];
        container?: Id<StructureContainer>;
        containerSite?: Id<ConstructionSite>;
        link?: string;
    }
}

export {};
