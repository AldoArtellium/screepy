/**
 * RemoteMiningManager - Remote room mining operations
 *
 * Remotes are picked from scouting intel. Each remote is run by module-driven creeps
 * (requested through spawnManager.requestSpawn, driven through the role registry):
 * - remoteMiner: one per source, builds/repairs the source container and harvests into it
 * - remoteHauler: carries container energy back to the base storage (count sized on distance)
 * - remoteReserver: keeps the controller reserved (doubles source capacity)
 *
 * Creeps retreat to the base room while hostiles are in the remote.
 */

import { intelManager, RoomIntel } from "./IntelManager";
import { log } from "../utils/logger";
import { trafficManager } from "./TrafficManager";
import { spawnManager } from "./SpawnManager";
import { registerRole } from "../roles/registry";

/** Remote mining configuration */
const REMOTE_CONFIG = {
    /** Minimum phase to start remote mining (storage needed to drop the energy) */
    MIN_PHASE: 4,
    /** Maximum remote rooms per owned room */
    MAX_REMOTES_PER_ROOM: 2,
    /** Maximum distance for remote mining (rooms) */
    MAX_DISTANCE: 1,
    /** Minimum mining value to consider a room */
    MIN_VALUE: 500,
    /** Ticks between remote evaluations */
    EVAL_INTERVAL: 100,
    /** Reservation ticks left below which a reserver is requested */
    RESERVATION_THRESHOLD: 1000,
    /** Maximum haulers per source */
    MAX_HAULERS_PER_SOURCE: 3
};

const ROLES = {
    MINER: "remoteMiner",
    HAULER: "remoteHauler",
    RESERVER: "remoteReserver"
} as const;

/** After the base economy (workers 1, transports 2) */
const SPAWN_PRIORITY = {
    [ROLES.MINER]: 2.5,
    [ROLES.HAULER]: 2.6,
    [ROLES.RESERVER]: 2.7
};

/** Remote room assignment */
interface RemoteAssignment {
    /** Remote room name */
    roomName: string;
    /** Base room handling this remote */
    baseRoom: string;
    /** Sources in this remote (containerPos: where the miner stands / the container goes) */
    sources: { x: number; y: number; containerPos?: { x: number; y: number }; pathLength?: number }[];
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
        if (!Memory.remotes) {
            Memory.remotes = {};
        }

        for (const roomName in Game.rooms) {
            const room = Game.rooms[roomName];
            if (!room.controller?.my) continue;

            const phase = room.memory.phase ?? 0;
            if (phase < REMOTE_CONFIG.MIN_PHASE || !room.storage) continue;

            this.manageRoomRemotes(room);
        }
    }

    /**
     * Manage remote mining for a specific room
     */
    private manageRoomRemotes(room: Room): void {
        const currentRemotes = this.getRemotesForRoom(room.name);

        if (Game.time % REMOTE_CONFIG.EVAL_INTERVAL === 0 || currentRemotes.length === 0) {
            this.evaluateRemotes(room, currentRemotes);
        }

        for (const remote of this.getRemotesForRoom(room.name)) {
            this.updateRemoteStatus(remote);
            if (remote.threat > 0) continue;
            this.requestRemoteCreeps(room, remote);
        }
    }

    /**
     * Get all remotes assigned to a base room
     */
    private getRemotesForRoom(baseRoom: string): RemoteAssignment[] {
        return Object.values(Memory.remotes ?? {}).filter(r => r.baseRoom === baseRoom);
    }

    /**
     * Evaluate and assign remote rooms
     */
    private evaluateRemotes(room: Room, currentRemotes: RemoteAssignment[]): void {
        const neededRemotes = REMOTE_CONFIG.MAX_REMOTES_PER_ROOM - currentRemotes.length;
        if (neededRemotes <= 0) return;

        const candidates = intelManager
            .getRemoteMiningCandidates(room.name, REMOTE_CONFIG.MAX_DISTANCE)
            .filter(intel =>
                intel.miningValue >= REMOTE_CONFIG.MIN_VALUE &&
                !intel.hasSourceKeepers &&
                !intel.hasInvaderCore &&
                !intel.owner &&
                (!intel.reserver || intel.reserver === Memory.username) &&
                !Memory.remotes![intel.name]
            );

        for (const intel of candidates.slice(0, neededRemotes)) {
            this.assignRemote(room.name, intel);
        }
    }

    /**
     * Assign a remote room to a base
     */
    private assignRemote(baseRoom: string, intel: RoomIntel): void {
        Memory.remotes![intel.name] = {
            roomName: intel.name,
            baseRoom,
            sources: intel.sourcePositions.map(pos => ({ x: pos.x, y: pos.y })),
            containers: {},
            reserving: false,
            lastEval: Game.time,
            threat: 0
        };
        log.info("RemoteMiningManager", `Assigned remote ${intel.name} to ${baseRoom} (value: ${intel.miningValue})`);
    }

    /**
     * Update status for a remote room (needs visibility)
     */
    private updateRemoteStatus(remote: RemoteAssignment): void {
        const room = Game.rooms[remote.roomName];
        if (!room) return;

        remote.lastEval = Game.time;

        const hostiles = room.find(FIND_HOSTILE_CREEPS, {
            filter: c => c.getActiveBodyparts(ATTACK) + c.getActiveBodyparts(RANGED_ATTACK) > 0
        });
        remote.threat = hostiles.reduce((sum, h) => sum + h.hits, 0);

        this.updateRemoteContainers(remote, room);

        // Another player took the room: drop it
        const reserver = room.controller?.reservation?.username;
        const foreignReservation = !!reserver && reserver !== Memory.username;
        if (room.controller?.owner || foreignReservation) {
            this.abandonRemote(remote.roomName);
            return;
        }

        const reservation = room.controller?.reservation;
        remote.reserving = !!room.controller &&
            (!reservation || reservation.ticksToEnd < REMOTE_CONFIG.RESERVATION_THRESHOLD);
    }

    /**
     * Update container references and container positions for remote sources
     */
    private updateRemoteContainers(remote: RemoteAssignment, room: Room): void {
        const base = Game.rooms[remote.baseRoom];
        const anchor = base?.storage ?? base?.find(FIND_MY_SPAWNS)[0];

        for (let i = 0; i < remote.sources.length; i++) {
            const source = remote.sources[i];
            const pos = new RoomPosition(source.x, source.y, room.name);

            const container = pos.findInRange(FIND_STRUCTURES, 1, {
                filter: s => s.structureType === STRUCTURE_CONTAINER
            })[0] as StructureContainer | undefined;

            if (container) {
                remote.containers[i] = container.id;
                source.containerPos = { x: container.pos.x, y: container.pos.y };
            } else {
                delete remote.containers[i];
            }

            // Container spot: last step of the path from the base, so haulers don't walk around the source
            if (!source.containerPos && anchor) {
                const result = PathFinder.search(anchor.pos, { pos, range: 1 }, { maxOps: 8000 });
                const last = result.path[result.path.length - 1];
                if (!result.incomplete && last) {
                    source.containerPos = { x: last.x, y: last.y };
                    source.pathLength = result.path.length;
                }
            }
        }
    }

    /**
     * Request miners, haulers and reserver for a remote
     */
    private requestRemoteCreeps(base: Room, remote: RemoteAssignment): void {
        const capacity = base.energyCapacityAvailable;
        const remoteCreeps = _.filter(Game.creeps, c => c.memory.remote === remote.roomName);

        remote.sources.forEach((source, index) => {
            // Replace a creep a bit before it dies (spawn time + travel)
            const travel = source.pathLength ?? 75;
            const alive = (role: string) =>
                remoteCreeps.filter(c =>
                    c.memory.role === role &&
                    c.memory.sourceIndex === index &&
                    (c.spawning || (c.ticksToLive ?? 0) > travel + c.body.length * CREEP_SPAWN_TIME)
                ).length;

            if (alive(ROLES.MINER) === 0) {
                spawnManager.requestSpawn({
                    id: `${ROLES.MINER}-${remote.roomName}-${index}`,
                    roomName: base.name,
                    body: this.minerBody(capacity),
                    priority: SPAWN_PRIORITY[ROLES.MINER],
                    memory: { role: ROLES.MINER, room: base.name, remote: remote.roomName, sourceIndex: index }
                });
                return; // haulers are useless before the miner
            }

            const haulerBody = this.haulerBody(capacity);
            const needed = this.haulersNeeded(remote, source.pathLength ?? 75, haulerBody);
            if (alive(ROLES.HAULER) < needed) {
                spawnManager.requestSpawn({
                    id: `${ROLES.HAULER}-${remote.roomName}-${index}`,
                    roomName: base.name,
                    body: haulerBody,
                    priority: SPAWN_PRIORITY[ROLES.HAULER],
                    memory: { role: ROLES.HAULER, room: base.name, remote: remote.roomName, sourceIndex: index }
                });
            }
        });

        const reserverBody = this.reserverBody(capacity);
        const reservers = remoteCreeps.filter(c => c.memory.role === ROLES.RESERVER).length;
        if (remote.reserving && reserverBody && reservers === 0) {
            spawnManager.requestSpawn({
                id: `${ROLES.RESERVER}-${remote.roomName}`,
                roomName: base.name,
                body: reserverBody,
                priority: SPAWN_PRIORITY[ROLES.RESERVER],
                memory: { role: ROLES.RESERVER, room: base.name, remote: remote.roomName }
            });
        }
    }

    /** 5 WORK drain a reserved source (10 energy/tick); 3 WORK an unreserved one */
    private minerBody(capacity: number): BodyPartConstant[] {
        if (capacity >= 800) return [WORK, WORK, WORK, WORK, WORK, WORK, CARRY, MOVE, MOVE, MOVE];
        if (capacity >= 550) return [WORK, WORK, WORK, WORK, CARRY, MOVE, MOVE];
        return [WORK, WORK, CARRY, MOVE, MOVE];
    }

    /** CARRY/MOVE pairs (remote roads aren't guaranteed) */
    private haulerBody(capacity: number): BodyPartConstant[] {
        const pairs = Math.max(2, Math.min(16, Math.floor(capacity / 100)));
        const body: BodyPartConstant[] = [];
        for (let i = 0; i < pairs; i++) body.push(CARRY);
        for (let i = 0; i < pairs; i++) body.push(MOVE);
        return body;
    }

    private reserverBody(capacity: number): BodyPartConstant[] | null {
        if (capacity >= 1300) return [CLAIM, CLAIM, MOVE, MOVE];
        if (capacity >= 650) return [CLAIM, MOVE];
        return null;
    }

    /** Haulers needed to carry a source's output over a round trip */
    private haulersNeeded(remote: RemoteAssignment, pathLength: number, body: BodyPartConstant[]): number {
        const room = Game.rooms[remote.roomName];
        const reserved = room?.controller?.reservation?.username === Memory.username;
        const energyPerTick = (reserved ? SOURCE_ENERGY_CAPACITY : SOURCE_ENERGY_NEUTRAL_CAPACITY) / ENERGY_REGEN_TIME;
        const capacity = body.filter(p => p === CARRY).length * CARRY_CAPACITY;
        const needed = Math.ceil((energyPerTick * pathLength * 2 * 1.1) / capacity);
        return Math.max(1, Math.min(REMOTE_CONFIG.MAX_HAULERS_PER_SOURCE, needed));
    }

    // ------------------------------------------------------------------ roles

    /** Retreat home while the remote is threatened. Returns true when retreating. */
    private retreatIfThreatened(creep: Creep): boolean {
        const remote = Memory.remotes?.[creep.memory.remote ?? ""];
        if (!remote) {
            // Remote abandoned: let the creep go home and be recycled
            const home = creep.memory.room ? Game.rooms[creep.memory.room] : undefined;
            const spawn = home?.find(FIND_MY_SPAWNS)[0];
            if (spawn) {
                trafficManager.requestMove(creep, spawn, { range: 1 });
                if (creep.pos.isNearTo(spawn)) spawn.recycleCreep(creep);
            }
            return true;
        }
        if (remote.threat > 0) {
            trafficManager.moveToRoom(creep, remote.baseRoom);
            return true;
        }
        return false;
    }

    runMiner(creep: Creep): void {
        if (this.retreatIfThreatened(creep)) return;
        const remote = Memory.remotes![creep.memory.remote!];
        const source = remote.sources[creep.memory.sourceIndex ?? 0];
        if (!source) return;

        if (creep.room.name !== remote.roomName || !source.containerPos) {
            trafficManager.moveToRoom(creep, remote.roomName);
            return;
        }

        const standPos = new RoomPosition(source.containerPos.x, source.containerPos.y, remote.roomName);
        trafficManager.requestMove(creep, standPos, { range: 0, priority: 5 });
        if (!creep.pos.isEqualTo(standPos)) return;

        const sourceObj = new RoomPosition(source.x, source.y, remote.roomName).lookFor(LOOK_SOURCES)[0];
        const container = remote.containers[creep.memory.sourceIndex ?? 0]
            ? Game.getObjectById(remote.containers[creep.memory.sourceIndex ?? 0])
            : null;

        if (!container) {
            // Build the container with harvested energy
            const site = standPos.lookFor(LOOK_CONSTRUCTION_SITES)[0];
            if (!site) {
                creep.room.createConstructionSite(standPos, STRUCTURE_CONTAINER);
            } else if (creep.store.getUsedCapacity(RESOURCE_ENERGY) >= creep.getActiveBodyparts(WORK) * BUILD_POWER) {
                creep.build(site);
                return;
            }
        } else if (container.hits < container.hitsMax * 0.5 && creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
            creep.repair(container);
            return;
        }

        if (sourceObj && sourceObj.energy > 0) creep.harvest(sourceObj);
    }

    runHauler(creep: Creep): void {
        if (this.retreatIfThreatened(creep)) return;
        const remote = Memory.remotes![creep.memory.remote!];

        if (creep.store.getFreeCapacity() === 0) creep.memory.delivering = true;
        if (creep.store.getUsedCapacity() === 0) creep.memory.delivering = false;

        if (creep.memory.delivering) {
            const base = Game.rooms[remote.baseRoom];
            const target = base?.storage;
            if (!target) {
                trafficManager.moveToRoom(creep, remote.baseRoom);
                return;
            }
            trafficManager.requestMove(creep, target, { range: 1 });
            if (creep.pos.isNearTo(target)) creep.transfer(target, RESOURCE_ENERGY);
            return;
        }

        const source = remote.sources[creep.memory.sourceIndex ?? 0];
        if (!source?.containerPos || creep.room.name !== remote.roomName) {
            trafficManager.moveToRoom(creep, remote.roomName);
            return;
        }

        const containerPos = new RoomPosition(source.containerPos.x, source.containerPos.y, remote.roomName);
        // Dropped energy around the miner first (decays), then the container
        const dropped = containerPos.findInRange(FIND_DROPPED_RESOURCES, 1, {
            filter: r => r.resourceType === RESOURCE_ENERGY
        })[0];
        const container = containerPos.lookFor(LOOK_STRUCTURES).find(
            (s): s is StructureContainer => s.structureType === STRUCTURE_CONTAINER
        );

        const target = dropped ?? container;
        trafficManager.requestMove(creep, target?.pos ?? containerPos, { range: 1 });
        if (!target || !creep.pos.isNearTo(target)) return;

        if (dropped) {
            creep.pickup(dropped);
        } else if (container && container.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
            creep.withdraw(container, RESOURCE_ENERGY);
        }
    }

    runReserver(creep: Creep): void {
        if (this.retreatIfThreatened(creep)) return;
        const remote = Memory.remotes![creep.memory.remote!];

        if (creep.room.name !== remote.roomName) {
            trafficManager.moveToRoom(creep, remote.roomName);
            return;
        }
        const controller = creep.room.controller;
        if (!controller) return;

        trafficManager.requestMove(creep, controller, { range: 1 });
        if (creep.pos.isNearTo(controller)) creep.reserveController(controller);
    }

    // ------------------------------------------------------------------ queries

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

    /**
     * Get summary of remote operations for dashboard
     */
    getRemotesSummary(_detailed: boolean = false): RemoteSummary[] {
        return Object.values(Memory.remotes ?? {}).map(remote => {
            const creeps = _.filter(Game.creeps, c => c.memory.remote === remote.roomName);
            return {
                roomName: remote.roomName,
                baseRoom: remote.baseRoom,
                sourceCount: remote.sources.length,
                threat: remote.threat > 0,
                miners: creeps.filter(c => c.memory.role === ROLES.MINER).length,
                haulers: creeps.filter(c => c.memory.role === ROLES.HAULER).length
            };
        });
    }
}

declare global {
    interface Memory {
        remotes?: { [roomName: string]: RemoteAssignment };
    }

    interface CreepMemory {
        /** Remote room a remote-mining creep works for */
        remote?: string;
        /** Source index within the remote */
        sourceIndex?: number;
        /** Hauler state */
        delivering?: boolean;
    }
}

// Singleton instance
const remoteMiningManagerInstance = new RemoteMiningManager();

registerRole(ROLES.MINER, creep => remoteMiningManagerInstance.runMiner(creep));
registerRole(ROLES.HAULER, creep => remoteMiningManagerInstance.runHauler(creep));
registerRole(ROLES.RESERVER, creep => remoteMiningManagerInstance.runReserver(creep));

export const remoteMiningManagerModule = () => {
    remoteMiningManagerInstance.manage();
};

export const remoteMiningManager = remoteMiningManagerInstance;
