/**
 * World map layer: creeps working away from their home room (pioneers, claimers, remote defenders,
 * military squads, scouts; remote builders dim without line). A dot per creep colored by role, and per
 * group (same role, home room, current room and target) one thin line to the target room center and a
 * label next to the first creep: `<role> <state> x<count>`, so a pioneer going back and forth between
 * two rooms shows up. Remote harvesters, haulers and reservers are left to the remote layer.
 */

import { CLAIMER, PIONEER } from "../expansion/squadSpawnRole";
import { DUO_ATTACKER, DUO_HEALER } from "../military/duo";
import { QUAD_ATTACKER, QUAD_HEALER } from "../military/quad";
import { REMOTE_DEFENDER } from "../remote/remoteDefense";
import { REMOTE_BUILDER } from "../remote/remoteSpawnRole";

const FONT = 5;
const BACKDROP = "#101010";

interface Kind {
    name: string;
    color: string;
    /** Draw the line and label (else the dot only) */
    line: boolean;
}

const KINDS: { [role: string]: Kind } = {
    [PIONEER]: { name: "pion", color: "#4dd0ff", line: true },
    [CLAIMER]: { name: "claim", color: "#c58cff", line: true },
    [REMOTE_DEFENDER]: { name: "rDef", color: "#e8a23a", line: true },
    [DUO_ATTACKER]: { name: "duo", color: "#ff5c5c", line: true },
    [DUO_HEALER]: { name: "duo", color: "#ff5c5c", line: true },
    [QUAD_ATTACKER]: { name: "quad", color: "#ff5c5c", line: true },
    [QUAD_HEALER]: { name: "quad", color: "#ff5c5c", line: true },
    scout: { name: "scout", color: "#a0a0a0", line: true },
    [REMOTE_BUILDER]: { name: "rBuil", color: "#707070", line: false }
};

/** Room the creep is heading for, if it has one */
function targetRoom(creep: Creep): string | undefined {
    const memory = creep.memory;
    if (memory.duo) return Memory.military?.duos?.[memory.duo]?.targetRoom;
    if (memory.quad) return Memory.military?.quads?.[memory.quad]?.targetRoom;
    return memory.targetRoom ?? memory.scoutTarget;
}

/** What the creep is doing, for pioneers and claimers */
function state(creep: Creep, target: string | undefined): string {
    const memory = creep.memory;
    if (memory.role === PIONEER) return memory.filling ? "filling" : memory.building ? "building" : "fetching";
    if (memory.role === CLAIMER) return creep.room.name === target ? "claiming" : "travel";
    return "";
}

interface Group {
    kind: Kind;
    pos: RoomPosition;
    target?: string;
    label: string;
    count: number;
}

/** Draws the creeps in transit on the world map */
export function drawMapCreeps(visual: MapVisual): void {
    const groups: Map<string, Group> = new Map();
    for (const name in Game.creeps) {
        const creep = Game.creeps[name];
        const kind = KINDS[creep.memory.role ?? ""];
        const home = creep.memory.room;
        if (!kind || !home || creep.room.name === home) continue;
        visual.circle(creep.pos, { radius: 0.8, fill: kind.color, opacity: 0.9 });
        if (!kind.line) continue;

        const target = targetRoom(creep);
        const doing = state(creep, target);
        const label = doing ? `${kind.name} ${doing}` : kind.name;
        const key = `${kind.name}|${home}|${creep.room.name}|${target ?? ""}|${doing}`;
        const group = groups.get(key);
        if (group) group.count++;
        else groups.set(key, { kind, pos: creep.pos, target, label, count: 1 });
    }

    for (const group of groups.values()) {
        const { kind, pos, target } = group;
        if (target && target !== pos.roomName) {
            visual.line(pos, new RoomPosition(25, 25, target), {
                color: kind.color,
                width: 0.4,
                opacity: 0.5,
                lineStyle: "dashed"
            });
        }
        // Next to the creep, kept inside the room
        const labelPos = new RoomPosition(Math.max(5, Math.min(45, pos.x)), pos.y > 40 ? pos.y - 3 : pos.y + 3, pos.roomName);
        const text = group.count > 1 ? `${group.label} x${group.count}` : group.label;
        visual.text(text, labelPos, {
            fontSize: FONT,
            color: kind.color,
            backgroundColor: BACKDROP,
            backgroundPadding: 0.8,
            opacity: 0.85
        });
    }
}
