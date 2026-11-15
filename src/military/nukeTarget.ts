/**
 * Our nukes: where one lands for the most value, and when the squad of the same target may start. Pure
 * functions (tests/nukes/run.mjs); military/nukeStrike.ts reads the rooms and launches.
 *
 * A structure is destroyed when the damage on its tile exceeds the rampart over it plus its own hits
 * (defense/nukeDefense.ts: 10M at the center, 5M within range 2, ramparts absorb first). Its value is what
 * its owner loses (nukeDefense.ts STRUCTURE_WORTH, the table our own defense protects by). Earlier nukes of
 * ours on the room count as having already eaten into the ramparts.
 */

import { NUKE_RADIUS, nukeDamageAt, STRUCTURE_WORTH } from "../defense/nukeDefense";

/** Rooms a nuker reaches (NUKE_RANGE) */
export const NUKE_RANGE = 10;

export interface EnemyStructure {
    x: number;
    y: number;
    type: string;
    /** Hits of the rampart on its tile (0 without) */
    rampartHits: number;
    /** Its own hits (a few thousand: negligible next to the damage, counted all the same) */
    hits?: number;
}

export interface Impact {
    x: number;
    y: number;
    /** STRUCTURE_WORTH of what it destroys */
    value: number;
    destroyed: EnemyStructure[];
}

/** What a nuke landing on x,y destroys, `earlier` nukes of ours on the same room landing first */
export function impactAt(structures: EnemyStructure[], x: number, y: number, earlier: { x: number; y: number }[] = []): Impact {
    const destroyed: EnemyStructure[] = [];
    let value = 0;
    const here = [{ x, y, timeToLand: 0 }];
    const before = earlier.map(e => ({ ...e, timeToLand: 0 }));
    for (const s of structures) {
        const damage = nukeDamageAt(here, s.x, s.y);
        if (damage === 0) continue;
        const rampart = Math.max(0, s.rampartHits - nukeDamageAt(before, s.x, s.y));
        if (damage <= rampart + (s.hits ?? 0)) continue;
        destroyed.push(s);
        value += STRUCTURE_WORTH[s.type] ?? 0;
    }
    return { x, y, value, destroyed };
}

/**
 * Impact point destroying the most value (ties: the most structures, then the first tile scanned), among the
 * tiles within NUKE_RADIUS of a valued structure. Null when nothing of value can be destroyed.
 */
export function bestImpact(structures: EnemyStructure[], earlier: { x: number; y: number }[] = []): Impact | null {
    const valued = structures.filter(s => (STRUCTURE_WORTH[s.type] ?? 0) > 0);
    const seen = new Set<number>();
    let best: Impact | null = null;
    for (const s of valued) {
        for (let x = Math.max(0, s.x - NUKE_RADIUS); x <= Math.min(49, s.x + NUKE_RADIUS); x++) {
            for (let y = Math.max(0, s.y - NUKE_RADIUS); y <= Math.min(49, s.y + NUKE_RADIUS); y++) {
                const key = x + 50 * y;
                if (seen.has(key)) continue;
                seen.add(key);
                const impact = impactAt(valued, x, y, earlier);
                if (impact.value <= 0) continue;
                if (!best || impact.value > best.value || (impact.value === best.value && impact.destroyed.length > best.destroyed.length)) {
                    best = impact;
                }
            }
        }
    }
    return best;
}

/**
 * Ticks before the impact a squad of the nuked target may start (spawning, boosting, forming, walking): it
 * arrives around the impact, and the evacuation (defense/nukes.ts, applied to our nuke's target room too)
 * keeps it out of the room until the nuke landed. Until then its mission waits.
 */
export const SQUAD_LEAD_TICKS = 1500;

/** A mission on a target with a nuke of ours landing in `timeToLand` ticks waits */
export function missionWaits(timeToLand: number | undefined): boolean {
    return timeToLand !== undefined && timeToLand > SQUAD_LEAD_TICKS;
}
