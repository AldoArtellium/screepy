/**
 * Nuke strikes (our design, 2026-11-15). `Memory.military.nuke`:
 * - false: no nuker is filled (dispatcher/destinations.ts) nor fired, the labs make no ghodium for it;
 * - unset (default): nukers are filled, a nuke is only fired when told: "W8N3" (best impact from what is seen
 *   of the room) or "W8N3:25,25" (that tile), one strike, the setting cleared once the nuke is launched;
 * - true: also fires on the current military targets (military.ts currentTargets: each has a strategic reason,
 *   strategy.ts, or was set by hand), players only (a stronghold's loot would burn), one nuke in flight per
 *   room, when the best impact (nukeTarget.ts) destroys MIN_ROI times what the nuke costs (roi.ts nukeCost).
 * The closest loaded nuker in range (NUKE_RANGE rooms) fires. A mission on a room with our nuke in flight waits
 * until SQUAD_LEAD_TICKS before the impact (military.ts), and our creeps keep out of that room until it lands
 * (defense/nukes.ts evacuateFromNukes reads `Memory.military.nukes`): every creep in the room dies at impact.
 */

import { BORDER_GUARD_TICKS } from "../defense/nukeDefense";
import { energyPrice } from "../modules/MarketManager";
import { log } from "../utils/logger";
import { countStat } from "../utils/stats";
import { hostileRoom, militaryMemory } from "./intel";
import { bestImpact, EnemyStructure, Impact, impactAt, missionWaits, NUKE_RANGE } from "./nukeTarget";
import { nukeCost, nukeWorthIt } from "./roi";

const STRIKE_EVERY = 100;
/** A strike set by hand is tried this often (waiting for a loaded nuker or a sight of the room) */
const FORCED_EVERY = 10;
/** A layout seen longer ago is not trusted by an automatic strike (ramparts grow, structures get rebuilt) */
const LAYOUT_MAX_AGE = 5000;

/** Ticks before our nuke lands on `room`, undefined without one in flight */
export function strikeTimeToLand(room: string): number | undefined {
    const strike = Memory.military?.nukes?.[room];
    if (!strike || strike.landTime < Game.time) return undefined;
    return strike.landTime - Game.time;
}

/**
 * Our nuke lands on `room` within the border guard: the squads of its missions are left to the evacuation
 * (defense/nukes.ts, run by the CreepRunner before this module, whose moves would override it). Mockup: a
 * drainer on the target's exit tile died at impact before this.
 */
export function squadsOutForNuke(room: string): boolean {
    const timeToLand = strikeTimeToLand(room);
    const out = timeToLand !== undefined && timeToLand <= BORDER_GUARD_TICKS;
    if (out) countStat("nuke:squadsOut");
    return out;
}

/** A mission on `room` waits for our nuke to come closer (nukeTarget.ts missionWaits) */
export function missionHeldByNuke(room: string): boolean {
    const held = missionWaits(strikeTimeToLand(room));
    if (held) countStat("nuke:missionHold");
    return held;
}

function loadedNukers(): StructureNuker[] {
    const nukers: StructureNuker[] = [];
    for (const name in Game.rooms) {
        const room = Game.rooms[name];
        if (!room.controller?.my || room.controller.level < 8) continue;
        for (const s of room.find(FIND_MY_STRUCTURES, { filter: { structureType: STRUCTURE_NUKER } }) as StructureNuker[]) {
            if (s.cooldown > 0 || !s.isActive()) continue;
            if (s.store.energy < NUKER_ENERGY_CAPACITY || s.store[RESOURCE_GHODIUM] < NUKER_GHODIUM_CAPACITY) continue;
            nukers.push(s);
        }
    }
    return nukers;
}

function closestNuker(nukers: StructureNuker[], room: string): StructureNuker | undefined {
    const inRange = nukers.filter(n => Game.map.getRoomLinearDistance(n.room.name, room) <= NUKE_RANGE);
    return _.min(inRange, n => Game.map.getRoomLinearDistance(n.room.name, room)) as StructureNuker | undefined;
}

/** Valued structures of a player room: seen now, else the military intel's layout (`maxAge` ticks at most) */
function structuresOf(room: string, maxAge: number): EnemyStructure[] | null {
    const visible = Game.rooms[room];
    if (visible) {
        const ramparts = new Map<number, number>();
        for (const s of visible.find(FIND_STRUCTURES, { filter: { structureType: STRUCTURE_RAMPART } })) ramparts.set(s.pos.x + 50 * s.pos.y, s.hits);
        return visible
            .find(FIND_HOSTILE_STRUCTURES)
            .map(s => ({ x: s.pos.x, y: s.pos.y, type: s.structureType, hits: s.hits, rampartHits: ramparts.get(s.pos.x + 50 * s.pos.y) ?? 0 }));
    }
    const intel = hostileRoom(room);
    if (!intel?.layout || Game.time - intel.t > maxAge) return null;
    return intel.layout.map(([type, x, y, rampartHits]) => ({ type, x, y, rampartHits }));
}

function launch(nuker: StructureNuker, room: string, impact: Impact, why: string): boolean {
    const result = nuker.launchNuke(new RoomPosition(impact.x, impact.y, room));
    if (result !== OK) {
        countStat(`nuke:launchError:${result}`);
        log.warn("Nukes", `${nuker.room.name} could not nuke ${room} ${impact.x},${impact.y}: ${result}`);
        return false;
    }
    const memory = militaryMemory();
    const landTime = Game.time + NUKE_LAND_TIME;
    memory.nukes = { ...memory.nukes, [room]: { x: impact.x, y: impact.y, landTime, from: nuker.room.name, value: impact.value } };
    countStat("nuke:launched");
    const destroyed = impact.destroyed.map(s => s.type).join("+") || "nothing seen";
    const message = `Nuke launched from ${nuker.room.name} on ${room} ${impact.x},${impact.y} (${why}): lands at ${landTime}, destroys ${destroyed} (${impact.value} energy)`;
    log.warn("Nukes", message);
    Game.notify(message);
    return true;
}

/** "W8N3" or "W8N3:25,25" */
function parseForced(value: string): { room: string; x?: number; y?: number } | null {
    const match = /^([WE]\d+[NS]\d+)(?::(\d+),(\d+))?$/.exec(value);
    if (!match) return null;
    return { room: match[1], ...(match[2] !== undefined && { x: Number(match[2]), y: Number(match[3]) }) };
}

/** Forced strikes already reported as impossible (heap: one log per setting) */
const reported = new Set<string>();

function forcedStrike(value: string): void {
    const memory = militaryMemory();
    const forced = parseForced(value);
    const fail = (why: string) => {
        if (reported.has(value)) return;
        reported.add(value);
        log.warn("Nukes", `Memory.military.nuke ${value}: ${why}`);
    };
    if (!forced) return fail("expected a room or room:x,y");
    const nuker = closestNuker(loadedNukers(), forced.room);
    if (!nuker) return fail(`no loaded nuker within ${NUKE_RANGE} rooms`);
    const structures = structuresOf(forced.room, Infinity) ?? [];
    const impact = forced.x !== undefined ? impactAt(structures, forced.x, forced.y!) : bestImpact(structures);
    if (!impact) return fail("nothing of value known in the room: give the impact tile");
    if (launch(nuker, forced.room, impact, "by hand")) delete memory.nuke;
}

/** Every FORCED_EVERY ticks (strike set by hand) or STRIKE_EVERY ticks (automatic), from military.ts */
export function runNukeStrikes(targets: string[]): void {
    const memory = militaryMemory();
    for (const room in memory.nukes ?? {}) if (memory.nukes![room].landTime < Game.time) delete memory.nukes![room];
    if (memory.nukes && Object.keys(memory.nukes).length === 0) delete memory.nukes;
    const setting = memory.nuke;
    if (typeof setting === "string") {
        if (Game.time % FORCED_EVERY === 0) forcedStrike(setting);
        return;
    }
    if (setting !== true || Game.time % STRIKE_EVERY !== 0) return;
    const nukers = loadedNukers();
    if (nukers.length === 0) return;
    const cost = nukeCost(energyPrice(RESOURCE_GHODIUM));
    for (const room of targets) {
        if (strikeTimeToLand(room) !== undefined || !hostileRoom(room)?.owner) continue;
        const nuker = closestNuker(nukers, room);
        const structures = nuker && structuresOf(room, LAYOUT_MAX_AGE);
        if (!nuker || !structures) continue;
        const impact = bestImpact(structures);
        if (!impact || !nukeWorthIt(impact.value, cost)) continue;
        if (launch(nuker, room, impact, `automatic, cost ${Math.round(cost)}`)) return;
    }
}
