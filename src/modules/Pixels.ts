/**
 * Pixels - turns a full bucket into pixels, sells them and buys CPU unlocks with the credits.
 * Not in Hivemind's trade process (pixels not ported) nor in the other bots we port from.
 *
 * - Generation (every tick): one pixel when the bucket is full (PIXEL_CPU_COST), the CPU average stays below
 *   `maxCpuRatio` of the limit (default 0.8, a `Memory.pixels` setting), the remote CPU budget is not capping the
 *   remote rooms (`Memory.remoteMining.maxRooms` undefined) and no owned room has a hostile not yet expected dead
 *   (RoomIntel `enemies.expires`). Energy first: while the budget caps the remotes, a full bucket is the budget's
 *   signal to add a remote room, not spare CPU. While the bucket refills, the CPU decisions (throttling, remote
 *   budget, visuals...) see it full (`decisionBucket`, utils/throttle.ts) until it is full again, the CPU average
 *   rises above 80% of the limit or the remote budget gets capped: the bot runs as before, the pixel only costs the
 *   bucket's burst margin. Clearing it once capped keeps the budget from adding a room on a bucket that is not full
 *   (it only raises a cap that exists, so it never sees the refill bucket while it could raise it).
 * - Market (every 100 ticks): use a CPU unlock when full CPU is not unlocked or ends within an hour (never with a
 *   subscription; not twice within 10 minutes, `Game.cpu.unlock` can take 5 minutes to apply); buy one from the
 *   cheapest sell order while the stock is below `unlockStock`, at most 105% of the history average, keeping the
 *   MarketManager's 10 000 credit reserve; sell the pixels above `keepPixels` to the best buy order from 95% of the
 *   history average. Account resources: deals without a room or terminal.
 *
 * Off by default: `Memory.pixels = true` turns everything on, `{ sell: false, keepPixels: 10, ... }` single settings
 * (a setting not listed keeps its default). Counters `pixels:generated`, `pixels:sold`, `cpuUnlock:bought`,
 * `cpuUnlock:used`.
 */

import { log } from "../utils/logger";
import { countStat } from "../utils/stats";

export interface PixelSettings {
    /** Generate a pixel when the bucket is full */
    generate: boolean;
    /** Sell pixels above `keepPixels` */
    sell: boolean;
    /** Buy CPU unlocks while the stock is below `unlockStock` */
    buyUnlocks: boolean;
    /** Use CPU unlocks to keep full CPU */
    unlock: boolean;
    keepPixels: number;
    unlockStock: number;
    /** Highest CPU average (share of the limit) at which a pixel is generated (`Memory.pixels.maxCpuRatio`) */
    maxCpuRatio: number;
}

declare global {
    interface Memory {
        /** Pixel generation and CPU unlocks (default: off) */
        pixels?: boolean | Partial<PixelSettings>;
        /**
         * Pixels module state: last market run (tick), last unlock (ms since epoch), bucket refilling after a pixel
         * (utils/throttle.ts decisionBucket counts it as full)
         */
        pixelState?: { marketTick?: number; unlockAt?: number; refilling?: boolean };
    }
}

const DEFAULTS: PixelSettings = {
    generate: true,
    sell: true,
    buyUnlocks: true,
    unlock: true,
    keepPixels: 0,
    unlockStock: 1,
    maxCpuRatio: 0.8
};

/** Ticks between two market runs */
const MARKET_INTERVAL = 100;
/** Full CPU left (ms) under which an unlock is used */
const UNLOCK_MARGIN = 60 * 60 * 1000;
/** An unlock can take up to 5 minutes to apply (ms) */
const UNLOCK_PENDING = 10 * 60 * 1000;
/** Credits kept for the MarketManager's orders (same reserve) */
const CREDIT_RESERVE = 10000;
/** Full bucket (PIXEL_CPU_COST is not defined on every server) */
const FULL_BUCKET = 10000;
/** CPU average (share of the limit) above which a bucket refilling after a pixel counts as the real bucket again */
const REFILL_MAX_CPU_RATIO = 0.8;
const SELL_MIN_RATIO = 0.95;
const BUY_MAX_RATIO = 1.05;

export function pixelSettings(): PixelSettings | null {
    const value = Memory.pixels;
    if (!value) return null;
    if (value === true) return { ...DEFAULTS };
    return { ...DEFAULTS, ...value };
}

/** The remote CPU budget holds remote rooms back: its full bucket goes to a new remote room, not to pixels */
function remoteBudgetCapped(): boolean {
    return Memory.remoteMining?.maxRooms !== undefined;
}

function ownedRoomWithHostiles(): boolean {
    return _.some(Game.rooms, room => room.controller?.my && (Memory.rooms?.[room.name]?.enemies?.expires ?? 0) > Game.time);
}

function generatePixel(settings: PixelSettings): void {
    if (typeof Game.cpu.generatePixel !== "function" || Game.cpu.bucket < PIXEL_CPU_COST) return;
    const cpuAvg = Memory.stats?.cpuAvg;
    if (cpuAvg === undefined || cpuAvg >= Game.cpu.limit * settings.maxCpuRatio) return;
    if (remoteBudgetCapped() || ownedRoomWithHostiles()) return;
    if (Game.cpu.generatePixel() !== OK) return;
    countStat("pixels:generated");
    (Memory.pixelState ??= {}).refilling = true;
}

/**
 * The bucket counts as full for CPU decisions until it refilled, while the CPU use stays low and the remote budget
 * is uncapped (a capped budget reads the bucket to add rooms: it must see the real one)
 */
function updateRefilling(settings: PixelSettings | null): void {
    const state = Memory.pixelState;
    if (!state?.refilling) return;
    const cpuAvg = Memory.stats?.cpuAvg ?? 0;
    const cpuHigh = cpuAvg >= Game.cpu.limit * REFILL_MAX_CPU_RATIO;
    if (!settings || Game.cpu.bucket >= FULL_BUCKET || cpuHigh || remoteBudgetCapped()) {
        delete state.refilling;
    }
}

/** Volume-weighted average price of the market history, null without history */
function averagePrice(resourceType: MarketResourceConstant): number | null {
    const history = Game.market.getHistory(resourceType) ?? [];
    const volume = _.sum(history, h => h.volume);
    if (volume <= 0) return null;
    return _.sum(history, h => h.avgPrice * h.volume) / volume;
}

function useUnlock(state: NonNullable<Memory["pixelState"]>): void {
    if ((Game.resources[CPU_UNLOCK] ?? 0) <= 0) return;
    // Unlocked without an end time: subscription
    if (Game.cpu.unlocked && Game.cpu.unlockedTime === undefined) return;
    const now = Date.now();
    if (Game.cpu.unlocked && (Game.cpu.unlockedTime ?? 0) - now > UNLOCK_MARGIN) return;
    if (state.unlockAt !== undefined && now - state.unlockAt < UNLOCK_PENDING) return;
    const result = Game.cpu.unlock();
    log.info("Pixels", `CPU unlock: ${result}`);
    if (result === OK) {
        state.unlockAt = now;
        countStat("cpuUnlock:used");
    }
}

function buyUnlock(settings: PixelSettings): void {
    if ((Game.resources[CPU_UNLOCK] ?? 0) >= settings.unlockStock) return;
    const orders = Game.market.getAllOrders({ type: ORDER_SELL, resourceType: CPU_UNLOCK }).filter(o => o.amount > 0);
    if (orders.length === 0) return;
    const order = _.min(orders, o => o.price);
    const average = averagePrice(CPU_UNLOCK);
    if (average === null || order.price > average * BUY_MAX_RATIO) return;
    if (order.price > Game.market.credits - CREDIT_RESERVE) return;
    const result = Game.market.deal(order.id, 1);
    log.info("Pixels", `buy 1 CPU unlock at ${order.price}: ${result}`);
    if (result === OK) countStat("cpuUnlock:bought");
}

function sellPixels(settings: PixelSettings): void {
    const surplus = (Game.resources[PIXEL] ?? 0) - settings.keepPixels;
    if (surplus <= 0) return;
    const orders = Game.market.getAllOrders({ type: ORDER_BUY, resourceType: PIXEL }).filter(o => o.amount > 0);
    if (orders.length === 0) return;
    const order = _.max(orders, o => o.price);
    const average = averagePrice(PIXEL);
    if (average === null || order.price < average * SELL_MIN_RATIO) return;
    const amount = Math.min(surplus, order.amount);
    const result = Game.market.deal(order.id, amount);
    log.info("Pixels", `sell ${amount} pixels at ${order.price}: ${result}`);
    if (result === OK) countStat("pixels:sold", amount);
}

export const pixelsModule = (): void => {
    const settings = pixelSettings();
    updateRefilling(settings);
    if (!settings) return;
    if (settings.generate) generatePixel(settings);

    const state = (Memory.pixelState ??= {});
    if (state.marketTick !== undefined && Game.time - state.marketTick < MARKET_INTERVAL) return;
    state.marketTick = Game.time;
    if (settings.unlock) useUnlock(state);
    if (settings.buyUnlocks) buyUnlock(settings);
    if (settings.sell) sellPixels(settings);
};
