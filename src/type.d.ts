declare global {
    interface Memory {
        rooms: Record<string, RoomMemory>;
        creeps: Record<string, any>;
        spawn: {
            desiredCounts: { [role: string]: number };
            currentCounts?: { [role: string]: number };
        };
        init: boolean;
        logLevel?: number;
    }

    interface CreepMemory {
        role: string;
        room?: string;
        state?: "acquiring" | "executing";
        task?: {
            id: string;
            startedAt: number;
            state: "acquiring" | "executing" | "returning";
        };
        targetRoom?: string;
        targetId?: Id;
        targetTick?: number;
        patrolIndex?: number;
        /** Tick when last task was completed (for cooldown) */
        lastTaskCompleted?: number;
        /** Category of the last completed task (for stickiness) */
        lastTaskCategory?: number;
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
        taskQueue?: {
            tasks: { [id: string]: import("./types/TaskTypes").Task };
            byPriority: string[];
            lastSort: number;
            lastGeneration: number;
        };
        patrolPoints?: { x: number; y: number }[];
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
