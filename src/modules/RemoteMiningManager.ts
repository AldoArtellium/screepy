/**
 * RemoteMiningManager - Remote room mining operations
 *
 * Features:
 * - Remote room selection based on profitability
 * - Remote miner and hauler spawning
 * - Container placement at remote sources
 * - Room reservation management
 * - Invader detection and response
 */

import { BodyType } from "../config/bodyTypes";
import { intelManager, RoomIntel } from "./IntelManager";
import {
    generateTaskId,
    getEffectivePriority,
    Task,
    TaskCategory,
    TaskStatus,
    TaskType
} from "../types/TaskTypes";
import { log } from "../utils/logger";

/** Remote mining configuration */
const REMOTE_CONFIG = {
    /** Minimum phase to start remote mining */
    MIN_PHASE: 3,
    /** Maximum remote rooms per owned room */
    MAX_REMOTES_PER_ROOM: 3,
    /** Maximum distance for remote mining */
    MAX_DISTANCE: 2,
    /** Minimum mining value to consider a room */
    MIN_VALUE: 500,
    /** Ticks between remote evaluations */
    EVAL_INTERVAL: 100,
    /** Reservation threshold (ticks remaining before re-reserve) */
    RESERVATION_THRESHOLD: 1000
};

/** Remote room assignment */
interface RemoteAssignment {
    /** Remote room name */
    roomName: string;
    /** Base room handling this remote */
    baseRoom: string;
    /** Sources in this remote */
    sources: { x: number; y: number; minerId?: string; haulerId?: string }[];
    /** Container IDs at sources */
    containers: { [sourceIndex: number]: Id<StructureContainer> };
    /** Is room currently being reserved */
    reserving: boolean;
    /** Last evaluation tick */
    lastEval: number;
    /** Current threat level */
    threat: number;
}

class RemoteMiningManager {
    /**
     * Main remote mining management
     */
    manage(): void {
        // Initialize remote assignments
        if (!Memory.remotes) {
            Memory.remotes = {};
        }

        // Process each owned room
        for (const roomName in Game.rooms) {
            const room = Game.rooms[roomName];
            if (!room.controller?.my) continue;

            const phase = room.memory.phase ?? 0;
            if (phase < REMOTE_CONFIG.MIN_PHASE) continue;

            this.manageRoomRemotes(room);
        }

        // Generate tasks for active remotes
        this.generateRemoteTasks();

        // Run remote creeps
        this.runRemoteCreeps();
    }

    /**
     * Manage remote mining for a specific room
     */
    private manageRoomRemotes(room: Room): void {
        // Get current remotes for this room
        const currentRemotes = this.getRemotesForRoom(room.name);

        // Evaluate new remotes periodically
        if (Game.time % REMOTE_CONFIG.EVAL_INTERVAL === 0 || currentRemotes.length === 0) {
            this.evaluateRemotes(room, currentRemotes);
        }

        // Update remote room data
        for (const remote of currentRemotes) {
            this.updateRemoteStatus(remote);
        }
    }

    /**
     * Get all remotes assigned to a base room
     */
    private getRemotesForRoom(baseRoom: string): RemoteAssignment[] {
        const remotes: RemoteAssignment[] = [];

        for (const remoteName in Memory.remotes) {
            const assignment = Memory.remotes[remoteName];
            if (assignment.baseRoom === baseRoom) {
                remotes.push(assignment);
            }
        }

        return remotes;
    }

    /**
     * Evaluate and assign remote rooms
     */
    private evaluateRemotes(room: Room, currentRemotes: RemoteAssignment[]): void {
        // Get candidates from intel
        const candidates = intelManager.getRemoteMiningCandidates(room.name, REMOTE_CONFIG.MAX_DISTANCE);

        // Filter to viable candidates
        const viableCandidates = candidates.filter(intel =>
            intel.miningValue >= REMOTE_CONFIG.MIN_VALUE &&
            !intel.hasSourceKeepers &&
            !intel.owner
        );

        // Check if we need more remotes
        const neededRemotes = REMOTE_CONFIG.MAX_REMOTES_PER_ROOM - currentRemotes.length;

        if (neededRemotes <= 0) return;

        // Ensure remotes memory exists
        if (!Memory.remotes) {
            Memory.remotes = {};
        }

        // Assign new remotes
        for (const intel of viableCandidates.slice(0, neededRemotes)) {
            // Skip if already assigned
            if (Memory.remotes[intel.name]) continue;

            this.assignRemote(room.name, intel);
        }
    }

    /**
     * Assign a remote room to a base
     */
    private assignRemote(baseRoom: string, intel: RoomIntel): void {
        const assignment: RemoteAssignment = {
            roomName: intel.name,
            baseRoom,
            sources: intel.sourcePositions.map(pos => ({ x: pos.x, y: pos.y })),
            containers: {},
            reserving: false,
            lastEval: Game.time,
            threat: 0
        };

        if (!Memory.remotes) {
            Memory.remotes = {};
        }
        Memory.remotes[intel.name] = assignment;
        log.info("RemoteMiningManager", `Assigned remote ${intel.name} to ${baseRoom} (value: ${intel.miningValue})`);
    }

    /**
     * Update status for a remote room
     */
    private updateRemoteStatus(remote: RemoteAssignment): void {
        const room = Game.rooms[remote.roomName];

        if (room) {
            // We have visibility - update data
            remote.lastEval = Game.time;

            // Check for hostiles
            const hostiles = room.find(FIND_HOSTILE_CREEPS);
            if (hostiles.length > 0) {
                remote.threat = hostiles.reduce((sum, h) => sum + h.hits, 0);
            } else {
                remote.threat = 0;
            }

            // Update container references
            this.updateRemoteContainers(remote, room);

            // Check reservation status
            if (room.controller && !room.controller.my) {
                const reservation = room.controller.reservation;
                remote.reserving = !reservation ||
                    reservation.ticksToEnd < REMOTE_CONFIG.RESERVATION_THRESHOLD ||
                    reservation.username !== Memory.username;
            }
        }
    }

    /**
     * Update container references for remote sources
     */
    private updateRemoteContainers(remote: RemoteAssignment, room: Room): void {
        for (let i = 0; i < remote.sources.length; i++) {
            const sourcePos = remote.sources[i];
            const pos = new RoomPosition(sourcePos.x, sourcePos.y, room.name);

            // Find container near source
            const container = pos.findInRange(FIND_STRUCTURES, 1, {
                filter: s => s.structureType === STRUCTURE_CONTAINER
            })[0] as StructureContainer | undefined;

            if (container) {
                remote.containers[i] = container.id;
            }
        }
    }

    /**
     * Generate tasks for remote mining operations
     */
    private generateRemoteTasks(): void {
        for (const remoteName in Memory.remotes) {
            const remote = Memory.remotes[remoteName];
            const room = Game.rooms[remote.roomName];

            // Skip if room not visible or under threat
            if (!room) continue;
            if (remote.threat > 0) continue;

            // Generate harvest tasks for sources
            this.generateRemoteHarvestTasks(remote, room);

            // Generate transport tasks for containers
            this.generateRemoteTransportTasks(remote, room);
        }
    }

    /**
     * Generate harvest tasks for remote sources
     */
    private generateRemoteHarvestTasks(remote: RemoteAssignment, room: Room): void {
        const sources = room.find(FIND_SOURCES);

        for (const source of sources) {
            // Check for existing task
            const existingTask = (room.memory.taskQueue ?? []).find(
                t => t.type === TaskType.HARVEST_SOURCE &&
                     t.targetId === source.id &&
                     t.status !== TaskStatus.COMPLETED &&
                     t.status !== TaskStatus.FAILED
            );

            if (existingTask) continue;

            // Create harvest task
            if (!room.memory.taskQueue) {
                room.memory.taskQueue = [];
            }

            const task: Task = {
                id: generateTaskId(TaskType.HARVEST_SOURCE, source.id),
                type: TaskType.HARVEST_SOURCE,
                category: TaskCategory.HARVEST,
                targetId: source.id,
                roomName: room.name,
                priority: getEffectivePriority(TaskType.HARVEST_SOURCE, false) - 5, // Slightly higher priority
                status: TaskStatus.PENDING,
                createdAt: Game.time,
                data: {
                    targetPos: { x: source.pos.x, y: source.pos.y }
                }
            };

            room.memory.taskQueue.push(task);
        }
    }

    /**
     * Generate transport tasks for remote containers
     */
    private generateRemoteTransportTasks(remote: RemoteAssignment, room: Room): void {
        for (const sourceIndex in remote.containers) {
            const containerId = remote.containers[sourceIndex];
            const container = Game.getObjectById(containerId);

            if (!container) {
                delete remote.containers[sourceIndex];
                continue;
            }

            // Check if container has enough energy to withdraw
            if (container.store.getUsedCapacity(RESOURCE_ENERGY) < 500) continue;

            // Check for existing task
            const existingTask = (room.memory.taskQueue ?? []).find(
                t => t.type === TaskType.WITHDRAW_CONTAINER &&
                     t.targetId === containerId &&
                     t.status !== TaskStatus.COMPLETED &&
                     t.status !== TaskStatus.FAILED
            );

            if (existingTask) continue;

            // Create withdraw task
            if (!room.memory.taskQueue) {
                room.memory.taskQueue = [];
            }

            const task: Task = {
                id: generateTaskId(TaskType.WITHDRAW_CONTAINER, containerId),
                type: TaskType.WITHDRAW_CONTAINER,
                category: TaskCategory.TRANSPORT,
                targetId: containerId,
                roomName: room.name,
                priority: getEffectivePriority(TaskType.WITHDRAW_CONTAINER, false) - 5,
                status: TaskStatus.PENDING,
                createdAt: Game.time,
                data: {
                    amount: container.store.getUsedCapacity(RESOURCE_ENERGY)
                }
            };

            room.memory.taskQueue.push(task);
        }
    }

    /**
     * Run remote mining creeps
     */
    private runRemoteCreeps(): void {
        // Remote creeps are managed by the task system
        // This handles special cases like cross-room movement

        for (const name in Game.creeps) {
            const creep = Game.creeps[name];
            if (!creep.memory.currentTask) continue;

            const task = this.getTaskById(creep.room, creep.memory.currentTask.taskId);
            if (!task) continue;

            // Handle cross-room movement for remote tasks
            if (task.roomName !== creep.room.name) {
                this.moveToRemoteRoom(creep, task.roomName);
            }
        }
    }

    /**
     * Move creep to a remote room
     */
    private moveToRemoteRoom(creep: Creep, targetRoom: string): void {
        const exitDir = creep.room.findExitTo(targetRoom);
        if (exitDir === ERR_NO_PATH || exitDir === ERR_INVALID_ARGS) {
            return;
        }

        const exit = creep.pos.findClosestByRange(exitDir as FindConstant);
        if (exit) {
            creep.moveTo(exit, { reusePath: 20 });
        }
    }

    /**
     * Get task by ID from a room
     */
    private getTaskById(room: Room, taskId: string): Task | undefined {
        return room.memory.taskQueue?.find(t => t.id === taskId);
    }

    /**
     * Check if a creep should be spawned for remote mining
     */
    getRemoteMiningDemand(baseRoom: string): { miners: number; haulers: number } {
        const remotes = this.getRemotesForRoom(baseRoom);

        let minersNeeded = 0;
        let haulersNeeded = 0;

        for (const remote of remotes) {
            // Skip threatened remotes
            if (remote.threat > 0) continue;

            // One miner per source
            minersNeeded += remote.sources.length;

            // One hauler per source (may need more for distant remotes)
            const distance = intelManager.getRoomDistance(baseRoom, remote.roomName);
            const haulersPerSource = distance > 1 ? 2 : 1;
            haulersNeeded += remote.sources.length * haulersPerSource;
        }

        // Count existing remote creeps
        const existingMiners = _.filter(Game.creeps, c =>
            c.memory.room === baseRoom &&
            c.memory.bodyType === BodyType.WORKER &&
            c.memory.targetRoom !== undefined
        ).length;

        const existingHaulers = _.filter(Game.creeps, c =>
            c.memory.room === baseRoom &&
            c.memory.bodyType === BodyType.TRANSPORT &&
            c.memory.targetRoom !== undefined
        ).length;

        return {
            miners: Math.max(0, minersNeeded - existingMiners),
            haulers: Math.max(0, haulersNeeded - existingHaulers)
        };
    }

    /**
     * Abandon a remote room (due to threats or better options)
     */
    abandonRemote(roomName: string): void {
        if (Memory.remotes?.[roomName]) {
            log.info("RemoteMiningManager", `Abandoning remote ${roomName}`);
            delete Memory.remotes[roomName];
        }
    }

    /**
     * Get list of active remote rooms
     */
    getActiveRemotes(): string[] {
        return Object.keys(Memory.remotes ?? {});
    }
}

// Extend Memory for remote assignments
declare global {
    interface Memory {
        remotes?: { [roomName: string]: RemoteAssignment };
    }
}

// Singleton instance
const remoteMiningManagerInstance = new RemoteMiningManager();

export const remoteMiningManagerModule = () => {
    remoteMiningManagerInstance.manage();
};

export const remoteMiningManager = remoteMiningManagerInstance;
