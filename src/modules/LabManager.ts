/**
 * LabManager - Lab operations and boost management
 *
 * Features:
 * - Lab infrastructure (input/output assignment)
 * - Compound production recipes
 * - Production queue management
 * - Boost request system for creeps
 * - Auto-boost for combat and economy
 */

import { log } from "../utils/logger";

/** Compound recipes - input1 + input2 = output */
type RecipeInput = MineralConstant | MineralCompoundConstant;
const RECIPES: Record<MineralCompoundConstant, [RecipeInput, RecipeInput]> = {
    // Tier 1 compounds
    [RESOURCE_HYDROXIDE]: [RESOURCE_HYDROGEN, RESOURCE_OXYGEN],
    [RESOURCE_ZYNTHIUM_KEANITE]: [RESOURCE_ZYNTHIUM, RESOURCE_KEANIUM],
    [RESOURCE_UTRIUM_LEMERGITE]: [RESOURCE_UTRIUM, RESOURCE_LEMERGIUM],
    [RESOURCE_GHODIUM]: [RESOURCE_ZYNTHIUM_KEANITE, RESOURCE_UTRIUM_LEMERGITE],

    // Tier 2 compounds (upgrade)
    [RESOURCE_UTRIUM_HYDRIDE]: [RESOURCE_UTRIUM, RESOURCE_HYDROGEN],
    [RESOURCE_UTRIUM_OXIDE]: [RESOURCE_UTRIUM, RESOURCE_OXYGEN],
    [RESOURCE_KEANIUM_HYDRIDE]: [RESOURCE_KEANIUM, RESOURCE_HYDROGEN],
    [RESOURCE_KEANIUM_OXIDE]: [RESOURCE_KEANIUM, RESOURCE_OXYGEN],
    [RESOURCE_LEMERGIUM_HYDRIDE]: [RESOURCE_LEMERGIUM, RESOURCE_HYDROGEN],
    [RESOURCE_LEMERGIUM_OXIDE]: [RESOURCE_LEMERGIUM, RESOURCE_OXYGEN],
    [RESOURCE_ZYNTHIUM_HYDRIDE]: [RESOURCE_ZYNTHIUM, RESOURCE_HYDROGEN],
    [RESOURCE_ZYNTHIUM_OXIDE]: [RESOURCE_ZYNTHIUM, RESOURCE_OXYGEN],
    [RESOURCE_GHODIUM_HYDRIDE]: [RESOURCE_GHODIUM, RESOURCE_HYDROGEN],
    [RESOURCE_GHODIUM_OXIDE]: [RESOURCE_GHODIUM, RESOURCE_OXYGEN],

    // Tier 3 compounds (attack, heal, etc.)
    [RESOURCE_UTRIUM_ACID]: [RESOURCE_UTRIUM_HYDRIDE, RESOURCE_HYDROXIDE],
    [RESOURCE_UTRIUM_ALKALIDE]: [RESOURCE_UTRIUM_OXIDE, RESOURCE_HYDROXIDE],
    [RESOURCE_KEANIUM_ACID]: [RESOURCE_KEANIUM_HYDRIDE, RESOURCE_HYDROXIDE],
    [RESOURCE_KEANIUM_ALKALIDE]: [RESOURCE_KEANIUM_OXIDE, RESOURCE_HYDROXIDE],
    [RESOURCE_LEMERGIUM_ACID]: [RESOURCE_LEMERGIUM_HYDRIDE, RESOURCE_HYDROXIDE],
    [RESOURCE_LEMERGIUM_ALKALIDE]: [RESOURCE_LEMERGIUM_OXIDE, RESOURCE_HYDROXIDE],
    [RESOURCE_ZYNTHIUM_ACID]: [RESOURCE_ZYNTHIUM_HYDRIDE, RESOURCE_HYDROXIDE],
    [RESOURCE_ZYNTHIUM_ALKALIDE]: [RESOURCE_ZYNTHIUM_OXIDE, RESOURCE_HYDROXIDE],
    [RESOURCE_GHODIUM_ACID]: [RESOURCE_GHODIUM_HYDRIDE, RESOURCE_HYDROXIDE],
    [RESOURCE_GHODIUM_ALKALIDE]: [RESOURCE_GHODIUM_OXIDE, RESOURCE_HYDROXIDE],

    // Tier 4 compounds (final boosts)
    [RESOURCE_CATALYZED_UTRIUM_ACID]: [RESOURCE_UTRIUM_ACID, RESOURCE_CATALYST],
    [RESOURCE_CATALYZED_UTRIUM_ALKALIDE]: [RESOURCE_UTRIUM_ALKALIDE, RESOURCE_CATALYST],
    [RESOURCE_CATALYZED_KEANIUM_ACID]: [RESOURCE_KEANIUM_ACID, RESOURCE_CATALYST],
    [RESOURCE_CATALYZED_KEANIUM_ALKALIDE]: [RESOURCE_KEANIUM_ALKALIDE, RESOURCE_CATALYST],
    [RESOURCE_CATALYZED_LEMERGIUM_ACID]: [RESOURCE_LEMERGIUM_ACID, RESOURCE_CATALYST],
    [RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE]: [RESOURCE_LEMERGIUM_ALKALIDE, RESOURCE_CATALYST],
    [RESOURCE_CATALYZED_ZYNTHIUM_ACID]: [RESOURCE_ZYNTHIUM_ACID, RESOURCE_CATALYST],
    [RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE]: [RESOURCE_ZYNTHIUM_ALKALIDE, RESOURCE_CATALYST],
    [RESOURCE_CATALYZED_GHODIUM_ACID]: [RESOURCE_GHODIUM_ACID, RESOURCE_CATALYST],
    [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: [RESOURCE_GHODIUM_ALKALIDE, RESOURCE_CATALYST]
};

/** Boost effects by part type */
interface BoostEffect { part: BodyPartConstant; effect: string; multiplier: number }
const BOOST_EFFECTS: Partial<Record<MineralCompoundConstant, BoostEffect>> = {
    // WORK boosts - harvest
    [RESOURCE_UTRIUM_OXIDE]: { part: WORK, effect: "harvest", multiplier: 3 },
    [RESOURCE_UTRIUM_ALKALIDE]: { part: WORK, effect: "harvest", multiplier: 5 },
    [RESOURCE_CATALYZED_UTRIUM_ALKALIDE]: { part: WORK, effect: "harvest", multiplier: 7 },

    // WORK boosts - build/repair
    [RESOURCE_LEMERGIUM_HYDRIDE]: { part: WORK, effect: "build", multiplier: 1.5 },
    [RESOURCE_LEMERGIUM_ACID]: { part: WORK, effect: "build", multiplier: 1.8 },
    [RESOURCE_CATALYZED_LEMERGIUM_ACID]: { part: WORK, effect: "build", multiplier: 2 },

    // WORK boosts - dismantle
    [RESOURCE_ZYNTHIUM_HYDRIDE]: { part: WORK, effect: "dismantle", multiplier: 2 },
    [RESOURCE_ZYNTHIUM_ACID]: { part: WORK, effect: "dismantle", multiplier: 3 },
    [RESOURCE_CATALYZED_ZYNTHIUM_ACID]: { part: WORK, effect: "dismantle", multiplier: 4 },

    // WORK boosts - upgradeController
    [RESOURCE_GHODIUM_HYDRIDE]: { part: WORK, effect: "upgradeController", multiplier: 1.5 },
    [RESOURCE_GHODIUM_ACID]: { part: WORK, effect: "upgradeController", multiplier: 1.8 },
    [RESOURCE_CATALYZED_GHODIUM_ACID]: { part: WORK, effect: "upgradeController", multiplier: 2 },

    // ATTACK boosts
    [RESOURCE_UTRIUM_HYDRIDE]: { part: ATTACK, effect: "attack", multiplier: 2 },
    [RESOURCE_UTRIUM_ACID]: { part: ATTACK, effect: "attack", multiplier: 3 },
    [RESOURCE_CATALYZED_UTRIUM_ACID]: { part: ATTACK, effect: "attack", multiplier: 4 },

    // RANGED_ATTACK boosts
    [RESOURCE_KEANIUM_OXIDE]: { part: RANGED_ATTACK, effect: "rangedAttack", multiplier: 2 },
    [RESOURCE_KEANIUM_ALKALIDE]: { part: RANGED_ATTACK, effect: "rangedAttack", multiplier: 3 },
    [RESOURCE_CATALYZED_KEANIUM_ALKALIDE]: { part: RANGED_ATTACK, effect: "rangedAttack", multiplier: 4 },

    // HEAL boosts
    [RESOURCE_LEMERGIUM_OXIDE]: { part: HEAL, effect: "heal", multiplier: 2 },
    [RESOURCE_LEMERGIUM_ALKALIDE]: { part: HEAL, effect: "heal", multiplier: 3 },
    [RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE]: { part: HEAL, effect: "heal", multiplier: 4 },

    // CARRY boosts
    [RESOURCE_KEANIUM_HYDRIDE]: { part: CARRY, effect: "capacity", multiplier: 2 },
    [RESOURCE_KEANIUM_ACID]: { part: CARRY, effect: "capacity", multiplier: 3 },
    [RESOURCE_CATALYZED_KEANIUM_ACID]: { part: CARRY, effect: "capacity", multiplier: 4 },

    // MOVE boosts
    [RESOURCE_ZYNTHIUM_OXIDE]: { part: MOVE, effect: "fatigue", multiplier: 2 },
    [RESOURCE_ZYNTHIUM_ALKALIDE]: { part: MOVE, effect: "fatigue", multiplier: 3 },
    [RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE]: { part: MOVE, effect: "fatigue", multiplier: 4 },

    // TOUGH boosts
    [RESOURCE_GHODIUM_OXIDE]: { part: TOUGH, effect: "damage", multiplier: 0.7 },
    [RESOURCE_GHODIUM_ALKALIDE]: { part: TOUGH, effect: "damage", multiplier: 0.5 },
    [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: { part: TOUGH, effect: "damage", multiplier: 0.3 }
};

/** Lab assignment in a room */
interface LabAssignment {
    inputLab1?: Id<StructureLab>;
    inputLab2?: Id<StructureLab>;
    outputLabs: Id<StructureLab>[];
    boostLabs: Id<StructureLab>[];
}

/** Production order */
interface ProductionOrder {
    compound: MineralCompoundConstant;
    amount: number;
    priority: number;
    createdAt: number;
}

/** Boost request */
interface BoostRequest {
    creepName: string;
    compound: MineralCompoundConstant;
    bodyParts: number;
    priority: number;
    createdAt: number;
    labId?: Id<StructureLab>;
}

class LabManager {
    /** Lab assignments per room */
    private labAssignments: Map<string, LabAssignment> = new Map();

    /** Production queue per room */
    private productionQueues: Map<string, ProductionOrder[]> = new Map();

    /** Boost request queue per room */
    private boostQueues: Map<string, BoostRequest[]> = new Map();

    /**
     * Main lab management function
     */
    manage(): void {
        // Only manage rooms with labs (RCL 6+)
        const labRooms = Object.values(Game.rooms).filter(
            r => r.controller?.my && r.controller.level >= 6
        );

        for (const room of labRooms) {
            // Initialize lab assignment if needed
            if (!this.labAssignments.has(room.name)) {
                this.assignLabs(room);
            }

            // Process production
            this.processProduction(room);

            // Process boost requests
            this.processBoostRequests(room);
        }
    }

    /**
     * Assign labs for a room (input, output, boost)
     */
    private assignLabs(room: Room): void {
        const labs = room.find(FIND_MY_STRUCTURES, {
            filter: (s): s is StructureLab => s.structureType === STRUCTURE_LAB
        });

        if (labs.length < 3) {
            // Not enough labs for reactions
            return;
        }

        // Find the two labs closest to each other as input labs
        let bestPair: [StructureLab, StructureLab] | null = null;
        let bestDistance = Infinity;

        for (let i = 0; i < labs.length; i++) {
            for (let j = i + 1; j < labs.length; j++) {
                const dist = labs[i].pos.getRangeTo(labs[j]);
                if (dist < bestDistance) {
                    bestDistance = dist;
                    bestPair = [labs[i], labs[j]];
                }
            }
        }

        if (!bestPair) return;

        const [inputLab1, inputLab2] = bestPair;

        // Remaining labs are output labs (for reactions)
        const outputLabs = labs
            .filter(l => l.id !== inputLab1.id && l.id !== inputLab2.id)
            .filter(l => l.pos.inRangeTo(inputLab1, 2) && l.pos.inRangeTo(inputLab2, 2))
            .map(l => l.id);

        // Labs not in range for reactions can be used for boosting
        const boostLabs = labs
            .filter(l => !outputLabs.includes(l.id) && l.id !== inputLab1.id && l.id !== inputLab2.id)
            .map(l => l.id);

        this.labAssignments.set(room.name, {
            inputLab1: inputLab1.id,
            inputLab2: inputLab2.id,
            outputLabs,
            boostLabs: [...boostLabs, ...outputLabs] // All labs can boost when not reacting
        });

        log.info("LabManager", `${room.name}: Assigned ${outputLabs.length} output labs, ${boostLabs.length} dedicated boost labs`);
    }

    /**
     * Process compound production
     */
    private processProduction(room: Room): void {
        const assignment = this.labAssignments.get(room.name);
        if (!assignment?.inputLab1 || !assignment?.inputLab2) return;

        const inputLab1 = Game.getObjectById(assignment.inputLab1);
        const inputLab2 = Game.getObjectById(assignment.inputLab2);

        if (!inputLab1 || !inputLab2) return;

        // Get production queue
        const queue = this.productionQueues.get(room.name) ?? [];
        if (queue.length === 0) {
            // Auto-queue production based on needs
            this.autoQueueProduction(room);
            return;
        }

        const currentOrder = queue[0];
        const recipe = RECIPES[currentOrder.compound];
        if (!recipe) {
            queue.shift(); // Invalid compound
            return;
        }

        // Check if input labs have correct resources
        const [input1, input2] = recipe;

        if (inputLab1.mineralType && inputLab1.mineralType !== input1) {
            // Wrong mineral - needs to be emptied
            return;
        }
        if (inputLab2.mineralType && inputLab2.mineralType !== input2) {
            return;
        }

        // Check if we have enough input materials
        if ((inputLab1.store.getUsedCapacity(input1) ?? 0) < 5 ||
            (inputLab2.store.getUsedCapacity(input2) ?? 0) < 5) {
            // Need more input materials - haulers should fill
            return;
        }

        // Run reactions in output labs
        for (const outputLabId of assignment.outputLabs) {
            const outputLab = Game.getObjectById(outputLabId);
            if (!outputLab) continue;

            if (outputLab.cooldown > 0) continue;

            // Run reaction
            const result = outputLab.runReaction(inputLab1, inputLab2);
            if (result === OK) {
                // Track production
                const produced = LAB_REACTION_AMOUNT ?? 5;
                currentOrder.amount -= produced;

                if (currentOrder.amount <= 0) {
                    queue.shift();
                    log.info("LabManager", `${room.name}: Completed production of ${currentOrder.compound}`);
                }
            }
        }
    }

    /**
     * Auto-queue production based on room needs
     */
    private autoQueueProduction(room: Room): void {
        const storage = room.storage;
        const terminal = room.terminal;
        if (!storage && !terminal) return;

        // Priority compounds to produce
        const priorities: MineralCompoundConstant[] = [
            RESOURCE_GHODIUM, // Base for many boosts
            RESOURCE_CATALYZED_GHODIUM_ACID, // Upgrade boost
            RESOURCE_CATALYZED_UTRIUM_ACID, // Attack boost
            RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE, // Heal boost
            RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE // Move boost
        ];

        for (const compound of priorities) {
            const currentAmount =
                (storage?.store.getUsedCapacity(compound) ?? 0) +
                (terminal?.store.getUsedCapacity(compound) ?? 0);

            // Queue production if below threshold
            if (currentAmount < 5000) {
                // Check if we have ingredients
                if (this.hasIngredients(room, compound)) {
                    this.queueProduction(room.name, compound, 5000 - currentAmount);
                    return; // Only queue one at a time
                }
            }
        }
    }

    /**
     * Check if room has ingredients for a compound
     */
    hasIngredients(room: Room, compound: MineralCompoundConstant, depth: number = 0): boolean {
        // Prevent infinite recursion in case of circular recipes
        if (depth > 10) return false;

        const recipe = RECIPES[compound];
        if (!recipe) return false;

        const storage = room.storage;
        const terminal = room.terminal;

        for (const ingredient of recipe) {
            const amount =
                (storage?.store.getUsedCapacity(ingredient) ?? 0) +
                (terminal?.store.getUsedCapacity(ingredient) ?? 0);

            if (amount < 100) {
                // Check if this is a compound we can make
                if (RECIPES[ingredient as MineralCompoundConstant]) {
                    if (!this.hasIngredients(room, ingredient as MineralCompoundConstant, depth + 1)) {
                        return false;
                    }
                } else {
                    return false; // Base mineral we don't have
                }
            }
        }

        return true;
    }

    /**
     * Queue a production order
     */
    queueProduction(roomName: string, compound: MineralCompoundConstant, amount: number, priority: number = 50): void {
        if (!this.productionQueues.has(roomName)) {
            this.productionQueues.set(roomName, []);
        }

        const queue = this.productionQueues.get(roomName)!;

        // Check if already queued
        const existing = queue.find(o => o.compound === compound);
        if (existing) {
            existing.amount += amount;
            return;
        }

        queue.push({
            compound,
            amount,
            priority,
            createdAt: Game.time
        });

        // Sort by priority
        queue.sort((a, b) => a.priority - b.priority);

        log.info("LabManager", `Queued production: ${amount} ${compound}`);
    }

    /**
     * Request a boost for a creep
     */
    requestBoost(
        roomName: string,
        creepName: string,
        compound: MineralCompoundConstant,
        bodyParts: number,
        priority: number = 50
    ): void {
        if (!this.boostQueues.has(roomName)) {
            this.boostQueues.set(roomName, []);
        }

        const queue = this.boostQueues.get(roomName)!;

        queue.push({
            creepName,
            compound,
            bodyParts,
            priority,
            createdAt: Game.time
        });

        queue.sort((a, b) => a.priority - b.priority);

        log.info("LabManager", `Queued boost request: ${creepName} needs ${compound} for ${bodyParts} parts`);
    }

    /**
     * Process boost requests
     */
    private processBoostRequests(room: Room): void {
        const assignment = this.labAssignments.get(room.name);
        if (!assignment) return;

        const queue = this.boostQueues.get(room.name) ?? [];
        if (queue.length === 0) return;

        // Process first request
        const request = queue[0];
        const creep = Game.creeps[request.creepName];

        if (!creep) {
            // Creep died, remove request
            queue.shift();
            return;
        }

        // Find a lab with the required compound
        const boostLab = this.findBoostLab(room, assignment, request.compound);
        if (!boostLab) {
            // No lab available with this compound
            // TODO: Create task to fill lab
            return;
        }

        // Check if creep is at lab
        if (!creep.pos.isNearTo(boostLab)) {
            // Creep needs to move to lab
            // This would be handled by a BOOST_CREEP task
            return;
        }

        // Boost the creep
        const result = boostLab.boostCreep(creep, request.bodyParts);
        if (result === OK) {
            log.info("LabManager", `Boosted ${creep.name} with ${request.compound}`);
            queue.shift();
        } else if (result === ERR_NOT_ENOUGH_RESOURCES) {
            // Need more compound
            log.debug("LabManager", `Insufficient ${request.compound} to boost ${creep.name}`);
        }
    }

    /**
     * Find a lab that can boost with a specific compound
     */
    private findBoostLab(
        room: Room,
        assignment: LabAssignment,
        compound: MineralCompoundConstant
    ): StructureLab | null {
        for (const labId of assignment.boostLabs) {
            const lab = Game.getObjectById(labId);
            if (!lab) continue;

            // Check if lab has the compound
            if (lab.mineralType === compound && lab.store.getUsedCapacity(compound) >= 30) {
                return lab;
            }
        }

        // Check if any lab has the compound (even input labs)
        const allLabs = room.find(FIND_MY_STRUCTURES, {
            filter: (s): s is StructureLab =>
                s.structureType === STRUCTURE_LAB &&
                s.mineralType === compound &&
                s.store.getUsedCapacity(compound) >= 30
        });

        return allLabs[0] ?? null;
    }

    /**
     * Get best boost compound for a body part
     */
    getBestBoost(part: BodyPartConstant, effect: string, room: Room): MineralCompoundConstant | null {
        const storage = room.storage;
        const terminal = room.terminal;

        // Search from highest tier to lowest
        for (const [compound, info] of Object.entries(BOOST_EFFECTS)) {
            if (info?.part !== part || info?.effect !== effect) continue;

            const amount =
                (storage?.store.getUsedCapacity(compound as MineralCompoundConstant) ?? 0) +
                (terminal?.store.getUsedCapacity(compound as MineralCompoundConstant) ?? 0);

            if (amount >= 30) {
                return compound as MineralCompoundConstant;
            }
        }

        return null;
    }

    /**
     * Get lab assignment for a room
     */
    getLabAssignment(roomName: string): LabAssignment | undefined {
        return this.labAssignments.get(roomName);
    }

    /**
     * Get production queue for a room
     */
    getProductionQueue(roomName: string): ProductionOrder[] {
        return this.productionQueues.get(roomName) ?? [];
    }

    /**
     * Get boost queue for a room
     */
    getBoostQueue(roomName: string): BoostRequest[] {
        return this.boostQueues.get(roomName) ?? [];
    }

    /**
     * Get lab status summary for dashboard
     */
    getLabStatus(roomName: string): LabStatus {
        const queue = this.productionQueues.get(roomName) ?? [];
        const boostQueue = this.boostQueues.get(roomName) ?? [];

        return {
            producing: queue.length > 0 ? queue[0].compound : null,
            queueLength: queue.length,
            boostRequests: boostQueue.length
        };
    }
}

// Singleton instance
const labManagerInstance = new LabManager();

export const labManagerModule = () => {
    // Only run every 5 ticks to save CPU
    if (Game.time % 5 !== 0) return;
    labManagerInstance.manage();
};

export const labManager = labManagerInstance;
