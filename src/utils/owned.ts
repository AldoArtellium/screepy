/**
 * Owned room helpers shared by the reports, the history, defense and expansion. No imports: the
 * offline checks load the compiled modules that use them.
 */

let cachedTick: number | undefined;
let cachedRooms: Room[] = [];

/** Visible rooms we own (cached for the tick: callers must not change the list) */
export function myRooms(): Room[] {
    if (cachedTick !== Game.time) {
        cachedTick = Game.time;
        cachedRooms = _.filter(Game.rooms, r => !!r.controller?.my);
    }
    return cachedRooms;
}

/** Energy in a room's storage and terminal */
export function storedEnergy(room: Room): number {
    return (room.storage?.store.energy ?? 0) + (room.terminal?.store.energy ?? 0);
}
