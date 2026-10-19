/**
 * World map layer: remote mining (Hivemind map-visuals.ts, The International mapVisuals.ts). Each
 * selected remote source: its path to the home storage (one point every PATH_STEP tiles, one color
 * per home room), a dot and a label `<net>/t · <travel>t · <harvesters>H` (net energy per tick from
 * remoteIncome sourceNet), on a dark backdrop placed clear of the other labels of the room. Colors:
 * green with a remote harvester, grey while the source just went without one, orange after
 * WAITING_TICKS, red when starved (STARVED_TICKS since it was last served) or under attack; invader
 * cores; a summary per home room (sources, cap, spawn busy share) in the home's color. Cached data
 * only: no path search, nothing written.
 */

import { creepsByRole } from "../core/roomState";
import { hasInvaderCore } from "../modules/RoomIntel";
import { canReserveFrom, isRemoteUnderAttack, maintenanceWork, remotePath, RemoteSource, STARVED_TICKS } from "../remote/RemoteMining";
import { sourceNet } from "../remote/remoteIncome";

/** Without a remote harvester for this long a source turns orange (red after STARVED_TICKS) */
const WAITING_TICKS = 300;
const PATH_STEP = 5;
const FONT = 6;
/** Rough size of a label on the map (room tiles), to keep labels apart */
const LABEL_WIDTH = 20;
const LABEL_HEIGHT = 5;
/** Label rows tried around the source, nearest first */
const LABEL_OFFSETS = [-3, 4, -8, 9];

/** Path and summary color of each home room, by sorted home name */
const HOME_COLORS = ["#00ffff", "#c58cff", "#ffd54d", "#ff8ad8", "#8cff9e"];
const OK = "#7ee08a";
const IDLE = "#a0a0a0";
const WARN = "#e8a23a";
const BAD = "#ff5c5c";
const BACKDROP = "#101010";

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

/** Labels already placed, by room: their center */
type Placed = { [room: string]: { x: number; y: number }[] };

/** First row around the source whose label overlaps no label placed in the room */
function labelPos(placed: Placed, source: RemoteSource): RoomPosition {
    const taken = (placed[source.room] ??= []);
    const rows = LABEL_OFFSETS.map(dy => Math.max(3, Math.min(47, source.y + dy)));
    // Centered on the source, kept mostly inside the room
    const x = Math.max(5, Math.min(45, source.x));
    const y =
        rows.find(row => taken.every(t => Math.abs(t.x - x) >= LABEL_WIDTH || Math.abs(t.y - row) >= LABEL_HEIGHT)) ?? rows[0];
    taken.push({ x, y });
    return new RoomPosition(x, y, source.room);
}

function drawSource(visual: MapVisual, placed: Placed, home: Room, homeColor: string, source: RemoteSource, harvesters: number): void {
    const unserved = source.servedAt === undefined ? 0 : Game.time - source.servedAt;
    const starved = unserved > STARVED_TICKS;
    const attacked = isRemoteUnderAttack(source);
    const color = attacked || starved ? BAD : harvesters > 0 ? OK : unserved > WAITING_TICKS ? WARN : IDLE;

    const path = remotePath(source);
    if (path.length > 1)
        visual.poly(pathPoints(path), { stroke: attacked ? BAD : homeColor, strokeWidth: 0.8, opacity: 0.35 });

    visual.circle(new RoomPosition(source.x, source.y, source.room), { radius: 1.5, fill: color, opacity: 0.9 });
    const net = sourceIncome(home, source);
    const label = `${net.toFixed(1)}/t · ${source.travelTime}t · ${harvesters}H${starved ? " · starved" : ""}`;
    visual.text(label, labelPos(placed, source), {
        fontSize: FONT,
        color,
        backgroundColor: BACKDROP,
        backgroundPadding: 0.8,
        opacity: 0.85
    });
}

function drawHome(visual: MapVisual, home: Room, homeColor: string, count: number): void {
    const mem = Memory.remoteMining!;
    const cap = mem.sourceCaps?.[home.name]?.max;
    const busy = mem.spawnBusy?.[home.name];
    const parts = [`remotes ${count}${cap === undefined ? "" : `/${cap}`}`];
    if (busy !== undefined) parts.push(`spawn ${Math.round(100 * busy)}%`);
    visual.text(parts.join(" · "), new RoomPosition(25, 46, home.name), {
        fontSize: FONT,
        color: cap === undefined ? homeColor : WARN,
        backgroundColor: BACKDROP,
        backgroundPadding: 1,
        opacity: 0.85
    });
}

/** Draws the remote mining layer on the world map */
export function drawMapRemotes(visual: MapVisual): void {
    const sources = Memory.remoteMining?.sources;
    if (!sources) return;
    const byHome: { [home: string]: RemoteSource[] } = {};
    for (const key in sources) (byHome[sources[key].homeRoom] ??= []).push(sources[key]);

    const placed: Placed = {};
    const cores = new Set<string>();
    Object.keys(byHome)
        .sort()
        .forEach((homeName, index) => {
            const home = Game.rooms[homeName];
            if (!home?.controller?.my) return;
            const homeColor = HOME_COLORS[index % HOME_COLORS.length];
            const harvesters: { [key: string]: number } = {};
            for (const creep of creepsByRole(homeName, "remoteHarvester")) {
                const key = creep.memory.source;
                if (key) harvesters[key] = (harvesters[key] ?? 0) + 1;
            }
            for (const source of byHome[homeName]) {
                drawSource(visual, placed, home, homeColor, source, harvesters[source.key] ?? 0);
                if (hasInvaderCore(source.room)) cores.add(source.room);
            }
            drawHome(visual, home, homeColor, byHome[homeName].length);
        });
    for (const room of cores) {
        const center = new RoomPosition(25, 25, room);
        visual.circle(center, { radius: 8, fill: "transparent", stroke: BAD, strokeWidth: 1, opacity: 0.6 });
        visual.text("core", center, { fontSize: FONT + 2, color: BAD, backgroundColor: BACKDROP, backgroundPadding: 0.8, opacity: 0.9 });
    }
}
