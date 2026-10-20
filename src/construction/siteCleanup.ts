/**
 * Stale construction site cleanup (The International international/constructionSites.ts): a site still not
 * completed 20000 + 5 x progress ticks after it was first seen is removed. Sites left in remotes given up,
 * failed expansions or lost rooms otherwise hold the room cap (5) and the global one (100) forever.
 */

import { countStat } from "../utils/stats";

declare global {
    interface Memory {
        /** Tick each of our construction sites was first seen, by id */
        siteFirstSeen?: { [id: string]: number };
    }
}

const CHECK_INTERVAL = 100;
const STALE_TICKS = 20000;
const STALE_TICKS_PER_PROGRESS = 5;

/** Heap: elapsed ticks, not Game.time % n (the caller is throttled) */
let lastCheck = 0;

export function cleanStaleSites(): void {
    if (Game.time - lastCheck < CHECK_INTERVAL) return;
    lastCheck = Game.time;
    const firstSeen = (Memory.siteFirstSeen ??= {});
    for (const id in Game.constructionSites) {
        if (firstSeen[id] === undefined) firstSeen[id] = Game.time;
    }
    for (const id in firstSeen) {
        const site = Game.constructionSites[id];
        if (!site) {
            delete firstSeen[id];
            continue;
        }
        if (Game.time - firstSeen[id] <= STALE_TICKS + STALE_TICKS_PER_PROGRESS * site.progress) continue;
        if (site.remove() === OK) {
            delete firstSeen[id];
            countStat("sites:removedStale");
        }
    }
}
