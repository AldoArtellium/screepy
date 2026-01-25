/**
 * MarketManager - Market trading and terminal management
 *
 * Features:
 * - Terminal resource tracking
 * - Price monitoring and history
 * - Automated selling of excess resources
 * - Automated buying of needed resources
 * - Transaction cost optimization
 * - Credit balance management
 */

import { log } from "../utils/logger";

/** Resource thresholds for trading decisions */
const RESOURCE_THRESHOLDS = {
    /** Energy threshold above which to sell */
    ENERGY_SELL: 500000,
    /** Energy threshold below which to buy */
    ENERGY_BUY: 50000,
    /** Minimum energy to keep for operations */
    ENERGY_RESERVE: 100000,
    /** Minerals to keep in storage before selling */
    MINERAL_RESERVE: 10000,
    /** Minimum amount for a sell order */
    MIN_SELL_AMOUNT: 1000,
    /** Minimum credits to maintain */
    MIN_CREDITS: 10000
};

/** Price history entry */
interface PriceHistory {
    avgBuy: number;
    avgSell: number;
    volume: number;
    lastUpdated: number;
}

/** Terminal state tracking */
interface TerminalState {
    roomName: string;
    cooldown: number;
    energy: number;
    resources: Partial<Record<ResourceConstant, number>>;
    lastTransaction: number;
}

/** Trade order */
interface TradeOrder {
    id: string;
    type: "buy" | "sell";
    resourceType: ResourceConstant;
    amount: number;
    price: number;
    roomName: string;
    createdAt: number;
}

class MarketManager {
    /** Cached price history */
    private priceCache: Map<ResourceConstant, PriceHistory> = new Map();

    /** Active trade orders */
    private activeOrders: Map<string, TradeOrder> = new Map();

    /**
     * Main market management function
     */
    manage(): void {
        // Only manage markets if we have terminals
        const terminalsRooms = Object.values(Game.rooms).filter(
            r => r.controller?.my && r.terminal
        );

        if (terminalsRooms.length === 0) return;

        // Update price cache periodically
        if (Game.time % 100 === 0) {
            this.updatePriceCache();
        }

        // Process each room with a terminal
        for (const room of terminalsRooms) {
            this.processRoom(room);
        }

        // Clean up completed orders
        if (Game.time % 50 === 0) {
            this.cleanupOrders();
        }
    }

    /**
     * Process market operations for a room
     */
    private processRoom(room: Room): void {
        const terminal = room.terminal;
        if (!terminal) return;

        // Skip if terminal is on cooldown
        if (terminal.cooldown > 0) return;

        const storage = room.storage;
        const terminalEnergy = terminal.store.getUsedCapacity(RESOURCE_ENERGY);

        // Check selling opportunities
        this.checkSellOpportunities(room, terminal, storage);

        // Check buying opportunities
        this.checkBuyOpportunities(room, terminal);

        // Balance energy between terminal and storage
        this.balanceEnergy(room, terminal, storage);
    }

    /**
     * Check for resources to sell
     */
    private checkSellOpportunities(
        room: Room,
        terminal: StructureTerminal,
        storage: StructureStorage | undefined
    ): void {
        // Calculate total resources available
        const totalEnergy = (storage?.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0) +
                           terminal.store.getUsedCapacity(RESOURCE_ENERGY);

        // Sell energy if we have excess
        if (totalEnergy > RESOURCE_THRESHOLDS.ENERGY_SELL) {
            const sellAmount = Math.min(
                terminal.store.getUsedCapacity(RESOURCE_ENERGY) - RESOURCE_THRESHOLDS.ENERGY_RESERVE / 4,
                10000
            );

            if (sellAmount >= RESOURCE_THRESHOLDS.MIN_SELL_AMOUNT) {
                this.sellResource(terminal, RESOURCE_ENERGY, sellAmount);
            }
        }

        // Sell minerals we have excess of
        const mineralType = room.find(FIND_MINERALS)[0]?.mineralType;
        if (mineralType) {
            const totalMineral = (storage?.store.getUsedCapacity(mineralType) ?? 0) +
                                terminal.store.getUsedCapacity(mineralType);

            if (totalMineral > RESOURCE_THRESHOLDS.MINERAL_RESERVE) {
                const sellAmount = Math.min(
                    terminal.store.getUsedCapacity(mineralType),
                    totalMineral - RESOURCE_THRESHOLDS.MINERAL_RESERVE
                );

                if (sellAmount >= RESOURCE_THRESHOLDS.MIN_SELL_AMOUNT) {
                    this.sellResource(terminal, mineralType, sellAmount);
                }
            }
        }
    }

    /**
     * Check for resources to buy
     */
    private checkBuyOpportunities(room: Room, terminal: StructureTerminal): void {
        // Only buy if we have enough credits
        if (Game.market.credits < RESOURCE_THRESHOLDS.MIN_CREDITS * 2) return;

        const totalEnergy = (room.storage?.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0) +
                           terminal.store.getUsedCapacity(RESOURCE_ENERGY);

        // Buy energy if running low
        if (totalEnergy < RESOURCE_THRESHOLDS.ENERGY_BUY) {
            const buyAmount = Math.min(
                RESOURCE_THRESHOLDS.ENERGY_RESERVE - totalEnergy,
                terminal.store.getFreeCapacity(),
                50000
            );

            if (buyAmount >= RESOURCE_THRESHOLDS.MIN_SELL_AMOUNT) {
                this.buyResource(terminal, RESOURCE_ENERGY, buyAmount);
            }
        }
    }

    /**
     * Sell a resource on the market
     */
    private sellResource(
        terminal: StructureTerminal,
        resourceType: ResourceConstant,
        amount: number
    ): boolean {
        // Find the best buy order to fulfill
        const orders = Game.market.getAllOrders({
            type: ORDER_BUY,
            resourceType
        });

        if (orders.length === 0) {
            log.debug("MarketManager", `No buy orders for ${resourceType}`);
            return false;
        }

        // Sort by price (highest first) and filter out bad deals
        const avgPrice = this.getAveragePrice(resourceType, "sell");
        const validOrders = orders
            .filter(o => o.price >= avgPrice * 0.8 && o.amount > 0 && o.roomName)
            .sort((a, b) => b.price - a.price);

        if (validOrders.length === 0) {
            log.debug("MarketManager", `No good buy orders for ${resourceType}`);
            return false;
        }

        const bestOrder = validOrders[0];

        // Calculate transaction cost
        const sellAmount = Math.min(amount, bestOrder.amount);
        const energyCost = Game.market.calcTransactionCost(
            sellAmount,
            terminal.room.name,
            bestOrder.roomName!
        );

        // Check if we have enough energy for transaction
        if (terminal.store.getUsedCapacity(RESOURCE_ENERGY) < energyCost + 100) {
            log.debug("MarketManager", `Insufficient energy for ${resourceType} sale`);
            return false;
        }

        // Execute the deal
        const result = Game.market.deal(bestOrder.id, sellAmount, terminal.room.name);

        if (result === OK) {
            log.info("MarketManager",
                `Sold ${sellAmount} ${resourceType} @ ${bestOrder.price} credits/unit = ${(sellAmount * bestOrder.price).toFixed(0)} credits`
            );
            return true;
        } else {
            log.warn("MarketManager", `Failed to sell ${resourceType}: ${result}`);
            return false;
        }
    }

    /**
     * Buy a resource from the market
     */
    private buyResource(
        terminal: StructureTerminal,
        resourceType: ResourceConstant,
        amount: number
    ): boolean {
        // Find the best sell order
        const orders = Game.market.getAllOrders({
            type: ORDER_SELL,
            resourceType
        });

        if (orders.length === 0) {
            log.debug("MarketManager", `No sell orders for ${resourceType}`);
            return false;
        }

        // Sort by price (lowest first) and filter out bad deals
        const avgPrice = this.getAveragePrice(resourceType, "buy");
        const validOrders = orders
            .filter(o => o.price <= avgPrice * 1.2 && o.amount > 0 && o.roomName)
            .sort((a, b) => a.price - b.price);

        if (validOrders.length === 0) {
            log.debug("MarketManager", `No good sell orders for ${resourceType}`);
            return false;
        }

        const bestOrder = validOrders[0];

        // Calculate transaction cost
        const buyAmount = Math.min(amount, bestOrder.amount);
        const energyCost = Game.market.calcTransactionCost(
            buyAmount,
            terminal.room.name,
            bestOrder.roomName!
        );

        // Check if we can afford the purchase
        const totalCost = buyAmount * bestOrder.price;
        if (Game.market.credits < totalCost) {
            log.debug("MarketManager", `Insufficient credits for ${resourceType}`);
            return false;
        }

        if (terminal.store.getUsedCapacity(RESOURCE_ENERGY) < energyCost + 100) {
            log.debug("MarketManager", `Insufficient energy for ${resourceType} purchase`);
            return false;
        }

        // Execute the deal
        const result = Game.market.deal(bestOrder.id, buyAmount, terminal.room.name);

        if (result === OK) {
            log.info("MarketManager",
                `Bought ${buyAmount} ${resourceType} @ ${bestOrder.price} credits/unit = ${totalCost.toFixed(0)} credits`
            );
            return true;
        } else {
            log.warn("MarketManager", `Failed to buy ${resourceType}: ${result}`);
            return false;
        }
    }

    /**
     * Balance energy between terminal and storage
     */
    private balanceEnergy(
        room: Room,
        terminal: StructureTerminal,
        storage: StructureStorage | undefined
    ): void {
        if (!storage) return;

        const terminalEnergy = terminal.store.getUsedCapacity(RESOURCE_ENERGY);
        const storageEnergy = storage.store.getUsedCapacity(RESOURCE_ENERGY);

        // Terminal should have 50k-100k energy for transactions
        const targetTerminalEnergy = 75000;
        const tolerance = 25000;

        // Terminal needs more energy
        if (terminalEnergy < targetTerminalEnergy - tolerance &&
            storageEnergy > RESOURCE_THRESHOLDS.ENERGY_RESERVE) {
            // This would be done by haulers via FILL tasks
            // Just log for now
            log.debug("MarketManager", `${room.name} terminal needs energy`);
        }

        // Terminal has excess energy
        if (terminalEnergy > targetTerminalEnergy + tolerance &&
            terminal.store.getFreeCapacity() < 50000) {
            // Haulers will move to storage via normal logistics
            log.debug("MarketManager", `${room.name} terminal has excess energy`);
        }
    }

    /**
     * Update the price cache for all resources
     */
    private updatePriceCache(): void {
        const resources: ResourceConstant[] = [
            RESOURCE_ENERGY,
            RESOURCE_HYDROGEN, RESOURCE_OXYGEN, RESOURCE_UTRIUM,
            RESOURCE_LEMERGIUM, RESOURCE_KEANIUM, RESOURCE_ZYNTHIUM, RESOURCE_CATALYST
        ];

        for (const resource of resources) {
            const history = Game.market.getHistory(resource);

            if (history && history.length > 0) {
                // Use recent history (last 7 days)
                const recent = history.slice(-7);
                const avgBuy = recent.reduce((sum, h) => sum + h.avgPrice, 0) / recent.length;
                const avgSell = avgBuy; // Simplified - sell price similar
                const volume = recent.reduce((sum, h) => sum + h.volume, 0);

                this.priceCache.set(resource, {
                    avgBuy,
                    avgSell,
                    volume,
                    lastUpdated: Game.time
                });
            }
        }
    }

    /**
     * Get average price for a resource
     */
    getAveragePrice(resourceType: ResourceConstant, type: "buy" | "sell"): number {
        const cached = this.priceCache.get(resourceType);

        if (cached && Game.time - cached.lastUpdated < 1000) {
            return type === "buy" ? cached.avgBuy : cached.avgSell;
        }

        // Fallback: calculate from current orders
        const orders = Game.market.getAllOrders({
            type: type === "buy" ? ORDER_SELL : ORDER_BUY,
            resourceType
        });

        if (orders.length === 0) {
            // Return defaults
            if (resourceType === RESOURCE_ENERGY) return 0.01;
            return 1.0;
        }

        const prices = orders.map(o => o.price);
        return prices.reduce((a, b) => a + b, 0) / prices.length;
    }

    /**
     * Clean up completed orders
     */
    private cleanupOrders(): void {
        // Check our own orders and cancel old/empty ones
        const myOrders = Game.market.orders;

        for (const orderId in myOrders) {
            const order = myOrders[orderId];

            // Cancel if empty
            if (order.remainingAmount === 0) {
                Game.market.cancelOrder(orderId);
                log.debug("MarketManager", `Cancelled empty order ${orderId}`);
                continue;
            }

            // Cancel if too old (>7 days)
            if (Game.time - order.created > 7 * 24 * 60 * 60 / 3) {
                Game.market.cancelOrder(orderId);
                log.debug("MarketManager", `Cancelled old order ${orderId}`);
            }
        }
    }

    /**
     * Create a sell order (place on market)
     */
    createSellOrder(
        roomName: string,
        resourceType: ResourceConstant,
        amount: number,
        price?: number
    ): string | null {
        const terminal = Game.rooms[roomName]?.terminal;
        if (!terminal) return null;

        // Calculate price if not provided
        const orderPrice = price ?? this.getAveragePrice(resourceType, "sell") * 0.95;

        const result = Game.market.createOrder({
            type: ORDER_SELL,
            resourceType,
            price: orderPrice,
            totalAmount: amount,
            roomName
        });

        if (result === OK) {
            log.info("MarketManager",
                `Created sell order: ${amount} ${resourceType} @ ${orderPrice}`
            );
            // Return order ID from recent orders
            const orders = Object.values(Game.market.orders)
                .filter(o => o.resourceType === resourceType && o.roomName === roomName);
            return orders[orders.length - 1]?.id ?? null;
        }

        log.warn("MarketManager", `Failed to create sell order: ${result}`);
        return null;
    }

    /**
     * Create a buy order (place on market)
     */
    createBuyOrder(
        roomName: string,
        resourceType: ResourceConstant,
        amount: number,
        price?: number
    ): string | null {
        const terminal = Game.rooms[roomName]?.terminal;
        if (!terminal) return null;

        // Calculate price if not provided
        const orderPrice = price ?? this.getAveragePrice(resourceType, "buy") * 1.05;

        const result = Game.market.createOrder({
            type: ORDER_BUY,
            resourceType,
            price: orderPrice,
            totalAmount: amount,
            roomName
        });

        if (result === OK) {
            log.info("MarketManager",
                `Created buy order: ${amount} ${resourceType} @ ${orderPrice}`
            );
            const orders = Object.values(Game.market.orders)
                .filter(o => o.resourceType === resourceType && o.roomName === roomName);
            return orders[orders.length - 1]?.id ?? null;
        }

        log.warn("MarketManager", `Failed to create buy order: ${result}`);
        return null;
    }

    /**
     * Send resources between rooms
     */
    sendResources(
        fromRoom: string,
        toRoom: string,
        resourceType: ResourceConstant,
        amount: number
    ): boolean {
        const terminal = Game.rooms[fromRoom]?.terminal;
        if (!terminal) return false;

        if (terminal.cooldown > 0) return false;

        const result = terminal.send(resourceType, amount, toRoom);

        if (result === OK) {
            log.info("MarketManager",
                `Sent ${amount} ${resourceType} from ${fromRoom} to ${toRoom}`
            );
            return true;
        }

        log.warn("MarketManager",
            `Failed to send ${resourceType} from ${fromRoom} to ${toRoom}: ${result}`
        );
        return false;
    }

    /**
     * Get market stats for dashboard
     */
    getStats(): {
        credits: number;
        activeOrders: number;
        terminalCount: number;
    } {
        return {
            credits: Game.market.credits,
            activeOrders: Object.keys(Game.market.orders).length,
            terminalCount: Object.values(Game.rooms).filter(r => r.terminal).length
        };
    }
}

// Singleton instance
const marketManagerInstance = new MarketManager();

export const marketManagerModule = () => {
    // Only run every 20 ticks to save CPU
    if (Game.time % 20 !== 0) return;
    marketManagerInstance.manage();
};

export const marketManager = marketManagerInstance;
