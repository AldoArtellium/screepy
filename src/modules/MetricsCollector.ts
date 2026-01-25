/**
 * MetricsCollector - Time-series data collection for dashboard
 *
 * Features:
 * - CPU usage tracking (per tick)
 * - Bucket level tracking
 * - Energy income per room (from harvesting)
 * - Storage level tracking
 * - Automatic data point limiting (100 points max)
 */

const MAX_DATA_POINTS = 100;

/**
 * Initialize a new timeseries data structure
 */
function createTimeseries(): TimeseriesData {
    return {
        values: [],
        timestamps: [],
        maxLength: MAX_DATA_POINTS
    };
}

/**
 * Add a data point to a timeseries
 */
function addDataPoint(series: TimeseriesData, value: number): void {
    series.values.push(value);
    series.timestamps.push(Game.time);

    // Trim to max length
    while (series.values.length > series.maxLength) {
        series.values.shift();
        series.timestamps.shift();
    }
}

class MetricsCollector {
    /** Last tick we collected metrics */
    private lastTick: number = 0;

    /** CPU used at start of tick (for measuring our own overhead) */
    private tickStartCpu: number = 0;

    /**
     * Initialize metrics collection at start of tick
     * Called early in the game loop to capture starting CPU
     */
    startTick(): void {
        this.tickStartCpu = Game.cpu.getUsed();
    }

    /**
     * Main collection function - runs every tick
     */
    collect(): void {
        // Skip if already collected this tick
        if (this.lastTick === Game.time) return;
        this.lastTick = Game.time;

        // Initialize memory structure if needed
        if (!Memory.metrics) {
            Memory.metrics = {
                cpu: createTimeseries(),
                cpuBucket: createTimeseries(),
                rooms: {}
            };
        }

        const metrics = Memory.metrics;

        // Collect CPU metrics
        const cpuUsed = Game.cpu.getUsed();
        addDataPoint(metrics.cpu, cpuUsed);
        addDataPoint(metrics.cpuBucket, Game.cpu.bucket);

        // Collect per-room metrics
        for (const roomName in Game.rooms) {
            const room = Game.rooms[roomName];
            if (!room.controller?.my) continue;

            // Initialize room metrics if needed
            if (!metrics.rooms[roomName]) {
                metrics.rooms[roomName] = {
                    energyIncome: createTimeseries(),
                    storageLevel: createTimeseries(),
                    energyHarvested: 0
                };
            }

            const roomMetrics = metrics.rooms[roomName];

            // Record energy income (accumulated from events)
            addDataPoint(roomMetrics.energyIncome, roomMetrics.energyHarvested);
            roomMetrics.energyHarvested = 0; // Reset for next tick

            // Record storage level
            const storageLevel = room.storage?.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0;
            addDataPoint(roomMetrics.storageLevel, storageLevel);
        }

        // Cleanup metrics for rooms we no longer own
        for (const roomName in metrics.rooms) {
            const room = Game.rooms[roomName];
            if (!room || !room.controller?.my) {
                delete metrics.rooms[roomName];
            }
        }
    }

    /**
     * Record energy harvested (called from TaskExecutor when harvest succeeds)
     */
    recordEnergyHarvested(roomName: string, amount: number): void {
        if (!Memory.metrics?.rooms[roomName]) return;
        Memory.metrics.rooms[roomName].energyHarvested += amount;
    }

    /**
     * Get CPU timeseries data
     */
    getCpuTimeseries(): TimeseriesData | undefined {
        return Memory.metrics?.cpu;
    }

    /**
     * Get bucket timeseries data
     */
    getBucketTimeseries(): TimeseriesData | undefined {
        return Memory.metrics?.cpuBucket;
    }

    /**
     * Get energy income timeseries for a room
     */
    getEnergyIncomeTimeseries(roomName: string): TimeseriesData | undefined {
        return Memory.metrics?.rooms[roomName]?.energyIncome;
    }

    /**
     * Get storage level timeseries for a room
     */
    getStorageTimeseries(roomName: string): TimeseriesData | undefined {
        return Memory.metrics?.rooms[roomName]?.storageLevel;
    }

    /**
     * Get all timeseries data for a room
     */
    getRoomMetrics(roomName: string): RoomMetricsData | undefined {
        return Memory.metrics?.rooms[roomName];
    }
}

// Singleton instance
const metricsCollectorInstance = new MetricsCollector();

/**
 * Module export for game loop integration
 * This is a lightweight mandatory module that runs every tick
 */
export const metricsCollectorModule = () => {
    metricsCollectorInstance.collect();
};

/**
 * Initialize metrics at start of tick (call early in game loop)
 */
export const metricsStartTick = () => {
    metricsCollectorInstance.startTick();
};

export const metricsCollector = metricsCollectorInstance;
