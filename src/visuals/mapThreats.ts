/**
 * World map layer: threats and reservations. Owned rooms and remote rooms with hostiles not expected
 * dead yet (RoomIntel `room.memory.enemies`): a red frame and `hostiles · <ticks left>t` (player
 * names and the enemy strength when the room is visible, "safe" while hostiles can't fight).
 * Remote rooms and the expansion target: reservation ticks left at (25,7), from the controller when
 * visible, else the most recent of our reserver's `lastClaim` and the scouted intel, extrapolated.
 * Cached data only (Memory, intel store, visible rooms); the caller caches the export.
 */

import { enemyStrength } from "../defense/RoomDefense";
import { intelManager } from "../modules/IntelManager";
import { canReserveFrom } from "../remote/RemoteMining";

const FONT = 6;
const OK = "#7ee08a";
const WARN = "#e8a23a";
const BAD = "#ff5c5c";
const DIM = "#a0a0a0";
const BACKDROP = "#101010";
const STRENGTH_NAMES = ["none", "weak", "normal", "strong", "deadly"];

/** Our reservation below this many ticks turns orange */
const LOW_RESERVATION = 1000;
/** Reservation data older than this is shown as unknown */
const STALE_RESERVATION = 1500;

function textStyle(color: string): MapTextStyle {
    return { color, fontSize: FONT, backgroundColor: BACKDROP, backgroundPadding: 0.8, opacity: 0.85 };
}

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

function drawThreat(visual: MapVisual, roomName: string): void {
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
    visual.text(parts.join(" · "), new RoomPosition(25, 33, roomName), textStyle(color));
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

function drawReservation(visual: MapVisual, roomName: string, homes: Room[]): void {
    const pos = new RoomPosition(25, 7, roomName);
    const me = myUsername();
    const state = reservation(roomName, me);
    if (state?.user && state.user !== me) {
        visual.text(`res ${state.user} ${short(state.ticks)}`, pos, textStyle(BAD));
        return;
    }
    if (state?.user && state.ticks > 0) {
        const stale = state.age > STALE_RESERVATION;
        const color = stale || state.ticks < LOW_RESERVATION ? WARN : OK;
        visual.text(`res ${short(state.ticks)}${stale ? "?" : ""}`, pos, textStyle(color));
        return;
    }
    // Nobody holds it: only worth a word where one of our homes could reserve
    if (homes.some(home => canReserveFrom(home, roomName))) visual.text("unreserved", pos, textStyle(DIM));
}

/** Draws the threats and reservations on the world map */
export function drawMapThreats(visual: MapVisual): void {
    const { owned, remotes } = watchedRooms();
    for (const name of owned) drawThreat(visual, name);
    const homes = owned.map(name => Game.rooms[name]);
    for (const name of remotes) {
        drawThreat(visual, name);
        drawReservation(visual, name, homes);
    }
}
