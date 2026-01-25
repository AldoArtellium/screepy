/**
 * FactoryManager - Factory production and commodity network
 *
 * Features:
 * - Factory level tracking per room
 * - Commodity recipe management
 * - Compression of base minerals
 * - Multi-room production chains (L0 → L1 → L2 → etc.)
 * - Resource distribution via terminals
 * - Market integration for commodity sales
 */

import { log } from "../utils/logger";

/** Factory level products */
const FACTORY_PRODUCTS: Record<number, CommodityConstant[]> = {
    0: [
        RESOURCE_BATTERY, // Energy compression
        RESOURCE_COMPOSITE, RESOURCE_CRYSTAL, RESOURCE_LIQUID // Basic commodities
    ],
    1: [RESOURCE_TUBE, RESOURCE_FIXTURES, RESOURCE_FRAME, RESOURCE_HYDRAULICS, RESOURCE_MACHINE],
    2: [RESOURCE_CONDENSATE, RESOURCE_CONCENTRATE, RESOURCE_EXTRACT, RESOURCE_SPIRIT, RESOURCE_EMANATION],
    3: [RESOURCE_ESSENCE, RESOURCE_WIRE, RESOURCE_SWITCH, RESOURCE_TRANSISTOR, RESOURCE_MICROCHIP],
    4: [RESOURCE_CIRCUIT, RESOURCE_DEVICE],
    5: [RESOURCE_CELL, RESOURCE_PHLEGM, RESOURCE_TISSUE, RESOURCE_MUSCLE, RESOURCE_ORGANOID, RESOURCE_ORGANISM]
};

/** Commodity recipes */
const COMMODITY_RECIPES: Partial<Record<CommodityConstant, {
    level: number;
    cooldown: number;
    amount: number;
    components: Partial<Record<ResourceConstant, number>>;
}>> = {
    // Level 0 - Compression
    [RESOURCE_BATTERY]: { level: 0, cooldown: 10, amount: 50, components: { [RESOURCE_ENERGY]: 600 } },
    [RESOURCE_COMPOSITE]: { level: 0, cooldown: 50, amount: 20, components: { [RESOURCE_UTRIUM_BAR]: 20, [RESOURCE_ZYNTHIUM_BAR]: 20, [RESOURCE_ENERGY]: 20 } },
    [RESOURCE_CRYSTAL]: { level: 0, cooldown: 21, amount: 6, components: { [RESOURCE_LEMERGIUM_BAR]: 6, [RESOURCE_KEANIUM_BAR]: 6, [RESOURCE_PURIFIER]: 6, [RESOURCE_ENERGY]: 45 } },
    [RESOURCE_LIQUID]: { level: 0, cooldown: 60, amount: 12, components: { [RESOURCE_OXIDANT]: 12, [RESOURCE_REDUCTANT]: 12, [RESOURCE_GHODIUM_MELT]: 12, [RESOURCE_ENERGY]: 90 } },

    // Level 1
    [RESOURCE_TUBE]: { level: 1, cooldown: 93, amount: 2, components: { [RESOURCE_COMPOSITE]: 20, [RESOURCE_ZYNTHIUM_BAR]: 40, [RESOURCE_ENERGY]: 16 } },
    [RESOURCE_FIXTURES]: { level: 1, cooldown: 115, amount: 1, components: { [RESOURCE_COMPOSITE]: 20, [RESOURCE_ALLOY]: 41, [RESOURCE_OXIDANT]: 161, [RESOURCE_ENERGY]: 8 } },
    [RESOURCE_FRAME]: { level: 1, cooldown: 125, amount: 1, components: { [RESOURCE_COMPOSITE]: 20, [RESOURCE_ZYNTHIUM_BAR]: 50, [RESOURCE_ENERGY]: 8 } },
    [RESOURCE_HYDRAULICS]: { level: 1, cooldown: 128, amount: 1, components: { [RESOURCE_COMPOSITE]: 20, [RESOURCE_UTRIUM_BAR]: 41, [RESOURCE_REDUCTANT]: 161, [RESOURCE_ENERGY]: 8 } },
    [RESOURCE_MACHINE]: { level: 1, cooldown: 32, amount: 1, components: { [RESOURCE_COMPOSITE]: 10, [RESOURCE_ALLOY]: 10, [RESOURCE_ENERGY]: 9 } },

    // Level 2
    [RESOURCE_CONDENSATE]: { level: 2, cooldown: 8, amount: 30, components: { [RESOURCE_OXIDANT]: 60, [RESOURCE_KEANIUM_BAR]: 30, [RESOURCE_ENERGY]: 60 } },
    [RESOURCE_CONCENTRATE]: { level: 2, cooldown: 41, amount: 3, components: { [RESOURCE_REDUCTANT]: 15, [RESOURCE_PURIFIER]: 15, [RESOURCE_ZYNTHIUM_BAR]: 5, [RESOURCE_ENERGY]: 12 } },
    [RESOURCE_EXTRACT]: { level: 2, cooldown: 128, amount: 2, components: { [RESOURCE_CONDENSATE]: 30, [RESOURCE_OXIDANT]: 60, [RESOURCE_ENERGY]: 200 } },
    [RESOURCE_SPIRIT]: { level: 2, cooldown: 19, amount: 2, components: { [RESOURCE_CONCENTRATE]: 2, [RESOURCE_REDUCTANT]: 10, [RESOURCE_PURIFIER]: 2, [RESOURCE_ENERGY]: 60 } },
    [RESOURCE_EMANATION]: { level: 2, cooldown: 25, amount: 2, components: { [RESOURCE_SPIRIT]: 2, [RESOURCE_CONCENTRATE]: 2, [RESOURCE_PURIFIER]: 2, [RESOURCE_ENERGY]: 60 } },

    // Level 3
    [RESOURCE_ESSENCE]: { level: 3, cooldown: 4, amount: 1, components: { [RESOURCE_EMANATION]: 1, [RESOURCE_SPIRIT]: 1, [RESOURCE_CRYSTAL]: 110, [RESOURCE_GHODIUM_MELT]: 150 } },
    [RESOURCE_WIRE]: { level: 3, cooldown: 8, amount: 20, components: { [RESOURCE_UTRIUM_BAR]: 20, [RESOURCE_SILICON]: 100, [RESOURCE_ENERGY]: 40 } },
    [RESOURCE_SWITCH]: { level: 3, cooldown: 70, amount: 5, components: { [RESOURCE_WIRE]: 40, [RESOURCE_OXIDANT]: 95, [RESOURCE_UTRIUM_BAR]: 35, [RESOURCE_ENERGY]: 20 } },
    [RESOURCE_TRANSISTOR]: { level: 3, cooldown: 59, amount: 1, components: { [RESOURCE_SWITCH]: 4, [RESOURCE_WIRE]: 15, [RESOURCE_REDUCTANT]: 85, [RESOURCE_ENERGY]: 8 } },
    [RESOURCE_MICROCHIP]: { level: 3, cooldown: 250, amount: 6, components: { [RESOURCE_TRANSISTOR]: 2, [RESOURCE_COMPOSITE]: 50, [RESOURCE_WIRE]: 117, [RESOURCE_PURIFIER]: 25, [RESOURCE_ENERGY]: 16 } },

    // Level 4
    [RESOURCE_CIRCUIT]: { level: 4, cooldown: 800, amount: 1, components: { [RESOURCE_MICROCHIP]: 1, [RESOURCE_TRANSISTOR]: 5, [RESOURCE_SWITCH]: 4, [RESOURCE_OXIDANT]: 115, [RESOURCE_ENERGY]: 32 } },
    [RESOURCE_DEVICE]: { level: 4, cooldown: 600, amount: 1, components: { [RESOURCE_CIRCUIT]: 1, [RESOURCE_MICROCHIP]: 3, [RESOURCE_CRYSTAL]: 110, [RESOURCE_GHODIUM_MELT]: 150, [RESOURCE_ENERGY]: 64 } },

    // Level 5 - Bio
    [RESOURCE_CELL]: { level: 5, cooldown: 8, amount: 20, components: { [RESOURCE_LEMERGIUM_BAR]: 20, [RESOURCE_BIOMASS]: 100, [RESOURCE_ENERGY]: 40 } },
    [RESOURCE_PHLEGM]: { level: 5, cooldown: 35, amount: 2, components: { [RESOURCE_CELL]: 20, [RESOURCE_OXIDANT]: 36, [RESOURCE_LEMERGIUM_BAR]: 16, [RESOURCE_ENERGY]: 8 } },
    [RESOURCE_TISSUE]: { level: 5, cooldown: 164, amount: 2, components: { [RESOURCE_PHLEGM]: 10, [RESOURCE_CELL]: 10, [RESOURCE_REDUCTANT]: 110, [RESOURCE_ENERGY]: 16 } },
    [RESOURCE_MUSCLE]: { level: 5, cooldown: 250, amount: 1, components: { [RESOURCE_TISSUE]: 3, [RESOURCE_PHLEGM]: 3, [RESOURCE_ZYNTHIUM_BAR]: 50, [RESOURCE_REDUCTANT]: 50, [RESOURCE_ENERGY]: 16 } },
    [RESOURCE_ORGANOID]: { level: 5, cooldown: 800, amount: 1, components: { [RESOURCE_MUSCLE]: 1, [RESOURCE_TISSUE]: 5, [RESOURCE_PURIFIER]: 208, [RESOURCE_OXIDANT]: 256, [RESOURCE_ENERGY]: 32 } },
    [RESOURCE_ORGANISM]: { level: 5, cooldown: 600, amount: 1, components: { [RESOURCE_ORGANOID]: 1, [RESOURCE_LIQUID]: 150, [RESOURCE_TISSUE]: 6, [RESOURCE_CELL]: 310, [RESOURCE_ENERGY]: 64 } },

    // Bar compression (level 0)
    [RESOURCE_UTRIUM_BAR]: { level: 0, cooldown: 12, amount: 100, components: { [RESOURCE_UTRIUM]: 500, [RESOURCE_ENERGY]: 200 } },
    [RESOURCE_LEMERGIUM_BAR]: { level: 0, cooldown: 12, amount: 100, components: { [RESOURCE_LEMERGIUM]: 500, [RESOURCE_ENERGY]: 200 } },
    [RESOURCE_ZYNTHIUM_BAR]: { level: 0, cooldown: 12, amount: 100, components: { [RESOURCE_ZYNTHIUM]: 500, [RESOURCE_ENERGY]: 200 } },
    [RESOURCE_KEANIUM_BAR]: { level: 0, cooldown: 12, amount: 100, components: { [RESOURCE_KEANIUM]: 500, [RESOURCE_ENERGY]: 200 } },
    [RESOURCE_GHODIUM_MELT]: { level: 0, cooldown: 12, amount: 100, components: { [RESOURCE_GHODIUM]: 500, [RESOURCE_ENERGY]: 200 } },
    [RESOURCE_OXIDANT]: { level: 0, cooldown: 12, amount: 100, components: { [RESOURCE_OXYGEN]: 500, [RESOURCE_ENERGY]: 200 } },
    [RESOURCE_REDUCTANT]: { level: 0, cooldown: 12, amount: 100, components: { [RESOURCE_HYDROGEN]: 500, [RESOURCE_ENERGY]: 200 } },
    [RESOURCE_PURIFIER]: { level: 0, cooldown: 12, amount: 100, components: { [RESOURCE_CATALYST]: 500, [RESOURCE_ENERGY]: 200 } },
};

/** Configuration */
const CONFIG = {
    /** Minimum RCL for factory */
    MIN_RCL: 7,
    /** Target bars to keep in storage */
    BAR_TARGET: 5000,
    /** Minimum energy for production */
    MIN_ENERGY: 10000
};

/** Factory state */
interface FactoryState {
    roomName: string;
    factoryId: Id<StructureFactory> | null;
    level: number;
    cooldown: number;
    producing: CommodityConstant | null;
    queue: CommodityConstant[];
}

class FactoryManager {
    /** Factory states per room */
    private factories: Map<string, FactoryState> = new Map();

    /**
     * Main factory management function
     */
    manage(): void {
        // Update factory states
        this.updateFactoryStates();

        // Process each factory
        for (const [roomName, state] of this.factories) {
            this.processFactory(roomName, state);
        }

        // Coordinate multi-room production
        if (Game.time % 100 === 0) {
            this.coordinateProduction();
        }
    }

    /**
     * Update factory states for all rooms
     */
    private updateFactoryStates(): void {
        for (const room of Object.values(Game.rooms)) {
            if (!room.controller?.my) continue;
            if (room.controller.level < CONFIG.MIN_RCL) continue;

            const factory = room.find(FIND_MY_STRUCTURES, {
                filter: s => s.structureType === STRUCTURE_FACTORY
            })[0] as StructureFactory | undefined;

            if (!factory) {
                this.factories.delete(room.name);
                continue;
            }

            let state = this.factories.get(room.name);
            if (!state) {
                state = {
                    roomName: room.name,
                    factoryId: factory.id,
                    level: factory.level ?? 0,
                    cooldown: factory.cooldown,
                    producing: null,
                    queue: []
                };
                this.factories.set(room.name, state);
            } else {
                state.factoryId = factory.id;
                state.level = factory.level ?? 0;
                state.cooldown = factory.cooldown;
            }
        }
    }

    /**
     * Process a single factory
     */
    private processFactory(roomName: string, state: FactoryState): void {
        const factory = state.factoryId ? Game.getObjectById(state.factoryId) : null;
        if (!factory) return;

        // Skip if on cooldown
        if (factory.cooldown > 0) return;

        const room = Game.rooms[roomName];
        if (!room) return;

        // Check energy
        const storage = room.storage;
        if (!storage || storage.store.getUsedCapacity(RESOURCE_ENERGY) < CONFIG.MIN_ENERGY) return;

        // Get production target
        const target = this.getProductionTarget(room, state);
        if (!target) return;

        // Check if we have components
        if (!this.hasComponents(factory, target)) {
            // Request components via terminal
            this.requestComponents(room, target);
            return;
        }

        // Produce
        const result = factory.produce(target);
        if (result === OK) {
            state.producing = target;
            log.debug("FactoryManager", `${roomName} producing ${target}`);
        }
    }

    /**
     * Get production target for a factory
     */
    private getProductionTarget(room: Room, state: FactoryState): CommodityConstant | null {
        // Check queue first
        if (state.queue.length > 0) {
            return state.queue[0];
        }

        const storage = room.storage;
        const terminal = room.terminal;
        if (!storage) return null;

        // Priority 1: Compress excess minerals into bars
        const compressionTarget = this.getCompressionTarget(room, storage, terminal);
        if (compressionTarget) return compressionTarget;

        // Priority 2: Energy compression if excess
        if (storage.store.getUsedCapacity(RESOURCE_ENERGY) > 500000) {
            return RESOURCE_BATTERY;
        }

        // Priority 3: Factory level-appropriate commodities
        const factoryLevel = state.level;
        const products = FACTORY_PRODUCTS[factoryLevel] ?? FACTORY_PRODUCTS[0];

        for (const product of products) {
            const recipe = COMMODITY_RECIPES[product];
            if (!recipe) continue;
            if (recipe.level > factoryLevel) continue;

            // Check if we have enough of this product already
            const current = (storage.store.getUsedCapacity(product) ?? 0) +
                           (terminal?.store.getUsedCapacity(product) ?? 0);
            if (current > 1000) continue;

            return product;
        }

        return null;
    }

    /**
     * Get compression target (mineral → bar)
     */
    private getCompressionTarget(
        room: Room,
        storage: StructureStorage,
        terminal: StructureTerminal | undefined
    ): CommodityConstant | null {
        const mineralCompressions: [ResourceConstant, CommodityConstant][] = [
            [RESOURCE_UTRIUM, RESOURCE_UTRIUM_BAR],
            [RESOURCE_LEMERGIUM, RESOURCE_LEMERGIUM_BAR],
            [RESOURCE_ZYNTHIUM, RESOURCE_ZYNTHIUM_BAR],
            [RESOURCE_KEANIUM, RESOURCE_KEANIUM_BAR],
            [RESOURCE_GHODIUM, RESOURCE_GHODIUM_MELT],
            [RESOURCE_OXYGEN, RESOURCE_OXIDANT],
            [RESOURCE_HYDROGEN, RESOURCE_REDUCTANT],
            [RESOURCE_CATALYST, RESOURCE_PURIFIER]
        ];

        for (const [mineral, bar] of mineralCompressions) {
            const mineralAmount = (storage.store.getUsedCapacity(mineral) ?? 0) +
                                 (terminal?.store.getUsedCapacity(mineral) ?? 0);
            const barAmount = (storage.store.getUsedCapacity(bar) ?? 0) +
                             (terminal?.store.getUsedCapacity(bar) ?? 0);

            // Compress if we have excess minerals and not enough bars
            if (mineralAmount > 5000 && barAmount < CONFIG.BAR_TARGET) {
                return bar;
            }
        }

        return null;
    }

    /**
     * Check if factory has required components
     */
    private hasComponents(factory: StructureFactory, product: CommodityConstant): boolean {
        const recipe = COMMODITY_RECIPES[product];
        if (!recipe) return false;

        for (const [resource, amount] of Object.entries(recipe.components)) {
            const available = factory.store.getUsedCapacity(resource as ResourceConstant) ?? 0;
            if (available < (amount as number)) {
                return false;
            }
        }

        return true;
    }

    /**
     * Request components for production via terminal
     */
    private requestComponents(room: Room, product: CommodityConstant): void {
        const recipe = COMMODITY_RECIPES[product];
        if (!recipe) return;

        const factory = room.find(FIND_MY_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_FACTORY
        })[0] as StructureFactory | undefined;

        if (!factory) return;

        const storage = room.storage;
        const terminal = room.terminal;

        // Request missing components
        for (const [resource, needed] of Object.entries(recipe.components)) {
            const res = resource as ResourceConstant;
            const factoryHas = factory.store.getUsedCapacity(res) ?? 0;

            if (factoryHas >= (needed as number)) continue;

            const deficit = (needed as number) - factoryHas;

            // Check storage first
            const storageHas = storage?.store.getUsedCapacity(res) ?? 0;
            if (storageHas >= deficit) {
                // Haulers will move it via FILL tasks
                continue;
            }

            // Check terminal
            const terminalHas = terminal?.store.getUsedCapacity(res) ?? 0;
            if (terminalHas >= deficit) continue;

            // Need to import via market/other rooms
            log.debug("FactoryManager", `${room.name} needs ${deficit} ${res} for ${product}`);
        }
    }

    /**
     * Coordinate production across multiple rooms
     */
    private coordinateProduction(): void {
        // Group factories by level
        const byLevel: Map<number, FactoryState[]> = new Map();

        for (const state of this.factories.values()) {
            const level = state.level;
            if (!byLevel.has(level)) {
                byLevel.set(level, []);
            }
            byLevel.get(level)!.push(state);
        }

        // Set up production chains
        // L0 factories make bars and basic commodities
        // L1+ factories make advanced commodities

        // Transfer components between rooms via terminals
        for (const [level, states] of byLevel) {
            if (level === 0) continue;

            // Higher level factories need components from lower level factories
            const neededProducts = FACTORY_PRODUCTS[level - 1] ?? [];

            for (const state of states) {
                const room = Game.rooms[state.roomName];
                const terminal = room?.terminal;
                if (!terminal) continue;

                for (const product of neededProducts) {
                    const has = terminal.store.getUsedCapacity(product) ?? 0;
                    if (has < 100) {
                        // Find a room with this product
                        this.requestFromOtherRoom(state.roomName, product, 500);
                    }
                }
            }
        }
    }

    /**
     * Request resource from another room
     */
    private requestFromOtherRoom(targetRoom: string, resource: ResourceConstant, amount: number): void {
        // Find a room with this resource
        for (const [roomName, state] of this.factories) {
            if (roomName === targetRoom) continue;

            const room = Game.rooms[roomName];
            const terminal = room?.terminal;
            if (!terminal) continue;
            if (terminal.cooldown > 0) continue;

            const has = terminal.store.getUsedCapacity(resource) ?? 0;
            if (has < amount * 2) continue;

            // Send resource
            const result = terminal.send(resource, amount, targetRoom);
            if (result === OK) {
                log.info("FactoryManager", `Sent ${amount} ${resource} from ${roomName} to ${targetRoom}`);
            }
            return;
        }
    }

    /**
     * Queue production for a room
     */
    queueProduction(roomName: string, product: CommodityConstant): boolean {
        const state = this.factories.get(roomName);
        if (!state) return false;

        const recipe = COMMODITY_RECIPES[product];
        if (!recipe) return false;
        if (recipe.level > state.level) return false;

        state.queue.push(product);
        return true;
    }

    /**
     * Get factory stats for dashboard
     */
    getStats(): {
        factoryCount: number;
        byLevel: Record<number, number>;
        producing: string[];
    } {
        const byLevel: Record<number, number> = {};
        const producing: string[] = [];

        for (const state of this.factories.values()) {
            byLevel[state.level] = (byLevel[state.level] ?? 0) + 1;
            if (state.producing) {
                producing.push(`${state.roomName}: ${state.producing}`);
            }
        }

        return {
            factoryCount: this.factories.size,
            byLevel,
            producing
        };
    }

    /**
     * Get recipe for a commodity
     */
    getRecipe(product: CommodityConstant): typeof COMMODITY_RECIPES[CommodityConstant] | null {
        return COMMODITY_RECIPES[product] ?? null;
    }
}

// Singleton instance
const factoryManagerInstance = new FactoryManager();

export const factoryManagerModule = () => {
    // Only run every 5 ticks
    if (Game.time % 5 !== 0) return;
    factoryManagerInstance.manage();
};

export const factoryManager = factoryManagerInstance;
