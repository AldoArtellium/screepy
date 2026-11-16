/**
 * Squad overlay, in whatever room our squads stand (target room included): above the leader its type,
 * state, the quad's engage step and members alive / roster; the structure it focuses this tick (circled,
 * dashed line from the leader; military/squadTrace.ts), the quad's 2x2 anchor and its rally tile, and
 * above the drainer the tower energy it measured. Drawn every tick, nothing without a mission.
 */

import { squadTrace } from "../military/squadTrace";

const BAD = "#ff5c5c";
const WARN = "#e8a23a";
const DIM = "#a8a8a8";
const BACKDROP = "#101010";
const FONT = 0.5;

/** Members of a full squad (duo.ts DUO_ATTACKER + DUO_HEALER, quad.ts QUAD_ROSTER) */
const ROSTER = { duo: 2, quad: 4 };

function label(visual: RoomVisual, text: string, pos: RoomPosition, color: string): void {
    visual.text(text, pos.x, Math.max(0.6, pos.y - 1.1), {
        font: FONT,
        color,
        backgroundColor: BACKDROP,
        backgroundPadding: 0.1,
        opacity: 0.9
    });
}

function drawSquad(name: string, type: "duo" | "quad", memory: { state: string; members: string[] }): Creep | undefined {
    const creeps = memory.members.map(member => Game.creeps[member]).filter((c): c is Creep => !!c && !c.spawning);
    const leader = creeps[0];
    if (!leader) return undefined;
    const visual = leader.room.visual;
    const trace = squadTrace(name);
    const note = trace?.note ? ` · ${trace.note}` : "";
    label(visual, `${type} ${memory.state}${note} ${creeps.length}/${ROSTER[type]}`, leader.pos, memory.state === "retreat" ? WARN : BAD);
    const focus = trace?.focus ? Game.getObjectById(trace.focus) : null;
    if (focus && focus.pos.roomName === leader.pos.roomName) {
        visual.circle(focus.pos, { radius: 0.7, fill: "transparent", stroke: BAD, strokeWidth: 0.1, opacity: 0.9 });
        visual.line(leader.pos, focus.pos, { color: BAD, width: 0.06, opacity: 0.5, lineStyle: "dashed" });
    }
    return leader;
}

/** Draws every squad's overlay */
export function drawSquads(): void {
    const military = Memory.military;
    if (!military) return;
    for (const [name, duo] of Object.entries(military.duos ?? {})) drawSquad(name, "duo", duo);
    for (const [name, quad] of Object.entries(military.quads ?? {})) {
        const leader = drawSquad(name, "quad", quad);
        const room = leader?.room;
        if (room && quad.anchor?.room === room.name) {
            room.visual.rect(quad.anchor.x - 0.5, quad.anchor.y - 0.5, 2, 2, {
                fill: "transparent",
                stroke: BAD,
                strokeWidth: 0.05,
                opacity: 0.6,
                lineStyle: "dashed"
            });
        }
        if (room && quad.rally?.room === room.name) room.visual.circle(quad.rally.x, quad.rally.y, { radius: 0.3, fill: DIM, opacity: 0.6 });
        const drainer = quad.drainer ? Game.creeps[quad.drainer.name] : undefined;
        if (drainer && !drainer.spawning) {
            const energy = quad.probeEnergy !== undefined ? ` · towers ${quad.probeEnergy}e` : "";
            label(drainer.room.visual, `drainer${energy}`, drainer.pos, WARN);
        }
    }
}
