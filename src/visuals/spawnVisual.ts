/**
 * Spawn overlay: what each spawn of the room is spawning (role, ticks left, progress bar under the
 * spawn), or on the first idle spawn the role the room waits for with energy / cost and priority.
 * Redrawn every tick: a handful of elements per spawn.
 */

import { spawnManager } from "../modules/SpawnManager";
import { ROLE_NAMES } from "./panel";

const FONT = 0.45;
const TEXT = "#e8e8e8";
const WARN = "#f0b04a";
const OK = "#5fbf6f";
const BAR_BACK = "#3a3a3a";
const BAR_WIDTH = 1.6;
const BAR_HEIGHT = 0.2;
/** Above the game's spawn name (drawn at about y - 0.9) */
const TEXT_DY = -1.4;
/** Just under the spawn sprite */
const BAR_DY = 0.75;
const BACKDROP = { backgroundColor: "#101010", backgroundPadding: 0.1 };

function shortRole(role: string): string {
    return ROLE_NAMES[role] ?? role;
}

/** Draws the overlay of every spawn of the room (redrawn every tick: the countdown changes) */
export function drawSpawns(visual: RoomVisual, room: Room): void {
    let waitingShown = false;
    for (const spawn of room.find(FIND_MY_SPAWNS)) {
        const { x, y } = spawn.pos;
        const spawning = spawn.spawning;
        if (spawning) {
            const role = Memory.creeps[spawning.name]?.role ?? spawning.name;
            visual.text(`${shortRole(role)} ${spawning.remainingTime}t`, x, y + TEXT_DY, { font: FONT, color: TEXT, opacity: 0.9, ...BACKDROP });
            const fill = Math.max(0, Math.min(1, 1 - spawning.remainingTime / spawning.needTime));
            const left = x - BAR_WIDTH / 2;
            visual.rect(left, y + BAR_DY, BAR_WIDTH, BAR_HEIGHT, { fill: BAR_BACK, opacity: 0.9 });
            if (fill > 0) visual.rect(left, y + BAR_DY, BAR_WIDTH * fill, BAR_HEIGHT, { fill: OK, opacity: 0.95 });
            continue;
        }
        if (waitingShown) continue;
        const next = spawnManager.nextSpawn(room.name);
        if (!next) continue;
        waitingShown = true;
        const cost = next.cost === undefined ? "" : ` ${room.energyAvailable}/${next.cost}`;
        visual.text(`${shortRole(next.role)}${cost} p${next.priority}`, x, y + TEXT_DY, { font: FONT, color: WARN, opacity: 0.9, ...BACKDROP });
    }
}
