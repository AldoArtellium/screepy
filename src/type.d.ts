declare global {
    interface Memory {
        rooms: Record<string, RoomMemory>;
        creeps: Record<string, any>;
        spawn: {
            desiredCounts: { [role: string]: number };
        };
        init: boolean;
    }

    interface CreepMemory {
        role: string;
        room?: string;
        state?: any;
        task?: any;
        targetRoom?: string;
        targetId?: Id;
    }

    interface ObserverMemory {
        targetRoom?: string;
    }

    interface RoomMemory {
        sources: { [id: Id<Source>]: ISourceMemory };
        constructionSites: { [id: Id<ConstructionSite>]: boolean };
        threatLevel?: number;
        threatLevelLastTick?: number;
    }

    interface ISourceMemory {
        distance: number;
        miners: string[];
        container?: string;
        link?: string;
    }
}


export {};