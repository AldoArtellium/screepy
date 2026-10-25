/**
 * SpawnManager - asks every spawn role for options and spawns the best one, one creep per room and tick.
 * If the best option can't be paid yet, the room waits for it (no fallback on a cheaper option).
 * Ported from Hivemind (MIT), src/spawn-manager.ts.
 *
 * Modules (scout, remote mining, expansion) request creeps through requestSpawn(): their requests
 * compete with the economy options on the same priority scale (higher = sooner).
 */

import { bodyCost } from "../core/bodyBuilder";
import { getBestOption } from "../core/options";
import { creepsByRole, mySpawns } from "../core/roomState";
import { ECONOMY_SPAWN_ROLES, SpawnOption, SpawnRole, starvedRooms } from "../spawning/spawnRoles";
import { markForBoosting } from "../labs/boosts";
import { spawnEnergyStructures, spawnExitDirections } from "../spawning/spawnPlacement";
import { recordSpawn } from "../utils/history";
import { log } from "../utils/logger";
import { countStat } from "../utils/stats";

declare module "../spawning/spawnRoles" {
    interface SpawnOption {
        /**
         * Why the role asks for this creep (quota inputs, e.g. "needs 12 WORK, energy 45k"), kept in
         * the spawn log (utils/history.ts). Without it the log records the role's creep count at home.
         */
        reason?: string;
    }
}

/**
 * Spawn request from a module. Creeps carry `memory.role` and are driven by the handler registered
 * for it (roles/registry.ts).
 */
export interface ExternalSpawnRequest {
    /** Unique id: re-requesting with the same id updates the request instead of duplicating it */
    id: string;
    /** Room whose spawns should build the creep */
    roomName: string;
    body: BodyPartConstant[];
    /** Same scale as the economy (higher = sooner): harvesters 4-6, builders 3-4, remote 3, scout 1 */
    priority: number;
    weight?: number;
    memory: Partial<CreepMemory> & { role: string };
    /** Ticks the request stays queued without being renewed (default 20) */
    ttl?: number;
    /** Why the module asks for it (spawn log); default: the request id */
    reason?: string;
}

const DEFAULT_REQUEST_TTL = 20;
/** A room with no option at all is not asked again for this many ticks */
const IDLE_ROOM_TICKS = 10;
/** Waiting this long for energy that doesn't rise: size bodies on the energy available */
const STARVED_TICKS = 50;

/** An option of the spawn queue shown by the room visuals */
export interface SpawnQueueEntry {
    role: string;
    priority: number;
    weight: number;
}

const QUEUE_SIZE = 3;

/** The QUEUE_SIZE best options in getBestOption order (priority, then weight, then collection order) */
function bestOptions(options: (SpawnOption & { spawnRole: SpawnRole })[]): SpawnQueueEntry[] {
    return options
        .filter(o => o.priority >= 0)
        .sort((a, b) => b.priority - a.priority || b.weight - a.weight)
        .slice(0, QUEUE_SIZE)
        .map(o => ({ role: o.role, priority: o.priority, weight: o.weight }));
}

class SpawnManager {
    private readonly external: Map<string, ExternalSpawnRequest & { expiresAt: number }> = new Map();
    private readonly emptyUntil: Map<string, number> = new Map();
    private readonly idleRoomUntil: Map<string, number> = new Map();
    /** Rooms waiting for energy: highest energy seen and when it last rose */
    private readonly waiting: Map<string, { energy: number; since: number }> = new Map();
    /** Role of the best option a room is waiting to pay for (room visuals) */
    private readonly waitingRole: Map<string, string> = new Map();
    /** Priority and body cost of that option (cost unknown while no body can be built) */
    private readonly waitingOption: Map<string, { priority: number; cost?: number }> = new Map();
    /** Best options of the room's last evaluation, best first (room visuals) */
    private readonly lastQueue: Map<string, SpawnQueueEntry[]> = new Map();
    private readonly roles: SpawnRole[];

    constructor() {
        const external: SpawnRole = {
            id: "external",
            emptyTimeout: 0,
            options: room => this.externalOptions(room),
            body: (_room, option) => option.body ?? [],
            memory: (_room, option) => option.memory ?? {}
        };
        this.roles = [...ECONOMY_SPAWN_ROLES, external];
    }

    /**
     * Ask for a creep. Call it each time the module runs while the creep is still needed; the request
     * expires after `ttl` ticks without renewal and is removed once spawned. The caller counts its
     * existing creeps (spawning ones included) to avoid over-requesting.
     */
    requestSpawn(request: ExternalSpawnRequest): void {
        this.external.set(request.id, { ...request, expiresAt: Game.time + (request.ttl ?? DEFAULT_REQUEST_TTL) });
        // A new request wakes the room up
        this.idleRoomUntil.delete(request.roomName);
    }

    hasPendingRequest(id: string): boolean {
        const request = this.external.get(id);
        return !!request && request.expiresAt >= Game.time;
    }

    /** Role the room will spawn next once it has the energy, if it is waiting */
    nextRole(roomName: string): string | undefined {
        return this.waitingRole.get(roomName);
    }

    /** Role, priority and body cost of the option the room waits for, if it is waiting */
    nextSpawn(roomName: string): { role: string; priority: number; cost?: number } | undefined {
        const role = this.waitingRole.get(roomName);
        const option = this.waitingOption.get(roomName);
        return role && option ? { role, ...option } : undefined;
    }

    /** Up to QUEUE_SIZE best options of the room's last evaluation (while a spawn was free), best first */
    queue(roomName: string): SpawnQueueEntry[] {
        return this.lastQueue.get(roomName) ?? [];
    }

    run(): void {
        for (const name in Game.rooms) {
            const room = Game.rooms[name];
            if (!room.controller?.my) continue;
            const spawns = mySpawns(room);
            if (spawns.length === 0) continue;
            this.manageRoom(room, spawns);
        }
    }

    private externalOptions(room: Room): SpawnOption[] {
        const options: SpawnOption[] = [];
        for (const [id, request] of this.external) {
            if (request.expiresAt < Game.time) {
                this.external.delete(id);
                continue;
            }
            if (request.roomName !== room.name) continue;
            if (bodyCost(request.body) > room.energyCapacityAvailable) {
                log.warn("SpawnManager", `Request ${id} body costs more than ${room.name} capacity, dropped`);
                this.external.delete(id);
                continue;
            }
            options.push({
                role: request.memory.role,
                priority: request.priority,
                weight: request.weight ?? 0,
                body: request.body,
                memory: request.memory,
                requestId: id,
                reason: request.reason ?? id
            });
        }
        return options;
    }

    private collectOptions(room: Room): (SpawnOption & { spawnRole: SpawnRole })[] {
        if ((this.idleRoomUntil.get(room.name) ?? -1) > Game.time) return [];
        const options: (SpawnOption & { spawnRole: SpawnRole })[] = [];
        for (const role of this.roles) {
            const key = `${room.name}:${role.id}`;
            if ((this.emptyUntil.get(key) ?? -1) > Game.time) continue;
            const roleOptions = role.options(room);
            if (roleOptions.length === 0 && role.emptyTimeout > 0) this.emptyUntil.set(key, Game.time + role.emptyTimeout);
            for (const option of roleOptions) options.push({ ...option, spawnRole: role });
        }
        if (options.length === 0) this.idleRoomUntil.set(room.name, Game.time + IDLE_ROOM_TICKS);
        return options;
    }

    private manageRoom(room: Room, spawns: StructureSpawn[]): void {
        const available = spawns.filter(s => !s.spawning);
        if (available.length === 0) return;

        // An option bound to a busy nearby spawn waits for it
        const options = this.collectOptions(room).filter(option => {
            if (!option.preferClosestSpawn) return true;
            const closest = _.min(spawns, s => s.pos.getRangeTo(option.preferClosestSpawn!)) as StructureSpawn;
            return closest.pos.getRangeTo(option.preferClosestSpawn) >= 3 || available.includes(closest);
        });
        const option = getBestOption(options);
        this.lastQueue.set(room.name, bestOptions(options));
        this.waitingRole.delete(room.name);
        this.waitingOption.delete(room.name);
        if (!option) return;

        let spawn = _.sample(available);
        if (option.preferClosestSpawn) {
            const closest = _.min(spawns, s => s.pos.getRangeTo(option.preferClosestSpawn!)) as StructureSpawn;
            if (closest.pos.getRangeTo(option.preferClosestSpawn) < 3) spawn = closest;
        }
        if (this.trySpawn(room, spawn, option, options)) {
            this.waiting.delete(room.name);
            starvedRooms.delete(room.name);
        } else {
            this.waitingRole.set(room.name, option.role);
            this.trackStarvation(room);
        }
    }

    private trackStarvation(room: Room): void {
        const state = this.waiting.get(room.name);
        if (!state || room.energyAvailable > state.energy) {
            this.waiting.set(room.name, { energy: room.energyAvailable, since: Game.time });
            return;
        }
        if (Game.time - state.since >= STARVED_TICKS && !starvedRooms.has(room.name)) {
            starvedRooms.add(room.name);
            countStat("spawn:starved");
        }
    }

    private trySpawn(
        room: Room,
        spawn: StructureSpawn,
        option: SpawnOption & { spawnRole: SpawnRole },
        options: (SpawnOption & { spawnRole: SpawnRole })[]
    ): boolean {
        const body = option.spawnRole.body(room, option);
        this.waitingOption.set(room.name, { priority: option.priority });
        if (body.length === 0) return false;
        const cost = bodyCost(body);
        this.waitingOption.set(room.name, { priority: option.priority, cost });
        if (cost > room.energyAvailable) return false; // wait for energy

        const memory = { room: room.name, ...option.spawnRole.memory(room, option), role: option.role } as CreepMemory;
        const name = this.creepName(option.role);
        const opts: SpawnOptions = { memory };
        const energyStructures = spawnEnergyStructures(room);
        if (energyStructures) opts.energyStructures = energyStructures;
        const directions = spawnExitDirections(spawn);
        if (directions) opts.directions = directions;
        const result = spawn.spawnCreep(body, name, opts);
        if (result !== OK) {
            log.warn("SpawnManager", `Failed to spawn ${option.role} in ${room.name}: ${result}`);
            // Energy is there but unusable (inactive extensions) and nobody can fix it: recovery transporter
            if (result === ERR_NOT_ENOUGH_ENERGY && room.find(FIND_MY_CREEPS, { filter: c => c.memory.role === "transporter" }).length === 0) {
                spawn.spawnCreep([CARRY, CARRY, MOVE, CARRY, CARRY, MOVE], this.creepName("transporter"), {
                    memory: { role: "transporter", room: room.name }
                });
            }
            return false;
        }
        if (option.requestId) this.external.delete(option.requestId);
        // Boosts at the labs before the creep starts working (Hivemind spawn-manager.ts)
        const boosts = option.spawnRole.boosts?.(room, option, body);
        if (boosts)
            markForBoosting(name, body, boosts, option.spawnRole.boostWhileWorking, option.spawnRole.boostTimeout);
        // Something was spawned: the room's needs changed
        this.idleRoomUntil.delete(room.name);
        log.info("SpawnManager", `Spawning ${name} in ${room.name} (${body.length} parts, ${cost} energy, priority ${option.priority})`);
        countStat(`spawned:${option.role}`);
        recordSpawn(room.name, option.role, option.priority, option.weight, cost, body.length, memory, this.reason(room, option, options));
        return true;
    }

    /** The option's own reason (else its role's creep count at home), the room energy and the runner-up */
    private reason(room: Room, option: SpawnOption, options: SpawnOption[]): string {
        const parts = [option.reason ?? `had ${creepsByRole(room.name, option.role).length}`];
        // Remote options carry their source (remote/remoteSpawnRole.ts RemoteOption)
        const target = (option as { remote?: { key?: string } }).remote?.key;
        if (target) parts.push(`for ${target}`);
        parts.push(`energy ${room.energyAvailable}/${room.energyCapacityAvailable}`);
        const next = getBestOption(options.filter(o => o !== option));
        if (next) parts.push(`next ${next.role} ${next.priority}/${Math.round(next.weight * 100) / 100}`);
        return parts.join(", ");
    }

    private creepName(role: string): string {
        if (!Memory.creepCounter) Memory.creepCounter = {};
        let counter = Memory.creepCounter[role] ?? 0;
        let name: string;
        do {
            name = `${role}_${counter.toString(36)}`;
            counter = (counter + 1) % (36 * 36 * 36);
        } while (Game.creeps[name]);
        Memory.creepCounter[role] = counter;
        return name;
    }
}

declare global {
    interface Memory {
        creepCounter?: { [role: string]: number };
    }
}

export const spawnManager = new SpawnManager();

export const spawnManagerModule = () => spawnManager.run();
