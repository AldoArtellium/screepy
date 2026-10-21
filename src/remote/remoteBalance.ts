/**
 * Measured remote balance (not in Hivemind): a remote source whose energy brought home stays below
 * the spawn cost of its creeps is left out of the selection for a long time.
 *
 * The selection prices a source with a model (remoteIncome.ts sourceNet); the history measures it
 * (utils/history.ts: per source and 1000-tick window, energy harvested, delivered home and the spawn
 * cost of its creeps). shard0 2026-10-21, ~7500 ticks: W29N5:8:31 (home W29N7, 112 tiles) harvested
 * 1927, delivered 1528 and cost 2160 per 1000 ticks (net -631), while sourceNet believed it paid.
 *
 * Rule: once the last BALANCE_WINDOWS windows are all steady measures of a source with the same
 * home (history steadyWindow: selected the whole window, remote harvester and container on 90% of
 * the samples, no raid, no reservation change, no global reset), a net (delivered - cost) below
 * MIN_NET_PER_1000 per 1000 ticks over them excludes the source from that home's selection for
 * EXCLUDE_TICKS +-10% (Memory.remoteExcluded). Afterwards it is selected again and needs as many
 * steady windows before it is judged again. Three windows (3000 ticks, two creep lives) because
 * spawn costs are charged on the spawn tick: one window holds zero, one or two harvesters.
 *
 * Second rule, for sources that never get steady (shard0 2026-10-21: W27N6:43:32, home W27N5, 103
 * tiles, harvested 231, delivered 0 and cost 843 per 1000 ticks over ~12000 ticks, 0 of 3 windows
 * steady: a far source never served long enough to finish its container is never judged by the
 * first rule): when the last UNSTEADY_WINDOWS windows all have the source selected by the same home
 * the whole window (history windowFlags WINDOW_FULL), none of them steady, no threat in any (raids
 * explain unsteadiness), its container site making no progress in any (a source still being set up
 * is left alone), and their cumulative net (delivered - cost) is negative, the source gets the same
 * exclusion, with reason "unsteady". Windows written before the flags existed never count.
 *
 * Caveat: only the remote harvester's cost is exact; haulers', remote builders' (shared out over the
 * home's sources with a remote harvester by travel time) and reservers' (over the room's sources)
 * are estimates.
 */

import { BalanceWindow, remoteBalanceWindows } from "../utils/history";
import { jitter } from "../utils/jitter";
import { log } from "../utils/logger";
import { countStat } from "../utils/stats";

export const BALANCE_WINDOWS = 3;
/** Net energy per 1000 ticks below which a source is excluded (0.1 energy/tick) */
export const MIN_NET_PER_1000 = 100;
export const EXCLUDE_TICKS = 20000;
/** Full, never steady windows the second rule needs */
export const UNSTEADY_WINDOWS = 3;

export interface Exclusion {
    /** Home room the source lost energy for (other homes may still select it) */
    home: string;
    /** Tick the exclusion was decided and the tick it ends */
    since: number;
    until: number;
    /** Measured net energy per 1000 ticks */
    net: number;
    /** Rule that excluded it: steady windows below MIN_NET_PER_1000, or never steady and negative (absent: measured) */
    reason?: "measured" | "unsteady";
}

declare global {
    interface Memory {
        /** Remote sources left out of the selection by their measured balance, by source key */
        remoteExcluded?: { [key: string]: Exclusion };
    }
}

/**
 * Net energy per 1000 ticks of a source over the last BALANCE_WINDOWS windows, when every one of
 * them is a steady measure with the same home; undefined when there is not enough data.
 */
export function measuredNet(windows: BalanceWindow[], key: string): { net: number; home: string } | undefined {
    if (windows.length < BALANCE_WINDOWS) return undefined;
    const last = windows.slice(-BALANCE_WINDOWS);
    const home = last[last.length - 1].sources[key]?.home;
    if (!home) return undefined;
    let net = 0;
    let ticks = 0;
    for (const window of last) {
        const balance = window.sources[key];
        if (!balance || !balance.steady || balance.home !== home) return undefined;
        net += balance.delivered - balance.cost;
        ticks += window.ticks;
    }
    return ticks > 0 ? { net: (net * 1000) / ticks, home } : undefined;
}

/**
 * Net energy per 1000 ticks of a source over the last UNSTEADY_WINDOWS windows, when every one of
 * them has it selected by the same home the whole window, not steady, without threat and without
 * container site progress; undefined otherwise (not enough windows, or windows without flags).
 */
export function unsteadyNet(windows: BalanceWindow[], key: string): { net: number; home: string } | undefined {
    if (windows.length < UNSTEADY_WINDOWS) return undefined;
    const last = windows.slice(-UNSTEADY_WINDOWS);
    const home = last[last.length - 1].sources[key]?.home;
    if (!home) return undefined;
    let net = 0;
    let ticks = 0;
    for (const window of last) {
        const balance = window.sources[key];
        if (!balance || balance.home !== home || balance.steady) return undefined;
        if (balance.full !== true || balance.threat !== false || balance.building !== false) return undefined;
        net += balance.delivered - balance.cost;
        ticks += window.ticks;
    }
    return ticks > 0 ? { net: (net * 1000) / ticks, home } : undefined;
}

/**
 * Drops the expired exclusions and adds the sources of the newest window that lose energy.
 * Returns the keys newly excluded. A source already excluded is not judged again.
 */
export function updateExclusions(
    excluded: { [key: string]: Exclusion },
    windows: BalanceWindow[],
    now: number,
    duration: () => number = () => jitter(EXCLUDE_TICKS)
): string[] {
    for (const key in excluded) if (excluded[key].until <= now) delete excluded[key];
    const added: string[] = [];
    const newest = windows[windows.length - 1];
    if (!newest) return added;
    for (const key in newest.sources) {
        if (excluded[key]) continue;
        const measured = measuredNet(windows, key);
        if (measured) {
            if (measured.net >= MIN_NET_PER_1000) continue;
            excluded[key] = { home: measured.home, since: now, until: now + duration(), net: Math.round(measured.net), reason: "measured" };
            added.push(key);
            continue;
        }
        const unsteady = unsteadyNet(windows, key);
        if (!unsteady || unsteady.net >= 0) continue;
        excluded[key] = { home: unsteady.home, since: now, until: now + duration(), net: Math.round(unsteady.net), reason: "unsteady" };
        added.push(key);
    }
    return added;
}

/** Tick of the newest window judged (heap) and of the last refresh */
let judged: number | undefined;
let refreshed: number | undefined;

function refresh(): void {
    if (refreshed === Game.time) return;
    refreshed = Game.time;
    const windows = remoteBalanceWindows();
    const newest = windows[windows.length - 1]?.tick;
    if (newest === undefined || newest === judged) return;
    judged = newest;
    const excluded = Memory.remoteExcluded ?? {};
    const added = updateExclusions(excluded, windows, Game.time);
    for (const key of added) {
        const e = excluded[key];
        countStat("remote:excluded");
        countStat(`remote:excluded:${e.reason ?? "measured"}`);
        const rule = e.reason === "unsteady" ? `${UNSTEADY_WINDOWS} windows never steady` : `${BALANCE_WINDOWS} steady windows`;
        log.info("RemoteMining", `${key} (home ${e.home}): net ${e.net}/1000 ticks over ${rule}, excluded until ${e.until}`);
    }
    if (Object.keys(excluded).length > 0) Memory.remoteExcluded = excluded;
    else delete Memory.remoteExcluded;
}

/** Whether a source is left out of a home's remote selection by its measured balance */
export function isRemoteExcluded(key: string, home: string): boolean {
    refresh();
    const exclusion = Memory.remoteExcluded?.[key];
    return !!exclusion && exclusion.home === home && exclusion.until > Game.time;
}
