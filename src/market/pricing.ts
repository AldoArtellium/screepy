/**
 * Market price rules (pure, offline check: tests/market/run.mjs), used by modules/MarketManager.ts.
 *
 * Sell orders, instant sells and their thresholds follow Hivemind trade.ts. Not in Hivemind:
 * - our sell orders are lowered when a competitor sells cheaper (shard0 2026-10-25: an H order created
 *   at 627.86 stayed above competitors at 620.30 for its whole life, nothing sold and credits stayed
 *   at 21, so no reagent could be bought and the labs waited);
 * - while credits are below the reserve an instant sell only needs the average price (Hivemind:
 *   average + dev / 2), so a credit-less account sells its surplus to the buy orders;
 * - forced buys (stock below 5k) pay at most FORCED_BUY_MAX_RATIO x the average or the best buy order
 *   (Hivemind: any price; L was bought at 725-770).
 */

export interface PriceData {
    total: number;
    average: number;
    stdDev: number;
}

/** Forced buys pay at most this many times the average price or the best buy order */
export const FORCED_BUY_MAX_RATIO = 1.2;
/** A sell order is only repriced when the new price is at least this share lower */
const REPRICE_MIN_STEP = 0.002;

/** Lowest price a sell order or a normal instant sell accepts */
function minSellPrice(history: PriceData): number {
    return history.average + history.stdDev / 2;
}

/** Sell order price: 1% below the cheapest competitor, at least average + dev / 2, at most 1.5 x average + 2 x dev */
export function sellOrderPrice(history: PriceData, cheapestCompetitor: number | undefined): number {
    const greedy = history.average * 1.5 + history.stdDev * 2;
    if (cheapestCompetitor === undefined) return greedy;
    return Math.min(Math.max(minSellPrice(history), cheapestCompetitor * 0.99), greedy);
}

/** New price for our sell order when a competitor sells cheaper (only lower: a raise costs a fee), else null */
export function repricedSellPrice(current: number, history: PriceData, cheapestCompetitor: number | undefined): number | null {
    if (cheapestCompetitor === undefined || cheapestCompetitor >= current) return null;
    const offer = sellOrderPrice(history, cheapestCompetitor);
    return offer > current * (1 - REPRICE_MIN_STEP) ? null : offer;
}

/** Whether selling to a buy order at this price pays: average + dev / 2, the average while credits are low */
export function instantSellPays(price: number, history: PriceData, lowCredits: boolean): boolean {
    return price >= (lowCredits ? history.average : minSellPrice(history));
}

/**
 * Whether to sell to the best buy order now instead of listing: it pays (instantSellPays) and beats the
 * price a sell order would ask, or credits are low. shard0 2026-10-25, H: history average 256.7 (big
 * volumes traded low), so a new order asked at most 465 while buy orders paid 562.
 */
export function prefersInstantSell(bestBuy: number, history: PriceData, cheapestCompetitor: number | undefined, lowCredits: boolean): boolean {
    if (!instantSellPays(bestBuy, history, lowCredits)) return false;
    return lowCredits || bestBuy >= sellOrderPrice(history, cheapestCompetitor);
}

/**
 * Whether a forced buy (stock below 5k) may pay this price: at most FORCED_BUY_MAX_RATIO x the higher of
 * the history average and the best buy order (what buyers pay now: H's average, 256.7, was dragged down
 * by big low-price volumes while buyers paid 562)
 */
export function forcedBuyPays(price: number, history: PriceData | null, bestBuy: number | undefined): boolean {
    if (history === null) return false;
    return price <= Math.max(history.average, bestBuy ?? 0) * FORCED_BUY_MAX_RATIO;
}

export interface BuyOrder {
    id: string;
    price: number;
    remainingAmount: number;
}

function committedCredits(orders: BuyOrder[]): number {
    return orders.reduce((sum, o) => sum + o.price * o.remainingAmount, 0);
}

/**
 * Credits new buys may spend: above the reserve and what our open buy orders will take when filled.
 * Not in Hivemind: shard0 2026-10-29, buy orders created with 3M credits were filled after instant buys
 * had spent the rest (credits 60 -> 5.64, below the 10000 reserve).
 */
export function spendableCredits(credits: number, reserve: number, orders: BuyOrder[]): number {
    return Math.max(0, credits - reserve - committedCredits(orders));
}

/** Our open buy orders to cancel, most valuable first, until the rest fits in the credits above the reserve */
export function buyOrdersToCancel(credits: number, reserve: number, orders: BuyOrder[]): string[] {
    const open = orders.filter(o => o.remainingAmount > 0).sort((a, b) => b.price * b.remainingAmount - a.price * a.remainingAmount);
    let committed = committedCredits(open);
    const cancelled: string[] = [];
    for (const order of open) {
        if (committed <= credits - reserve) break;
        cancelled.push(order.id);
        committed -= order.price * order.remainingAmount;
    }
    return cancelled;
}
