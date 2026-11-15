/**
 * ObserverManager - room intel through our observers (rules in intel/observerPlan.ts).
 *
 * Every REPLAN ticks it lists the rooms needing intel (the scouts' rule, IntelManager.needsScouting: the
 * rooms in each home's scout range, plus the active military targets), keeps those within OBSERVER_RANGE
 * of an observer and not visible, and ranks them. Each tick every observer observes the next one
 * (observeRoom at tick N, the room is visible at N+1 and IntelManager records it like any visible room).
 * Counters `observer:observe` (successful observeRoom) and `observer:queue` (rooms ranked per replan).
 */

import { assignObservations, classifyNeed, coveredByObserver, ObservationCandidate, rankCandidates } from "../intel/observerPlan";
import { ownObservers } from "../intel/observers";
import { currentTargets } from "../military/military";
import { cpuPressure } from "../remote/remoteIncome";
import { MAX_ROOM_DISTANCE } from "../remote/RemoteMining";
import { roomsInRange } from "../utils/rooms";
import { scoutRange } from "../utils/scouting";
import { countStat } from "../utils/stats";
import { intelManager } from "./IntelManager";

/**
 * Ticks between two lists of rooms to observe: rooms need intel a few times per 1000 ticks (rescout ages
 * 10000-50000), and the list walks every home's scout range (up to 120 rooms each)
 */
const REPLAN = 50;

let queue: ObservationCandidate[] = [];
let lastPlan = -Infinity;

const distance = (a: string, b: string) => Game.map.getRoomLinearDistance(a, b);

function plan(observerRooms: string[]): ObservationCandidate[] {
    const homes = Object.values(Game.rooms).filter(r => r.controller?.my);
    const needing = new Set<string>();
    for (const home of homes) {
        for (const room of intelManager.getRoomsNeedingScouting(home.name, scoutRange(home.controller!.level))) needing.add(room);
    }
    const military = new Set(currentTargets());
    for (const room of military) if (intelManager.needsScouting(room)) needing.add(room);
    // Most replans find nothing to observe: no classification then
    for (const room of needing) if (Game.rooms[room] || !coveredByObserver(room, observerRooms, distance)) needing.delete(room);
    if (needing.size === 0) return [];

    const remote = new Set<string>();
    for (const home of homes) for (const room of roomsInRange(home.name, MAX_ROOM_DISTANCE)) remote.add(room);
    const expansion = new Set([Memory.expand?.current?.roomName, Memory.expand?.next?.roomName].filter((r): r is string => !!r));
    const ctx = {
        military,
        remote,
        expansion,
        intel: (room: string) => {
            const intel = intelManager.getIntel(room);
            return intel ? { owner: intel.owner, controller: !!intel.controllerPos } : undefined;
        }
    };

    const candidates: ObservationCandidate[] = [];
    for (const room of needing) {
        const lastScouted = intelManager.getIntel(room)?.lastScouted;
        candidates.push({ room, need: classifyNeed(room, ctx), age: lastScouted === undefined ? Infinity : Game.time - lastScouted });
    }
    return rankCandidates(candidates, cpuPressure());
}

export const observerManagerModule = (): void => {
    const observers = ownObservers();
    if (observers.length === 0) {
        queue = [];
        return;
    }
    // Elapsed ticks, not Game.time % REPLAN: the module can be throttled
    if (Game.time - lastPlan >= REPLAN) {
        lastPlan = Game.time;
        queue = plan(observers.map(o => o.room));
        if (queue.length > 0) countStat("observer:queue", queue.length);
    }
    if (queue.length === 0) return;

    // One observeRoom per observer and tick (0.2 CPU intent each)
    const observed = new Set<string>();
    for (const { observer, room } of assignObservations(observers, queue, distance)) {
        const structure = Game.getObjectById(observer as Id<StructureObserver>);
        // Taken off the queue whatever the result: a failing room is not retried every tick (next replan)
        observed.add(room);
        if (structure?.observeRoom(room) === OK) countStat("observer:observe");
    }
    queue = queue.filter(c => !observed.has(c.room));
};
