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
        // Metrics system for dashboard
        metrics?: MetricsMemory;
        // Debug mode for detailed dashboard
        debugDashboard?: boolean;
        // Player username
        username?: string;
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

    // Metrics system for dashboard time-series
    interface MetricsMemory {
        cpu: TimeseriesData;
        cpuBucket: TimeseriesData;
        rooms: { [roomName: string]: RoomMetricsData };
    }

    interface TimeseriesData {
        values: number[];
        timestamps: number[];
        maxLength: number;
    }

    interface RoomMetricsData {
        energyIncome: TimeseriesData;
        storageLevel: TimeseriesData;
        energyHarvested: number; // Running total for current tick
    }

    // Summary types for dashboard display
    interface RemoteSummary {
        roomName: string;
        baseRoom: string;
        sourceCount: number;
        threat: boolean;
        miners: number;
        haulers: number;
    }

    interface CombatOpSummary {
        id: string;
        type: string;
        target: string;
        status: string;
        creepCount: number;
    }

    interface HighwayOpSummary {
        id: string;
        type: "power" | "deposit";
        room: string;
        status: string;
        value: number;
    }

    interface LabStatus {
        producing: string | null;
        queueLength: number;
        boostRequests: number;
    }

    interface AlertInfo {
        level: "critical" | "warning" | "info";
        message: string;
        room?: string;
    }
}

export {};
