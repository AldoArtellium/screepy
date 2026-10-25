/**
 * MarketManager - sells what the empire has too much of and buys missing base minerals.
 * Ported from Hivemind (MIT), src/process/trade.ts. Rules: docs/hivemind/hivemind-endgame.md §5.
 *
 * Base minerals (H, O, U, L, K, Z, X), per room with a terminal: above 50k instant sell, above 20k a
 * sell order, below 10k a buy order, below 5k instant buy. Compounds are sold above 5k when the market
 * pays more than their reagents. Power above 20k / 10k, ops above 10k / 5k. A terminal with less than
 * 5% free while the storage is 90% full sells its most valuable resource. Prices come from the market
 * history and the order book (average and deviation, outlier days left out), 10 000 credits are kept.
 * A deal waits until the terminal holds the amount and the energy for the transfer (transporters fill
 * it: room.memory.fillTerminal).
 *
 * Commodities and deposit resources (loot) are all sold: instant sell and a sell order (isCommodity).
 * Not ported: energy buying (off by default in Hivemind), pixels.
 * Not in Hivemind: at most 10 deals per tick, terminals on cooldown or already used this tick skipped,
 * credits spent on a run are deducted from what the next buys may spend, an instant buy never spends more
 * than the credits above the reserve.
 */

import { getBestOption } from "../core/options";
import { isFullOn, myRoomsWithTerminal, prepareForTrading, resourceAmount, totalResources } from "../core/resources";
import { forcedBuyPays, instantSellPays, PriceData, prefersInstantSell, repricedSellPrice, sellOrderPrice } from "../market/pricing";
import { log } from "../utils/logger";

/** Lowest buy price (Hivemind minTradeValue) */
const MIN_TRADE_VALUE = 0.001;
/** Credits kept for creating orders */
const CREDIT_RESERVE = 10000;
/** Own orders older than this are cancelled */
const ORDER_MAX_AGE = 100000;
/** Price data and compound worth, heap cache */
const PRICE_CACHE_TICKS = 5000;
/** Game.market.deal limit per tick */
const MAX_DEALS = 10;
/** An own sell order is repriced at most once per this many ticks */
const REPRICE_INTERVAL = 1000;

interface ResourceStates {
    rooms: string[];
    total: { [resourceType: string]: number };
}

/** Compound -> its two reagents (Hivemind utilities.getReactionRecipes) */
const recipes: { [product: string]: ResourceConstant[] } = {};
for (const a in REACTIONS) {
    for (const b in REACTIONS[a]) recipes[REACTIONS[a][b]] = [a as ResourceConstant, b as ResourceConstant];
}

const priceCache: Map<string, { until: number; data: PriceData | null }> = new Map();
const worthCache: Map<string, { until: number; worth: number }> = new Map();

let availableCredits = 0;
let dealsThisTick = 0;
let dealTick = -1;
const usedTerminals: Set<string> = new Set();
/** Own order id -> last tick its price changed (heap) */
const repricedAt: Map<string, number> = new Map();

/** 0 energy, 10 power, else the length of the name (+3 with G): 1 = base minerals (Hivemind getResourceTier) */
function resourceTier(resourceType: ResourceConstant): number {
    if (resourceType === RESOURCE_ENERGY) return 0;
    if (resourceType === RESOURCE_POWER) return 10;
    return resourceType.length + (resourceType.includes("G") ? 3 : 0);
}

/**
 * Volume-weighted average and deviation of the market history (the days with the lowest and highest
 * average and the highest deviation left out, only with more than 3 days) and of the open orders
 */
function priceData(resourceType: ResourceConstant): PriceData | null {
    const cached = priceCache.get(resourceType);
    if (cached && cached.until > Game.time) return cached.data;

    let count = 0;
    let totalValue = 0;
    let totalDev = 0;
    const history = Game.market.getHistory(resourceType) ?? [];
    if (history.length > 3) {
        const minDay = _.min(history, h => h.avgPrice).date;
        const maxDay = _.max(history, h => h.avgPrice).date;
        const devDay = _.max(history, h => h.stddevPrice).date;
        for (const day of history) {
            if (day.resourceType !== resourceType || day.date === minDay || day.date === maxDay || day.date === devDay) continue;
            count += day.volume;
            totalValue += day.volume * day.avgPrice;
            totalDev += day.volume * day.stddevPrice;
        }
    }

    let currentCount = 0;
    let currentValue = 0;
    const orders = Game.market.getAllOrders({ resourceType }).filter(o => o.remainingAmount > 0);
    for (const order of orders) {
        currentCount += order.remainingAmount;
        currentValue += order.remainingAmount * order.price;
    }
    let currentStdDev = 0;
    if (currentCount > 0) {
        const mean = currentValue / currentCount;
        currentStdDev = Math.sqrt(_.sum(orders, o => o.remainingAmount * (o.price - mean) ** 2) / currentCount);
    }

    let data: PriceData | null = null;
    if (count + currentCount > 0) {
        // Hivemind quirk kept: the order book deviation is added unweighted
        data = {
            total: count + currentCount,
            average: (totalValue + currentValue) / (count + currentCount),
            stdDev: (totalDev + currentStdDev) / (count + currentCount)
        };
    }
    priceCache.set(resourceType, { until: Game.time + PRICE_CACHE_TICKS, data });
    return data;
}

/** Market average, or for compounds the worth of their reagents + 0.1% per reaction tick */
function calculateWorth(resourceType: ResourceConstant): number {
    const cached = worthCache.get(resourceType);
    if (cached && cached.until > Game.time) return cached.worth;
    let worth: number;
    const recipe = recipes[resourceType];
    if (!recipe) {
        worth = priceData(resourceType)?.average ?? 0;
    } else {
        worth = _.sum(recipe, r => Math.max(calculateWorth(r), priceData(r)?.average ?? 0));
        worth *= 1 + 0.001 * ((REACTION_TIME as { [r: string]: number })[resourceType] ?? 0);
    }
    worthCache.set(resourceType, { until: Game.time + PRICE_CACHE_TICKS, worth });
    return worth;
}

/** Price of a resource in energy (market averages), 1 without price history (military/roi.ts loot value) */
export function energyPrice(resourceType: ResourceConstant): number {
    if (resourceType === RESOURCE_ENERGY) return 1;
    const price = priceData(resourceType)?.average;
    const energy = priceData(RESOURCE_ENERGY)?.average;
    return price && energy ? price / energy : 1;
}

/** Order size from the traded volume: 10 000, 1000, 100, 10 or 1 */
function maxOrderAmount(resourceType: ResourceConstant): number {
    const history = priceData(resourceType);
    if (!history) return 0;
    for (const amount of [10000, 1000, 100, 10]) if (history.total > amount) return amount;
    return 1;
}

/** Best order of other players to deal with: price x 1000 against 0.3 credit per energy of transfer cost */
function findBestOrder(type: ORDER_BUY | ORDER_SELL, resourceType: ResourceConstant, roomName: string): Order | null {
    const orders = Game.market.getAllOrders({ type, resourceType }).filter(o => o.amount >= 100 && !Game.market.orders[o.id]);
    const score = (o: Order) => {
        const cost = o.roomName ? Game.market.calcTransactionCost(1000, roomName, o.roomName) : 0;
        return type === ORDER_BUY ? 1000 * o.price - 0.3 * cost : -(1000 * o.price + 0.3 * cost);
    };
    return orders.length > 0 ? _.max(orders, score) : null;
}

function roomHighestOn(resourceType: ResourceConstant, rooms: string[]): Room | null {
    const room = _.max(
        rooms.map(name => Game.rooms[name]),
        r => totalResources(r)[resourceType] ?? 0
    );
    return typeof room === "object" ? room : null;
}

/** Room with the least of a resource, among those not full on it */
function roomLowestOn(resourceType: ResourceConstant, rooms: string[]): Room | null {
    const candidates = rooms.map(name => Game.rooms[name]).filter(r => !isFullOn(r, resourceType));
    if (candidates.length === 0) return null;
    return _.min(candidates, r => totalResources(r)[resourceType] ?? 0);
}

function canDeal(terminal: StructureTerminal): boolean {
    if (dealTick !== Game.time) {
        dealTick = Game.time;
        dealsThisTick = 0;
        usedTerminals.clear();
    }
    return dealsThisTick < MAX_DEALS && terminal.cooldown === 0 && !usedTerminals.has(terminal.id);
}

function deal(order: Order, amount: number, room: Room): void {
    const result = Game.market.deal(order.id, amount, room.name);
    dealsThisTick++;
    usedTerminals.add(room.terminal!.id);
    log.info("Market", `${room.name}: deal ${order.type === ORDER_BUY ? "sell" : "buy"} ${amount} ${order.resourceType} at ${order.price}: ${result}`);
    if (result === OK && order.type === ORDER_SELL) availableCredits -= amount * order.price;
}

/** Credits below the reserve: instant sells accept the average price (market/pricing.ts) */
function lowCredits(): boolean {
    return Game.market.credits < CREDIT_RESERVE;
}

/**
 * Sells to the best buy order if it pays at least average + deviation / 2 (the average while credits are
 * low). Waits until the terminal holds the amount and the transfer energy.
 */
function instaSell(resourceType: ResourceConstant, rooms: string[]): void {
    const room = roomHighestOn(resourceType, rooms);
    if (!room?.terminal) return;
    const order = findBestOrder(ORDER_BUY, resourceType, room.name);
    const history = priceData(resourceType);
    if (!order || !history || !instantSellPays(order.price, history, lowCredits())) return;
    const amount = Math.min(maxOrderAmount(resourceType), order.amount, resourceAmount(room, resourceType));
    if (amount <= 0) return;
    const terminal = room.terminal;
    const cost = order.roomName ? Game.market.calcTransactionCost(amount, room.name, order.roomName) : 0;
    if (amount > terminal.store[resourceType]) {
        if (!room.memory.fillTerminal) prepareForTrading(room, resourceType, amount);
        return;
    }
    if (cost > terminal.store.energy) {
        if (!room.memory.fillTerminal) prepareForTrading(room, RESOURCE_ENERGY, cost);
        return;
    }
    if (canDeal(terminal)) deal(order, amount, room);
}

/**
 * Buys from the best sell order if it costs at most average - min(dev / 5, 10%); `force` pays up to
 * FORCED_BUY_MAX_RATIO x the average or the best buy order (Hivemind: any price)
 */
function instaBuy(resourceType: ResourceConstant, rooms: string[], force: boolean): void {
    const room = roomLowestOn(resourceType, rooms);
    if (!room?.terminal) return;
    const order = findBestOrder(ORDER_SELL, resourceType, room.name);
    const history = priceData(resourceType);
    if (!order || !history) return;
    if (force && !forcedBuyPays(order.price, history, findBestOrder(ORDER_BUY, resourceType, room.name)?.price)) {
        log.info("Market", `${room.name}: forced buy of ${resourceType} skipped, ${order.price} above the price cap`);
        return;
    }
    if (!force && order.price > history.average - Math.min(history.stdDev / 5, history.average * 0.1)) return;
    let amount = Math.min(force ? 10000 : maxOrderAmount(resourceType), order.amount);
    const terminal = room.terminal;
    let cost = order.roomName ? Game.market.calcTransactionCost(amount, room.name, order.roomName) : 0;
    if (cost > terminal.store.energy) {
        if (!room.memory.fillTerminal) prepareForTrading(room, RESOURCE_ENERGY, cost);
        if (!force) return;
        amount = Math.floor((amount * terminal.store.energy) / cost);
        cost = order.roomName ? Game.market.calcTransactionCost(amount, room.name, order.roomName) : 0;
    }
    if (amount <= 0 || amount * order.price > availableCredits) return;
    if (canDeal(terminal)) deal(order, amount, room);
}

function ownOrders(type: ORDER_BUY | ORDER_SELL, resourceType: ResourceConstant): Order[] {
    return _.filter(Game.market.orders, o => o.type === type && o.resourceType === resourceType);
}

/** Buy order a bit above the best competitor, at most average - min(dev / 2, 20%) */
function tryBuy(resourceType: ResourceConstant, rooms: string[]): void {
    if (ownOrders(ORDER_BUY, resourceType).length > 0) return;
    const room = roomLowestOn(resourceType, rooms);
    const history = priceData(resourceType);
    if (!room || !history) return;
    const maxPrice = history.average - Math.min(history.stdDev / 2, history.average * 0.2);
    const competitor = Game.market.getAllOrders({ type: ORDER_BUY, resourceType }).filter(o => o.amount >= 100);
    let offer = history.average - Math.min(history.stdDev, history.average * 0.8);
    if (competitor.length > 0) offer = Math.min(maxPrice, _.max(competitor, o => o.price).price * 1.01);
    if (offer > maxPrice) return;
    offer = Math.max(offer, MIN_TRADE_VALUE);
    const amount = maxOrderAmount(resourceType);
    if (amount <= 0 || availableCredits < amount * offer) return;
    const result = Game.market.createOrder({ type: ORDER_BUY, resourceType, price: offer, totalAmount: amount, roomName: room.name });
    if (result === OK) availableCredits -= amount * offer;
    log.info("Market", `${room.name}: buy order ${amount} ${resourceType} at ${offer.toFixed(3)}: ${result}`);
}

/** Lowers our sell orders a competitor undercuts (market/pricing.ts), each at most once per REPRICE_INTERVAL */
function repriceSellOrders(orders: Order[], history: PriceData, cheapestCompetitor: number | undefined): void {
    for (const order of orders) {
        if (Game.time - (repricedAt.get(order.id) ?? order.created) < REPRICE_INTERVAL) continue;
        const price = repricedSellPrice(order.price, history, cheapestCompetitor);
        if (price === null) continue;
        const result = Game.market.changeOrderPrice(order.id, price);
        repricedAt.set(order.id, Game.time);
        log.info("Market", `${order.roomName}: sell order ${order.resourceType} ${order.price} -> ${price.toFixed(3)}: ${result}`);
    }
}

/**
 * Sell order a bit below the best competitor, at least average + dev / 2, at most 1.5 x average + 2 x dev.
 * Sells to the best buy order instead when it pays as much, or while credits are low; lowers our order
 * when a competitor undercuts it (not in Hivemind, see market/pricing.ts).
 */
function trySell(resourceType: ResourceConstant, rooms: string[]): void {
    const room = roomHighestOn(resourceType, rooms);
    const history = priceData(resourceType);
    if (!room || !history) return;
    const competitors = Game.market.getAllOrders({ type: ORDER_SELL, resourceType }).filter(o => o.amount >= 100 && !Game.market.orders[o.id]);
    const cheapest = competitors.length > 0 ? _.min(competitors, o => o.price).price : undefined;
    const bestBuy = findBestOrder(ORDER_BUY, resourceType, room.name);
    if (bestBuy && prefersInstantSell(bestBuy.price, history, cheapest, lowCredits())) {
        instaSell(resourceType, rooms);
        return;
    }
    const own = ownOrders(ORDER_SELL, resourceType);
    if (own.length > 0) {
        repriceSellOrders(own, history, cheapest);
        return;
    }
    const offer = sellOrderPrice(history, cheapest);
    const amount = maxOrderAmount(resourceType);
    if (amount <= 0) return;
    // Listing fee: 5% of the order value
    if (Game.market.credits < amount * offer * 0.05) {
        instaSell(resourceType, rooms);
        return;
    }
    const result = Game.market.createOrder({ type: ORDER_SELL, resourceType, price: offer, totalAmount: amount, roomName: room.name });
    log.info("Market", `${room.name}: sell order ${amount} ${resourceType} at ${offer.toFixed(3)}: ${result}`);
}

/** Base minerals: 50k / 20k / 10k / 5k per room with a terminal */
function manageBaseMineral(resourceType: ResourceConstant, states: ResourceStates): void {
    const n = states.rooms.length;
    const total = states.total[resourceType] ?? 0;
    if (total > (n * STORAGE_CAPACITY) / 20) instaSell(resourceType, states.rooms);
    if (total > (n * STORAGE_CAPACITY) / 50) trySell(resourceType, states.rooms);
    if (total < n * Math.min(STORAGE_CAPACITY / 100, 20000) && availableCredits > 0) tryBuy(resourceType, states.rooms);
    if (total < n * Math.min(STORAGE_CAPACITY / 200, 10000) && availableCredits > 0) instaBuy(resourceType, states.rooms, true);
}

/** Compounds above 5k per room, sold when the market pays more than the reagents */
function manageCompound(resourceType: ResourceConstant, states: ResourceStates): void {
    // Checked before the worth (same result, no price lookup for compounds we don't have)
    if ((states.total[resourceType] ?? 0) <= states.rooms.length * Math.min(STORAGE_CAPACITY / 200, 10000)) return;
    const worth = calculateWorth(resourceType);
    const history = priceData(resourceType);
    if (!worth || !history || history.average <= worth) return;
    instaSell(resourceType, states.rooms);
    trySell(resourceType, states.rooms);
}

/** Power above 20k (instant) / 10k (order) per room, ops above 10k / 5k */
function manageSurplus(resourceType: ResourceConstant, states: ResourceStates, instant: number, order: number): void {
    const total = states.total[resourceType] ?? 0;
    if (total > states.rooms.length * instant) instaSell(resourceType, states.rooms);
    if (total > states.rooms.length * order) trySell(resourceType, states.rooms);
}

/** Storage 90% full and terminal 95% full: sell the terminal resource whose best offer beats its worth the most */
function manageOverflowingTerminals(): void {
    for (const room of myRoomsWithTerminal()) {
        const terminal = room.terminal!;
        if (room.storage && room.storage.store.getFreeCapacity() > room.storage.store.getCapacity() * 0.1) continue;
        if (terminal.store.getFreeCapacity() >= terminal.store.getCapacity() * 0.05) continue;
        const candidates: { resourceType: ResourceConstant; priority: number; weight: number }[] = [];
        for (const key in terminal.store) {
            const resourceType = key as ResourceConstant;
            if (resourceType === RESOURCE_ENERGY) continue;
            const order = findBestOrder(ORDER_BUY, resourceType, room.name);
            const worth = calculateWorth(resourceType);
            if (order && worth > 0) candidates.push({ resourceType, priority: 0, weight: order.price / worth });
        }
        const best = getBestOption(candidates);
        if (best) instaSell(best.resourceType, [room.name]);
    }
}

/**
 * Factory products and deposit resources (bars, battery, wire, silicon...): nothing uses them without
 * a factory, so all of them are sold (they come from loot, military/loot.ts). Not in Hivemind.
 */
function isCommodity(resourceType: ResourceConstant): boolean {
    if (resourceType === RESOURCE_ENERGY || resourceType === RESOURCE_GHODIUM || resourceTier(resourceType) === 1) return false;
    const products = Object.values(COMMODITIES) as { components: { [r: string]: number } }[];
    return resourceType in COMMODITIES || products.some(c => resourceType in c.components);
}

/** Own orders older than 100 000 ticks or done */
function removeOldOrders(): void {
    for (const id of repricedAt.keys()) if (!Game.market.orders[id]) repricedAt.delete(id);
    for (const id in Game.market.orders) {
        const order = Game.market.orders[id];
        if (Game.time - order.created > ORDER_MAX_AGE || order.remainingAmount === 0) Game.market.cancelOrder(id);
    }
}

export const marketManagerModule = (): void => {
    const rooms = myRoomsWithTerminal();
    if (rooms.length === 0) return;
    removeOldOrders();
    availableCredits = Math.max(0, Game.market.credits - CREDIT_RESERVE);

    const states: ResourceStates = { rooms: rooms.map(r => r.name), total: {} };
    for (const room of rooms) {
        const resources = totalResources(room);
        for (const resourceType in resources) states.total[resourceType] = (states.total[resourceType] ?? 0) + resources[resourceType];
    }

    for (const resourceType of RESOURCES_ALL) {
        if (resourceTier(resourceType) === 1) manageBaseMineral(resourceType, states);
        else if (recipes[resourceType]) manageCompound(resourceType, states);
        else if (isCommodity(resourceType)) manageSurplus(resourceType, states, 0, 0);
    }
    manageSurplus(RESOURCE_POWER, states, 20000, 10000);
    manageSurplus(RESOURCE_OPS, states, 10000, 5000);
    manageOverflowingTerminals();
};
