/**
 * Scouting rules (pure, offline check: tests/scouting/run.mjs), used by modules/ScoutManager.ts and
 * modules/IntelManager.ts.
 *
 * Not in Hivemind. shard0 2026-10-25: 4 owned rooms (3 of them neighbours) each kept a scout on the
 * rooms within 5, so the same rooms were scouted up to 3 times, ~0.5-0.8 CPU per tick (0.24 code per
 * scout plus a move intent per tick) while the remote budget was capped by the CPU.
 */

export interface ScoutHome {
    name: string;
    /** Rooms this home scouts within */
    range: number;
}

/** Owned room in charge of scouting a room: the closest whose range covers it, ties to the first by name */
export function scoutHomeOf(roomName: string, homes: ScoutHome[], distance: (a: string, b: string) => number): string | undefined {
    let best: string | undefined;
    let bestDistance = Infinity;
    for (const home of homes) {
        const d = distance(home.name, roomName);
        if (d > home.range) continue;
        if (d < bestDistance || (d === bestDistance && best !== undefined && home.name < best)) {
            best = home.name;
            bestDistance = d;
        }
    }
    return best;
}

/** Ownership intel is refreshed this many times less often under CPU pressure (remoteIncome.ts cpuPressure) */
const PRESSURE_RESCOUT_FACTOR = 3;

/** Age after which a room with a controller is scouted again */
export function ownershipRescoutAge(base: number, cpuPressure: boolean): number {
    return cpuPressure ? base * PRESSURE_RESCOUT_FACTOR : base;
}
