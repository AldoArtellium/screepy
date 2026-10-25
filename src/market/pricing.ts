/**
 * Market price rules (pure, offline check: tests/market/run.mjs), used by modules/MarketManager.ts.
 *
 * Sell orders, instant sells and their thresholds follow Hivemind trade.ts. Not in Hivemind:
 * - our sell orders are lowered when a competitor sells cheaper (shard0 2026-10-25: an H order created
 *   at 627.86 stayed above competitors at 620.30 for its whole life, nothing sold and credits stayed
 *   at 21, so no reagent could be bought and the labs waited);
 * - while credits are below the reserve an instant sell only needs the average price (Hivemind:
 *   average + dev / 2), so a credit-less account sells its surplus to the buy orders;
 * - forced buys (stock below 5k) pay at most FORCED_BUY_MAX_RATIO x the average (Hivemind: any price).
 */

export interface PriceData {
    total: number;
    average: number;
    stdDev: number;
}

/** Forced buys pay at most this many times the average price */
export const FORCED_BUY_MAX_RATIO = 1.5;
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

/** Whether a forced buy (stock below 5k) may pay this price */
export function forcedBuyPays(price: number, history: PriceData | null): boolean {
    return history !== null && price <= history.average * FORCED_BUY_MAX_RATIO;
}
