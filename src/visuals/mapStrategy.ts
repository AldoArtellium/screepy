/**
 * World map layer: strategy - owned rooms (RCL), the expansion target with lines from its spawn room
 * (solid) and support rooms (dashed), past expansion failures (red circles), the attack target with a
 * line from each squad's spawn room, and the age of the intel of every known room (one dot per room).
 * Reads cached data only (Memory, intel store); the caller caches the export.
 */

import { intelManager } from "../modules/IntelManager";

const FONT = 7;
const OK = "#5fbf6f";
const WARN = "#e8a23a";
const BAD = "#e05555";
const EXPAND = "#4dd0ff";

/** Intel age thresholds (ticks): green below FRESH, yellow below STALE, red above */
const FRESH = 10000;
const STALE = 50000;
/** Failures older than this are no longer drawn (Expansion remembers them 1M ticks) */
const FAILURE_SHOWN = 100000;

function center(roomName: string): RoomPosition {
    return new RoomPosition(25, 25, roomName);
}

function ageText(ticks: number): string {
    return ticks >= 1000 ? `${Math.round(ticks / 1000)}k` : `${ticks}`;
}

function drawOwnedRooms(visual: MapVisual): void {
    for (const name in Game.rooms) {
        const controller = Game.rooms[name].controller;
        if (!controller?.my) continue;
        visual.text(`RCL ${controller.level}`, new RoomPosition(25, 7, name), { color: OK, fontSize: FONT, opacity: 0.9 });
    }
}

function drawIntelAge(visual: MapVisual): void {
    const intel = intelManager.allIntel();
    for (const name in intel) {
        const age = Game.time - intel[name].lastScouted;
        const color = age < FRESH ? OK : age < STALE ? WARN : BAD;
        visual.circle(new RoomPosition(45, 5, name), { radius: 2, fill: color, opacity: 0.6, stroke: "transparent" });
    }
}

function drawExpansion(visual: MapVisual): void {
    const expand = Memory.expand;
    if (!expand) return;
    for (const failure of expand.failed ?? []) {
        if (Game.time - failure.time > FAILURE_SHOWN) continue;
        visual.circle(center(failure.roomName), { radius: 20, fill: "transparent", stroke: BAD, strokeWidth: 1, opacity: 0.5 });
    }

    const current = expand.current;
    if (!current) return;
    const target = center(current.roomName);
    visual.line(center(current.spawnRoom), target, { color: EXPAND, width: 1, opacity: 0.6 });
    const supports = new Set<string>();
    for (const name in expand.squads ?? {}) {
        const squad = expand.squads[name];
        if (squad.targetRoom === current.roomName && squad.spawnRoom !== current.spawnRoom) supports.add(squad.spawnRoom);
    }
    for (const room of supports) {
        visual.line(center(room), target, { color: EXPAND, width: 0.8, opacity: 0.5, lineStyle: "dashed" });
    }
    const state = current.claimed ? `claimed ${ageText(Game.time - current.claimed)}` : ageText(Game.time - current.started);
    visual.circle(target, { radius: 6, fill: "transparent", stroke: EXPAND, strokeWidth: 1, opacity: 0.8 });
    visual.text(`expand · ${state}`, new RoomPosition(25, 40, current.roomName), { color: EXPAND, fontSize: FONT, opacity: 0.9 });
}

function drawAttack(visual: MapVisual): void {
    const military = Memory.military;
    const targetRoom = military?.attack ?? military?.target?.room;
    if (!military || !targetRoom) return;
    const target = center(targetRoom);
    const squads = [...Object.values(military.duos ?? {}), ...Object.values(military.quads ?? {})].filter(
        s => s.targetRoom === targetRoom
    );
    const homes = new Set(squads.map(s => s.spawnRoom));
    const states = new Set<string>(squads.map(s => s.state));
    for (const home of homes) visual.line(center(home), target, { color: BAD, width: 1, opacity: 0.6 });
    visual.circle(target, { radius: 6, fill: "transparent", stroke: BAD, strokeWidth: 1, opacity: 0.8 });
    const reason = military.attack ? "manual" : (military.target?.reason ?? "");
    const label = states.size > 0 ? `attack (${reason}) · ${[...states].join(", ")}` : `attack (${reason})`;
    visual.text(label, new RoomPosition(25, 46, targetRoom), { color: BAD, fontSize: FONT, opacity: 0.9 });
}

/** Draws the strategy layer on the world map */
export function drawMapStrategy(visual: MapVisual): void {
    drawIntelAge(visual);
    drawOwnedRooms(visual);
    drawExpansion(visual);
    drawAttack(visual);
}
