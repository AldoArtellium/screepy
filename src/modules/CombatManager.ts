/**
 * CombatManager - Offensive operations management
 *
 * Features:
 * - Enemy room evaluation and target selection
 * - Attack planning and composition calculation
 * - Drain attack operations
 * - Dismantle attack operations
 * - Combat squad coordination
 */

import { intelManager } from "./IntelManager";
import { log } from "../utils/logger";
import { trafficManager } from "./TrafficManager";

/** Attack operation types */
export enum AttackType {
    /** Drain towers by healing tanks */
    DRAIN = "drain",
    /** Dismantle walls/structures */
    DISMANTLE = "dismantle",
    /** Harass remote miners */
    HARASS = "harass",
    /** Full room assault */
    ASSAULT = "assault"
}

/** Attack target types by priority */
export enum TargetPriority {
    SPAWN = 0,
    TOWER = 1,
    TERMINAL = 2,
    STORAGE = 3,
    EXTENSION = 4,
    RAMPART = 5,
    WALL = 6,
    CONTAINER = 7,
    OTHER = 8
}

/** Attack operation configuration */
interface AttackOperation {
    id: string;
    type: AttackType;
    targetRoom: string;
    sourceRoom: string;
    status: "planning" | "spawning" | "staging" | "attacking" | "retreating" | "complete";
    creeps: string[];
    createdAt: number;
    startedAt?: number;
    completedAt?: number;
    /** Target structure IDs in priority order */
    targets?: string[];
}

/** Combat creep body configurations - reserved for future spawning logic */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const COMBAT_BODIES = {
    /** Melee attacker - high damage, low cost */
    ATTACKER: {
        parts: [TOUGH, TOUGH, ATTACK, ATTACK, ATTACK, ATTACK, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
        cost: 560
    },
    /** Healer - keeps attackers alive */
    HEALER: {
        parts: [TOUGH, TOUGH, HEAL, HEAL, HEAL, HEAL, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
        cost: 1260
    },
    /** Dismantler - for taking down structures */
    DISMANTLER: {
        parts: [TOUGH, TOUGH, WORK, WORK, WORK, WORK, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
        cost: 660
    },
    /** Drain tank - absorbs tower damage */
    TANK: {
        parts: [
            TOUGH, TOUGH, TOUGH, TOUGH, TOUGH,
            TOUGH, TOUGH, TOUGH, TOUGH, TOUGH,
            MOVE, MOVE, MOVE, MOVE, MOVE,
            MOVE, MOVE, MOVE, MOVE, MOVE,
            HEAL, HEAL, HEAL, HEAL, HEAL
        ],
        cost: 1750
    }
};

/** Minimum requirements to start attack types */
const ATTACK_REQUIREMENTS = {
    [AttackType.DRAIN]: {
        minRCL: 5,
        minEnergy: 5000,
        minTowers: 1 // Target must have towers
    },
    [AttackType.DISMANTLE]: {
        minRCL: 4,
        minEnergy: 3000,
        minCreeps: 2
    },
    [AttackType.HARASS]: {
        minRCL: 3,
        minEnergy: 1500,
        minCreeps: 1
    },
    [AttackType.ASSAULT]: {
        minRCL: 7,
        minEnergy: 20000,
        minCreeps: 6
    }
};

class CombatManager {
    /** Active attack operations */
    private operations: Map<string, AttackOperation> = new Map();

    /**
     * Main combat management function
     */
    manage(): void {
        // Only run if we have at least one room at RCL 5+
        const highLevelRooms = Object.values(Game.rooms).filter(
            r => r.controller?.my && r.controller.level >= 5
        );

        if (highLevelRooms.length === 0) return;

        // Process active operations
        for (const [id, op] of this.operations) {
            this.processOperation(op);

            // Cleanup completed operations
            if (op.status === "complete" && op.completedAt &&
                Game.time - op.completedAt > 100) {
                this.operations.delete(id);
            }
        }

        // Auto-target hostile remote miners (harassment)
        this.autoHarass(highLevelRooms);
    }

    /**
     * Evaluate an enemy room for attack viability
     */
    evaluateTarget(roomName: string, sourceRoom: Room): {
        viable: boolean;
        attackType: AttackType | null;
        score: number;
        reason: string;
    } {
        const intel = intelManager.getIntel(roomName);

        if (!intel) {
            return { viable: false, attackType: null, score: 0, reason: "No intel" };
        }

        // Can't attack our own rooms (guard against Memory.username being undefined early)
        if (!Memory.username || intel.owner === Memory.username) {
            return { viable: false, attackType: null, score: 0, reason: "Own room or unknown player" };
        }

        // Skip unowned rooms (nothing to attack)
        if (!intel.owner) {
            return { viable: false, attackType: null, score: 0, reason: "Unowned" };
        }

        // Calculate distance
        const distance = intelManager.getRoomDistance(sourceRoom.name, roomName);
        if (distance > 5) {
            return { viable: false, attackType: null, score: 0, reason: "Too far" };
        }

        // Check our capability
        const ourRCL = sourceRoom.controller?.level ?? 0;
        const ourEnergy = sourceRoom.storage?.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0;

        // Determine attack type based on target
        let attackType: AttackType | null = null;
        let score = 0;

        // Low level target - easy assault
        if (intel.controllerLevel <= 3) {
            if (ourRCL >= 4 && ourEnergy >= 3000) {
                attackType = AttackType.ASSAULT;
                score = 100 - distance * 10;
            }
        }
        // Medium target - dismantle or drain
        else if (intel.controllerLevel <= 5) {
            if (ourRCL >= 5 && ourEnergy >= 5000) {
                attackType = AttackType.DRAIN;
                score = 80 - distance * 10;
            }
        }
        // High level target - only harass
        else if (intel.controllerLevel >= 6) {
            if (ourRCL >= 5) {
                attackType = AttackType.HARASS;
                score = 50 - distance * 10;
            }
        }

        if (!attackType) {
            return { viable: false, attackType: null, score: 0, reason: "Insufficient capability" };
        }

        return {
            viable: true,
            attackType,
            score,
            reason: `${attackType} viable, score ${score}`
        };
    }

    /**
     * Plan an attack operation
     */
    planAttack(
        targetRoom: string,
        sourceRoom: string,
        type: AttackType
    ): AttackOperation | null {
        const source = Game.rooms[sourceRoom];
        if (!source?.controller?.my) return null;

        // Check requirements
        const reqs = ATTACK_REQUIREMENTS[type];
        if (source.controller.level < reqs.minRCL) {
            log.warn("CombatManager", `RCL too low for ${type} attack`);
            return null;
        }

        const energy = source.storage?.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0;
        if (energy < reqs.minEnergy) {
            log.warn("CombatManager", `Insufficient energy for ${type} attack`);
            return null;
        }

        const operation: AttackOperation = {
            id: `${type}-${targetRoom}-${Game.time}`,
            type,
            targetRoom,
            sourceRoom,
            status: "planning",
            creeps: [],
            createdAt: Game.time
        };

        this.operations.set(operation.id, operation);
        log.info("CombatManager", `Planned ${type} attack on ${targetRoom} from ${sourceRoom}`);

        return operation;
    }

    /**
     * Process an active attack operation
     */
    private processOperation(op: AttackOperation): void {
        switch (op.status) {
            case "planning":
                this.planCreeps(op);
                break;

            case "spawning":
                this.checkSpawnProgress(op);
                break;

            case "staging":
                this.checkStagingComplete(op);
                break;

            case "attacking":
                this.manageAttack(op);
                break;

            case "retreating":
                this.manageRetreat(op);
                break;
        }
    }

    /**
     * Plan creeps for an operation
     */
    private planCreeps(op: AttackOperation): void {
        const composition = this.getRequiredComposition(op.type);

        // Store required composition in memory for SpawnManager
        if (!Memory.combatOperations) {
            Memory.combatOperations = {};
        }
        Memory.combatOperations[op.id] = {
            sourceRoom: op.sourceRoom,
            targetRoom: op.targetRoom,
            requiredCreeps: composition,
            spawnedCreeps: []
        };

        op.status = "spawning";
        log.debug("CombatManager", `Operation ${op.id} now spawning`);
    }

    /**
     * Get required creep composition for an attack type
     */
    private getRequiredComposition(type: AttackType): { bodyType: string; count: number }[] {
        switch (type) {
            case AttackType.DRAIN:
                return [
                    { bodyType: "tank", count: 2 },
                    { bodyType: "healer", count: 2 }
                ];

            case AttackType.DISMANTLE:
                return [
                    { bodyType: "dismantler", count: 2 },
                    { bodyType: "healer", count: 1 }
                ];

            case AttackType.HARASS:
                return [
                    { bodyType: "attacker", count: 1 }
                ];

            case AttackType.ASSAULT:
                return [
                    { bodyType: "attacker", count: 3 },
                    { bodyType: "healer", count: 2 },
                    { bodyType: "dismantler", count: 1 }
                ];

            default:
                return [];
        }
    }

    /**
     * Check if spawning is complete
     */
    private checkSpawnProgress(op: AttackOperation): void {
        const opData = Memory.combatOperations?.[op.id];
        if (!opData) {
            op.status = "complete";
            return;
        }

        // Count spawned creeps
        const aliveCreeps = (opData.spawnedCreeps ?? []).filter(
            name => Game.creeps[name]
        );

        // Check if we have enough
        const totalRequired = opData.requiredCreeps.reduce(
            (sum, r) => sum + r.count,
            0
        );

        if (aliveCreeps.length >= totalRequired) {
            op.creeps = aliveCreeps;
            op.status = "staging";
            log.debug("CombatManager", `Operation ${op.id} spawning complete, staging`);
        }

        // Timeout check
        if (Game.time - op.createdAt > 3000) {
            log.warn("CombatManager", `Operation ${op.id} spawn timeout, aborting`);
            op.status = "complete";
        }
    }

    /**
     * Check if all creeps are staged at the target room edge
     */
    private checkStagingComplete(op: AttackOperation): void {
        const creeps = op.creeps.map(name => Game.creeps[name]).filter(Boolean);

        if (creeps.length === 0) {
            op.status = "complete";
            return;
        }

        // Check if all creeps are in adjacent room or target room
        const allStaged = creeps.every(c => {
            const distance = intelManager.getRoomDistance(c.room.name, op.targetRoom);
            return distance <= 1;
        });

        if (allStaged) {
            op.status = "attacking";
            op.startedAt = Game.time;
            log.info("CombatManager", `Operation ${op.id} attacking ${op.targetRoom}`);
        }
    }

    /**
     * Manage an active attack
     */
    private manageAttack(op: AttackOperation): void {
        const creeps = op.creeps.map(name => Game.creeps[name]).filter(Boolean) as Creep[];

        // Check if we've lost too many creeps
        if (creeps.length === 0) {
            op.status = "complete";
            op.completedAt = Game.time;
            log.info("CombatManager", `Operation ${op.id} lost all creeps`);
            return;
        }

        // Get target room visibility
        const targetRoom = Game.rooms[op.targetRoom];

        if (!targetRoom) {
            // Move creeps toward target room
            for (const creep of creeps) {
                if (creep.room.name !== op.targetRoom) {
                    this.moveToRoom(creep, op.targetRoom);
                }
            }
            return;
        }

        // Find and attack targets
        const target = this.selectAttackTarget(targetRoom);
        if (!target) {
            // No targets - mission complete
            op.status = "retreating";
            log.info("CombatManager", `Operation ${op.id} no targets, retreating`);
            return;
        }

        // Direct creeps based on their role
        for (const creep of creeps) {
            this.directCombatCreep(creep, target, op);
        }

        // Check for retreat conditions
        if (this.shouldRetreat(creeps, targetRoom)) {
            op.status = "retreating";
            log.info("CombatManager", `Operation ${op.id} retreating`);
        }
    }

    /**
     * Select the highest priority attack target
     */
    private selectAttackTarget(room: Room): Structure | Creep | null {
        // Priority 1: Hostile creeps that can attack
        const hostiles = room.find(FIND_HOSTILE_CREEPS, {
            filter: c => c.getActiveBodyparts(ATTACK) > 0 ||
                        c.getActiveBodyparts(RANGED_ATTACK) > 0
        });
        if (hostiles.length > 0) {
            return hostiles.sort((a, b) => a.hits - b.hits)[0];
        }

        // Priority 2: Spawns
        const spawns = room.find(FIND_HOSTILE_SPAWNS);
        if (spawns.length > 0) {
            return spawns.sort((a, b) => a.hits - b.hits)[0];
        }

        // Priority 3: Towers
        const towers = room.find(FIND_HOSTILE_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_TOWER
        });
        if (towers.length > 0) {
            return towers.sort((a, b) => a.hits - b.hits)[0];
        }

        // Priority 4: Terminal
        const terminal = room.find(FIND_HOSTILE_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_TERMINAL
        })[0];
        if (terminal) return terminal;

        // Priority 5: Storage
        const storage = room.find(FIND_HOSTILE_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_STORAGE
        })[0];
        if (storage) return storage;

        // Priority 6: Extensions
        const extensions = room.find(FIND_HOSTILE_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_EXTENSION
        });
        if (extensions.length > 0) {
            return extensions[0];
        }

        return null;
    }

    /**
     * Direct a combat creep based on its body type
     */
    private directCombatCreep(
        creep: Creep,
        target: Structure | Creep,
        op: AttackOperation
    ): void {
        // Determine creep role by parts
        const attackParts = creep.getActiveBodyparts(ATTACK);
        const healParts = creep.getActiveBodyparts(HEAL);
        const workParts = creep.getActiveBodyparts(WORK);

        if (healParts > 0) {
            // Healer - stay near attackers and heal
            this.runHealer(creep, op);
        } else if (workParts > 0) {
            // Dismantler - attack structures
            this.runDismantler(creep, target);
        } else if (attackParts > 0) {
            // Attacker - melee attack
            this.runAttacker(creep, target);
        }
    }

    /**
     * Run healer logic
     */
    private runHealer(creep: Creep, op: AttackOperation): void {
        // Find injured friendly creep
        const alliedCreeps = op.creeps
            .map(name => Game.creeps[name])
            .filter((c): c is Creep => !!c && c.id !== creep.id);

        const injured = alliedCreeps.filter(c => c.hits < c.hitsMax);

        if (injured.length > 0) {
            // Heal most injured
            const target = injured.sort((a, b) => a.hits - b.hits)[0];

            if (creep.pos.isNearTo(target)) {
                creep.heal(target);
            } else if (creep.pos.inRangeTo(target, 3)) {
                creep.rangedHeal(target);
                trafficManager.requestMove(creep, target, { combat: true });
            } else {
                trafficManager.requestMove(creep, target, { combat: true });
            }
        } else if (alliedCreeps.length > 0) {
            // Follow closest ally
            const closest = creep.pos.findClosestByRange(alliedCreeps);
            if (closest && !creep.pos.isNearTo(closest)) {
                trafficManager.requestMove(creep, closest, { combat: true });
            }
            // Pre-heal self
            creep.heal(creep);
        }
    }

    /**
     * Run dismantler logic
     */
    private runDismantler(creep: Creep, target: Structure | Creep): void {
        if (target instanceof Structure) {
            if (creep.pos.isNearTo(target)) {
                creep.dismantle(target);
            } else {
                trafficManager.requestMove(creep, target, { combat: true });
            }
        } else {
            // Attack creeps if no structures
            if (creep.pos.isNearTo(target)) {
                creep.attack(target);
            } else {
                trafficManager.requestMove(creep, target, { combat: true });
            }
        }
    }

    /**
     * Run attacker logic
     */
    private runAttacker(creep: Creep, target: Structure | Creep): void {
        if (creep.pos.isNearTo(target)) {
            creep.attack(target);
        } else {
            trafficManager.requestMove(creep, target, { combat: true });
        }
    }

    /**
     * Check if squad should retreat
     */
    private shouldRetreat(creeps: Creep[], targetRoom: Room): boolean {
        // Retreat if more than half are low health
        const lowHealth = creeps.filter(c => c.hits < c.hitsMax * 0.3).length;
        if (lowHealth > creeps.length / 2) {
            return true;
        }

        // Retreat if tower damage is too high
        const towers = targetRoom.find(FIND_HOSTILE_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_TOWER
        }) as StructureTower[];

        if (towers.length >= 4) {
            const totalDamage = towers.reduce((sum, t) =>
                sum + (t.store.getUsedCapacity(RESOURCE_ENERGY) > 10 ? 600 : 0), 0
            );
            const totalHealing = creeps.reduce((sum, c) =>
                sum + c.getActiveBodyparts(HEAL) * 12, 0
            );

            if (totalDamage > totalHealing * 2) {
                return true;
            }
        }

        return false;
    }

    /**
     * Manage retreat
     */
    private manageRetreat(op: AttackOperation): void {
        const creeps = op.creeps.map(name => Game.creeps[name]).filter(Boolean) as Creep[];

        if (creeps.length === 0) {
            op.status = "complete";
            op.completedAt = Game.time;
            return;
        }

        // Move all creeps back to source room
        let allHome = true;
        for (const creep of creeps) {
            if (creep.room.name !== op.sourceRoom) {
                this.moveToRoom(creep, op.sourceRoom);
                allHome = false;
            }
        }

        if (allHome) {
            op.status = "complete";
            op.completedAt = Game.time;
            log.info("CombatManager", `Operation ${op.id} retreat complete`);
        }
    }

    /**
     * Auto-harass enemy remote miners
     */
    private autoHarass(ourRooms: Room[]): void {
        // Check for enemy miners in nearby rooms
        for (const room of ourRooms) {
            const remotes = room.memory.remoteRooms ?? [];

            for (const remoteName of remotes) {
                const remote = Game.rooms[remoteName];
                if (!remote) continue;

                // Check for hostile creeps with WORK parts (miners)
                const hostileMiners = remote.find(FIND_HOSTILE_CREEPS, {
                    filter: c => c.getActiveBodyparts(WORK) > 0
                });

                if (hostileMiners.length > 0) {
                    // TODO: Create harassment task if we don't have one
                    log.debug("CombatManager", `Hostile miners detected in ${remoteName}`);
                }
            }
        }
    }

    /**
     * Move creep to a different room
     */
    private moveToRoom(creep: Creep, targetRoom: string): void {
        trafficManager.moveToRoom(creep, targetRoom, { combat: true });
    }

    /**
     * Get active operations
     */
    getOperations(): AttackOperation[] {
        return [...this.operations.values()];
    }

    /**
     * Cancel an operation
     */
    cancelOperation(operationId: string): void {
        const op = this.operations.get(operationId);
        if (op) {
            op.status = "retreating";
            log.info("CombatManager", `Cancelled operation ${operationId}`);
        }
    }

    /**
     * Get summary of combat operations for dashboard
     */
    getOperationsSummary(_detailed: boolean = false): CombatOpSummary[] {
        const summaries: CombatOpSummary[] = [];

        for (const [, op] of this.operations) {
            const aliveCreeps = op.creeps.filter(name => Game.creeps[name]).length;

            summaries.push({
                id: op.id,
                type: op.type,
                target: op.targetRoom,
                status: op.status,
                creepCount: aliveCreeps
            });
        }

        // Also check memory for ops that may not be loaded yet
        if (Memory.combatOperations) {
            for (const [id, memOp] of Object.entries(Memory.combatOperations)) {
                // Skip if already in operations map
                if (this.operations.has(id)) continue;

                const aliveCreeps = memOp.spawnedCreeps.filter(name => Game.creeps[name]).length;
                if (aliveCreeps > 0 || memOp.requiredCreeps.length > 0) {
                    summaries.push({
                        id,
                        type: id.split("-")[0],
                        target: memOp.targetRoom,
                        status: "spawning",
                        creepCount: aliveCreeps
                    });
                }
            }
        }

        return summaries;
    }
}

// Add memory interface for combat operations
declare global {
    interface Memory {
        combatOperations?: {
            [id: string]: {
                sourceRoom: string;
                targetRoom: string;
                requiredCreeps: { bodyType: string; count: number }[];
                spawnedCreeps: string[];
            };
        };
    }
}

// Singleton instance
const combatManagerInstance = new CombatManager();

export const combatManagerModule = () => {
    // Only run every 10 ticks to save CPU
    if (Game.time % 10 !== 0) return;
    combatManagerInstance.manage();
};

export const combatManager = combatManagerInstance;
