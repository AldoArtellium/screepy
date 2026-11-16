/**
 * Remote rows of the world map panel (`mapRemotes.ts`): one summary row per home room (RCL, remotes and
 * cap, spawn busy share, net income of its remotes) and a row only for the sources with a problem, the
 * worst one named. Before 2026-11-16 every source had its row, nearly all green: the panel was mostly
 * remotes that needed nothing. Pure, checked offline by `tests/remoteVisuals/run.mjs`.
 */

import type { Cell } from "./mapPanel";
import { short } from "../utils/format";

export const OK = "#7ee08a";
export const WARN = "#e8a23a";
export const BAD = "#ff5c5c";

/** Without a remote harvester for this long a source is a problem (red once starved) */
export const WAITING_TICKS = 300;

export interface SourceFacts {
    attacked: boolean;
    starved: boolean;
    /** Ticks since a remote harvester last served the source */
    unserved: number;
    harvesters: number;
    /** Net energy per tick as the selection prices it */
    net: number;
    /** Reservation cell (mapThreats.ts reservationCell): green ours, orange low or stale, red someone else's */
    reservation?: Cell;
}

/** The source's worst problem, undefined when it needs nothing */
export function sourceIssue(facts: SourceFacts): Cell | undefined {
    if (facts.attacked) return { text: "attacked", color: BAD };
    if (facts.starved) return { text: "starved", color: BAD };
    if (facts.harvesters === 0 && facts.unserved > WAITING_TICKS) return { text: "no harvester", color: WARN };
    const reservation = facts.reservation;
    if (reservation && (reservation.color === BAD || reservation.color === WARN)) return reservation;
    if (facts.net <= 0) return { text: "loss", color: BAD };
    return undefined;
}

export interface HomeFacts {
    name: string;
    /** Path color of the home */
    color: string;
    rcl: number;
    /** Remote sources selected */
    count: number;
    /** Source cap while the remote CPU budget holds the home (sourceCaps), undefined uncapped */
    cap?: number;
    /** Share of the spawn time used */
    busy?: number;
    /** Net energy per tick of its remote sources */
    net: number;
}

/** Summary row of a home room */
export function homeRow(home: HomeFacts): Cell[] {
    const count = home.cap === undefined ? `${home.count} remotes` : `${home.count}/${home.cap} remotes`;
    return [
        { text: home.name, color: home.color },
        { text: `RCL ${home.rcl}`, color: OK },
        { text: count, color: home.cap === undefined ? home.color : WARN },
        { text: home.busy === undefined ? "" : `spawn ${Math.round(100 * home.busy)}%`, color: home.color },
        { text: `+${home.net >= 100 ? short(home.net) : home.net.toFixed(1)}/t`, color: OK }
    ];
}
