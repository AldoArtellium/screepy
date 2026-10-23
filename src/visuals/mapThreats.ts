/**
 * World map layer: threats and reservations. Owned rooms and remote rooms with hostiles not expected
 * dead yet (RoomIntel `room.memory.enemies`): a red frame and `hostiles · <ticks left>t` (player
 * names and the enemy strength when the room is visible, "safe" while hostiles can't fight).
 * Remote rooms and the expansion target: reservation ticks left at (25,7), from the controller when
 * visible, else the most recent of our reserver's `lastClaim` and the scouted intel, extrapolated.
 * With the map panel the texts go to it instead (a `threats` section; reservations on the source
 * rows of the remote layer), the frame stays in the room.
 * Cached data only (Memory, intel store, visible rooms); the caller caches the export.
 */

import { enemyStrength } from "../defense/RoomDefense";
import { intelManager } from "../modules/IntelManager";
import { canReserveFrom } from "../remote/RemoteMining";
import { LABEL_PRIORITY, labelStyle, MapLabels } from "./mapLabels";
import { Cell, MapPanel } from "./mapPanel";

const THREAT_FONT = 5;
const RESERVATION_FONT = 4;
const UNRESERVED_FONT = 3;
const OK = "#7ee08a";
const WARN = "#e8a23a";
const BAD = "#ff5c5c";
const DIM = "#a0a0a0";
const STRENGTH_NAMES = ["none", "weak", "normal", "strong", "deadly"];

/** Our reservation below this many ticks turns orange */
const LOW_RESERVATION = 1000;
/** Reservation data older than this is shown as unknown */
const STALE_RESERVATION = 1500;

function short(ticks: number): string {
    return ticks >= 1000 ? `${(ticks / 1000).toFixed(1)}k` : `${ticks}`;
}

/** Owned rooms, the rooms of the selected remote sources and the expansion target */
function watchedRooms(): { owned: string[]; remotes: string[] } {
    const owned = Object.keys(Game.rooms).filter(name => Game.rooms[name].controller?.my);
    const remotes = new Set<string>();
    for (const source of Object.values(Memory.remoteMining?.sources ?? {})) remotes.add(source.room);
    const target = Memory.expand?.current?.roomName;
    if (target && !Game.rooms[target]?.controller?.my) remotes.add(target);
    return { owned, remotes: [...remotes].filter(name => !owned.includes(name)) };
}

/** Watched rooms with hostiles not expected dead and their safe flag: the map is redrawn when it changes */
export function threatSignature(): string {
    const { owned, remotes } = watchedRooms();
    return [...owned, ...remotes]
        .filter(name => (Memory.rooms?.[name]?.enemies?.expires ?? 0) > Game.time)
        .map(name => (Memory.rooms[name].enemies!.safe ? `${name}:safe` : name))
        .sort()
        .join(",");
}

function drawThreat(visual: MapVisual, labels: MapLabels, threats: Cell[][] | undefined, roomName: string): void {
    const enemies = Memory.rooms?.[roomName]?.enemies;
    if (!enemies || (enemies.expires ?? 0) <= Game.time) return;
    const parts = [`hostiles · ${short(enemies.expires! - Game.time)}t`];
    const room = Game.rooms[roomName];
    if (room) {
        const players = new Set(
            room
                .find(FIND_HOSTILE_CREEPS)
                .map(c => c.owner.username)
                .filter(name => name !== "Invader" && name !== "Source Keeper")
        );
        if (players.size > 0) parts.push([...players].join(", "));
        if (room.controller?.my) parts.push(STRENGTH_NAMES[enemyStrength(room)]);
    }
    if (enemies.safe) parts.push("safe");
    const color = enemies.safe ? WARN : BAD;
    visual.rect(new RoomPosition(1, 1, roomName), 48, 48, { fill: "transparent", stroke: color, strokeWidth: 1, opacity: 0.6 });
    if (threats) {
        threats.push([
            { text: roomName, color },
            { text: parts.join(" · "), color }
        ]);
        return;
    }
    const pos = (y: number) => new RoomPosition(25, y, roomName);
    const style = labelStyle(color, THREAT_FONT);
    labels.add(parts.join(" · "), [pos(33), pos(29), pos(37)], style, LABEL_PRIORITY.threat, true);
}

/** Our username, from any owned controller (me is declared but never set) */
function myUsername(): string | undefined {
    for (const name in Game.rooms) {
        const controller = Game.rooms[name].controller;
        if (controller?.my) return controller.owner?.username;
    }
    return undefined;
}

/** Reserver and ticks left now, from the freshest data; undefined when nothing is known */
function reservation(roomName: string, me: string | undefined): { user?: string; ticks: number; age: number } | undefined {
    const controller = Game.rooms[roomName]?.controller;
    if (controller) return { user: controller.reservation?.username, ticks: controller.reservation?.ticksToEnd ?? 0, age: 0 };
    let best: { user?: string; ticks: number; age: number } | undefined;
    const claim = Memory.rooms?.[roomName]?.lastClaim;
    if (claim) {
        const age = Game.time - claim.time;
        best = { user: claim.value > 0 ? me : undefined, ticks: Math.max(0, claim.value - age), age };
    }
    const intel = intelManager.getIntel(roomName);
    if (intel && (!best || Game.time - intel.lastScouted < best.age)) {
        const age = Game.time - intel.lastScouted;
        const ticks = Math.max(0, (intel.reservationTicks ?? 0) - age);
        best = { user: ticks > 0 ? intel.reserver : undefined, ticks, age };
    }
    return best;
}

/** Reservation text of a room, undefined when nothing is worth showing */
export function reservationCell(roomName: string, homes: Room[]): Cell | undefined {
    const me = myUsername();
    const state = reservation(roomName, me);
    if (state?.user && state.user !== me) return { text: `res ${state.user} ${short(state.ticks)}`, color: BAD };
    if (state?.user && state.ticks > 0) {
        const stale = state.age > STALE_RESERVATION;
        const color = stale || state.ticks < LOW_RESERVATION ? WARN : OK;
        return { text: `res ${short(state.ticks)}${stale ? "?" : ""}`, color };
    }
    // Nobody holds it: only worth a word where one of our homes could reserve
    if (homes.some(home => canReserveFrom(home, roomName))) return { text: "unreserved", color: DIM };
    return undefined;
}

function drawReservation(labels: MapLabels, roomName: string, homes: Room[]): void {
    const cell = reservationCell(roomName, homes);
    if (!cell) return;
    // Top of the room, then its other corners: source labels give way to it
    const pos = [25, 10, 40].map(x => new RoomPosition(x, 6, roomName));
    const style =
        cell.color === DIM ? labelStyle(DIM, UNRESERVED_FONT, 0.6) : labelStyle(cell.color, RESERVATION_FONT);
    labels.add(cell.text, pos, style, LABEL_PRIORITY.reservation);
}

/** Draws the threats and reservations on the world map */
export function drawMapThreats(visual: MapVisual, labels: MapLabels, panel?: MapPanel): void {
    const { owned, remotes } = watchedRooms();
    const threats: Cell[][] | undefined = panel ? [] : undefined;
    for (const name of owned) drawThreat(visual, labels, threats, name);
    const homes = owned.map(name => Game.rooms[name]);
    for (const name of remotes) {
        drawThreat(visual, labels, threats, name);
        if (!panel) drawReservation(labels, name, homes);
    }
    if (panel && threats!.length > 0) panel.section([{ text: "threats", color: BAD }]).push(...threats!);
}
