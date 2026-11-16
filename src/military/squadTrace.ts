/**
 * What each squad did this tick, for the room overlay (visuals/squadVisual.ts): the structure it
 * focuses and the quad's engage step ("packing", "no target", ...). Heap only, rewritten every tick the
 * squad acts; a trace older than one tick is stale (the squad is out of the target room).
 */

export interface SquadTrace {
    tick: number;
    focus?: Id<Structure>;
    note?: string;
}

const traces: Map<string, SquadTrace> = new Map();

/** Records the squad's focus and / or step this tick */
export function noteSquad(squad: string, update: { focus?: Structure | null; note?: string }): void {
    let trace = traces.get(squad);
    if (!trace || trace.tick !== Game.time) {
        trace = { tick: Game.time };
        traces.set(squad, trace);
    }
    if (update.focus) trace.focus = update.focus.id;
    if (update.note) trace.note = update.note;
}

/** The squad's trace of this tick, undefined when it did not act */
export function squadTrace(squad: string): SquadTrace | undefined {
    const trace = traces.get(squad);
    if (!trace) return undefined;
    if (trace.tick !== Game.time) {
        traces.delete(squad);
        return undefined;
    }
    return trace;
}
