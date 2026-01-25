/**
 * AlertSystem - Detects problems requiring attention
 *
 * Alert Levels:
 * - Critical: Immediate attention needed (low bucket, defense mode, emergency phase)
 * - Warning: Potential issues (part deficits, remote threats, stalled spawning)
 * - Info: Notable events (active combat ops, power banks found)
 */

/** Alert configuration thresholds */
const ALERT_CONFIG = {
    /** Critical bucket threshold */
    BUCKET_CRITICAL: 500,
    /** Warning bucket threshold */
    BUCKET_WARNING: 2000,
    /** Warning storage threshold (energy) */
    STORAGE_LOW: 10000,
    /** Warning spawn queue length */
    SPAWN_QUEUE_WARNING: 10,
    /** Part deficit warning threshold */
    PART_DEFICIT_WARNING: 3
};

class AlertSystem {
    /** Cached alerts (refreshed every 10 ticks) */
    private cachedAlerts: AlertInfo[] = [];
    /** Last evaluation tick */
    private lastEvalTick: number = 0;

    /**
     * Get all current alerts (cached)
     */
    getAlerts(): AlertInfo[] {
        // Refresh every 10 ticks
        if (Game.time - this.lastEvalTick >= 10) {
            this.evaluate();
            this.lastEvalTick = Game.time;
        }
        return this.cachedAlerts;
    }

    /**
     * Evaluate all alert conditions
     */
    private evaluate(): void {
        const alerts: AlertInfo[] = [];

        // Global alerts
        this.checkGlobalAlerts(alerts);

        // Per-room alerts
        for (const roomName in Game.rooms) {
            const room = Game.rooms[roomName];
            if (!room.controller?.my) continue;
            this.checkRoomAlerts(room, alerts);
        }

        // Sort by level (critical first)
        const levelOrder = { critical: 0, warning: 1, info: 2 };
        alerts.sort((a, b) => levelOrder[a.level] - levelOrder[b.level]);

        this.cachedAlerts = alerts;
    }

    /**
     * Check global alert conditions
     */
    private checkGlobalAlerts(alerts: AlertInfo[]): void {
        // CPU bucket alerts
        const bucket = Game.cpu.bucket;
        if (bucket < ALERT_CONFIG.BUCKET_CRITICAL) {
            alerts.push({
                level: "critical",
                message: `Bucket critical: ${bucket}`
            });
        } else if (bucket < ALERT_CONFIG.BUCKET_WARNING) {
            alerts.push({
                level: "warning",
                message: `Bucket low: ${bucket}`
            });
        }

        // GCL progress info
        if (Game.gcl.progressTotal > 0) {
            const gclPercent = Math.floor((Game.gcl.progress / Game.gcl.progressTotal) * 100);
            if (gclPercent >= 90) {
                alerts.push({
                    level: "info",
                    message: `GCL ${Game.gcl.level + 1} at ${gclPercent}%`
                });
            }
        }

        // Combat operations
        const combatOps = Memory.combatOperations;
        if (combatOps) {
            const activeOps = Object.values(combatOps).filter(op =>
                op.spawnedCreeps.length > 0
            );
            if (activeOps.length > 0) {
                alerts.push({
                    level: "info",
                    message: `${activeOps.length} combat op${activeOps.length > 1 ? "s" : ""} active`
                });
            }
        }

        // Highway operations (power banks)
        const highwayOps = Memory.highwayOperations;
        if (highwayOps?.power) {
            const activePower = Object.values(highwayOps.power).filter(
                op => op.status === "attacking" || op.status === "collecting"
            );
            if (activePower.length > 0) {
                const totalPower = activePower.reduce((sum, op) => sum + op.power, 0);
                alerts.push({
                    level: "info",
                    message: `Power ops: ${totalPower} power`
                });
            }
        }
    }

    /**
     * Check room-specific alert conditions
     */
    private checkRoomAlerts(room: Room, alerts: AlertInfo[]): void {
        const roomName = room.name;
        const phase = room.memory.phase ?? 0;

        // Emergency phase
        if (phase === 0) {
            alerts.push({
                level: "critical",
                message: "EMERGENCY",
                room: roomName
            });
        }

        // Defense mode
        if (room.memory.defenseMode) {
            alerts.push({
                level: "critical",
                message: "Under attack",
                room: roomName
            });
        }

        // Low storage energy
        if (room.storage) {
            const energy = room.storage.store.getUsedCapacity(RESOURCE_ENERGY);
            if (energy < ALERT_CONFIG.STORAGE_LOW) {
                alerts.push({
                    level: "warning",
                    message: `Low storage: ${Math.floor(energy / 1000)}k`,
                    room: roomName
                });
            }
        }

        // Spawn energy not filling
        if (room.energyAvailable < room.energyCapacityAvailable * 0.5) {
            const spawns = room.find(FIND_MY_SPAWNS);
            const allIdle = spawns.every(s => !s.spawning);
            if (allIdle && spawns.length > 0) {
                alerts.push({
                    level: "warning",
                    message: `Spawn energy: ${room.energyAvailable}/${room.energyCapacityAvailable}`,
                    room: roomName
                });
            }
        }

        // Part deficits
        const partDemand = room.memory.partDemand;
        if (partDemand) {
            for (const [part, demand] of Object.entries(partDemand)) {
                if (demand >= ALERT_CONFIG.PART_DEFICIT_WARNING) {
                    alerts.push({
                        level: "warning",
                        message: `Need ${demand} ${part.substring(0, 4).toUpperCase()}`,
                        room: roomName
                    });
                    break; // Only show first deficit per room
                }
            }
        }

        // Remote room threats
        const remotes = Memory.remotes;
        if (remotes) {
            for (const remoteName in remotes) {
                const remote = remotes[remoteName];
                if (remote.baseRoom === roomName && remote.threat > 0) {
                    alerts.push({
                        level: "warning",
                        message: `Remote threat: ${remoteName}`,
                        room: roomName
                    });
                }
            }
        }

        // Controller downgrade warning
        if (room.controller && room.controller.ticksToDowngrade < 5000) {
            alerts.push({
                level: "warning",
                message: `Downgrade in ${room.controller.ticksToDowngrade}`,
                room: roomName
            });
        }

        // Nuke incoming
        const nukes = room.find(FIND_NUKES);
        if (nukes.length > 0) {
            const soonest = nukes.reduce((min, n) =>
                n.timeToLand < min.timeToLand ? n : min
            );
            alerts.push({
                level: "critical",
                message: `NUKE in ${soonest.timeToLand}`,
                room: roomName
            });
        }
    }

    /**
     * Get alerts for a specific room
     */
    getAlertsForRoom(roomName: string): AlertInfo[] {
        return this.getAlerts().filter(a => !a.room || a.room === roomName);
    }

    /**
     * Get critical alerts only
     */
    getCriticalAlerts(): AlertInfo[] {
        return this.getAlerts().filter(a => a.level === "critical");
    }

    /**
     * Check if there are any critical alerts
     */
    hasCriticalAlerts(): boolean {
        return this.getCriticalAlerts().length > 0;
    }
}

// Singleton instance
const alertSystemInstance = new AlertSystem();

export const alertSystem = alertSystemInstance;
