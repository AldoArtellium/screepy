/**
 * World map layer: remote mining (Hivemind map-visuals.ts, The International mapVisuals.ts). Each
 * selected remote source: its path to the home storage (one point every PATH_STEP tiles), path
 * length, net energy per tick (remoteIncome sourceNet) and remote harvesters, in red when it has
 * gone STARVED_TICKS without a harvester or is under attack; invader cores; a summary per home
 * room (sources, cap, spawn busy share). Cached data only: no path search, nothing written.
 */

import { creepsByRole } from "../core/roomState";
import { hasInvaderCore } from "../modules/RoomIntel";
import { canReserveFrom, isRemoteUnderAttack, maintenanceWork, remotePath, RemoteSource, STARVED_TICKS } from "../remote/RemoteMining";
import { sourceNet } from "../remote/remoteIncome";

const PATH_STEP = 5;
const FONT = 6;

const PATH = "#00ffff";
const TEXT = "#d8d8d8";
const OK = "#5fbf6f";
const WARN = "#e8a23a";
const BAD = "#e05555";

/** Every PATH_STEP-th position from the storage end, plus both ends */
function pathPoints(path: RoomPosition[]): RoomPosition[] {
    const points: RoomPosition[] = [];
    for (let i = path.length - 1; i > 0; i -= PATH_STEP) points.push(path[i]);
    points.push(path[0]);
    return points;
}

/** Net energy per tick of a selected source, as the selection prices it */
function sourceIncome(home: Room, source: RemoteSource): number {
    const roads = home.controller!.level > 3 && !!(home.storage || home.terminal);
    const capacity = canReserveFrom(home, source.room) ? SOURCE_ENERGY_CAPACITY : SOURCE_ENERGY_NEUTRAL_CAPACITY;
    return sourceNet({
        generation: capacity / ENERGY_REGEN_TIME,
        distance: source.travelTime,
        roads,
        maintenanceWork: roads ? maintenanceWork(source) : 0
    });
}

function drawSource(visual: MapVisual, home: Room, source: RemoteSource, harvesters: number): void {
    const starved = source.servedAt !== undefined && Game.time - source.servedAt > STARVED_TICKS;
    const attacked = isRemoteUnderAttack(source);
    const color = attacked || starved ? BAD : harvesters === 0 ? WARN : OK;

    const path = remotePath(source);
    if (path.length > 1)
        visual.poly(pathPoints(path), { stroke: attacked ? BAD : PATH, strokeWidth: 0.8, opacity: 0.3 });

    const pos = new RoomPosition(source.x, source.y, source.room);
    visual.circle(pos, { radius: 1.5, fill: color, opacity: 0.8 });
    const net = sourceIncome(home, source);
    const label = `${source.travelTime}t ${net >= 0 ? "+" : ""}${net.toFixed(1)}/t H${harvesters}${starved ? " starved" : ""}`;
    // Above the source, kept inside the room
    const textPos = new RoomPosition(source.x, Math.max(3, source.y - 2), source.room);
    visual.text(label, textPos, { fontSize: FONT, color, opacity: 0.9 });
}

function drawHome(visual: MapVisual, home: Room, count: number): void {
    const mem = Memory.remoteMining!;
    const cap = mem.sourceCaps?.[home.name]?.max;
    const busy = mem.spawnBusy?.[home.name];
    const parts = [`remotes ${count}${cap === undefined ? "" : `/${cap}`}`];
    if (busy !== undefined) parts.push(`spawn ${Math.round(100 * busy)}%`);
    visual.text(parts.join(" · "), new RoomPosition(25, 46, home.name), {
        fontSize: FONT,
        color: cap === undefined ? TEXT : WARN,
        backgroundColor: "#101010",
        backgroundPadding: 1,
        opacity: 0.8
    });
}

/** Draws the remote mining layer on the world map */
export function drawMapRemotes(visual: MapVisual): void {
    const sources = Memory.remoteMining?.sources;
    if (!sources) return;
    const byHome: { [home: string]: RemoteSource[] } = {};
    for (const key in sources) (byHome[sources[key].homeRoom] ??= []).push(sources[key]);

    const cores = new Set<string>();
    for (const homeName in byHome) {
        const home = Game.rooms[homeName];
        if (!home?.controller?.my) continue;
        const harvesters: { [key: string]: number } = {};
        for (const creep of creepsByRole(homeName, "remoteHarvester")) {
            const key = creep.memory.source;
            if (key) harvesters[key] = (harvesters[key] ?? 0) + 1;
        }
        for (const source of byHome[homeName]) {
            drawSource(visual, home, source, harvesters[source.key] ?? 0);
            if (hasInvaderCore(source.room)) cores.add(source.room);
        }
        drawHome(visual, home, byHome[homeName].length);
    }
    for (const room of cores) {
        const center = new RoomPosition(25, 25, room);
        visual.circle(center, { radius: 8, fill: "transparent", stroke: BAD, strokeWidth: 1, opacity: 0.6 });
        visual.text("core", center, { fontSize: FONT + 2, color: BAD, opacity: 0.9 });
    }
}
