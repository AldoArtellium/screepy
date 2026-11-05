/**
 * Remote seizes: another player's remote taken for our remote mining (rules and the shard0 problem in
 * remoteRooms.ts, above SEIZE_TTL). Every SEIZE_CHECK ticks: held seizes are renewed, lost ones (the
 * player fought back) and unused ones (the selection left the room out) dropped; then new ones up to
 * `Memory.military.maxSeizes` (default 2) while the remote CPU budget has room. A seize is a
 * `Memory.remoteReleased` entry with `seize` set: the room is no longer blocked nor contested by that
 * player, remote defense sends a defender against their creeps there (remoteDefense.ts seizeDefenseOptions),
 * our reserver attacks their reservation. Off with `Memory.military.auto = false` or `maxSeizes: 0`.
 * Our design.
 */

import { AGGRESSION_HOSTILE } from "../military/playerThreat";
import { intelManager } from "../modules/IntelManager";
import { log } from "../utils/logger";
import { isKeeperRoom } from "../utils/rooms";
import { countStat } from "../utils/stats";
import { isContested, pickSeizes, SEIZE_TTL, SeizeFacts, seizeCandidate, seizeStatus } from "./remoteRooms";

declare global {
    interface Memory {
        /** Tick of the last lost seize of each room (remoteSeize.ts) */
        remoteSeizeFailed?: { [room: string]: number };
    }
}

const SEIZE_CHECK = 100;
const DEFAULT_MAX_SEIZES = 2;
/** Lowest RCL of a room that defends a seized remote (a mini brawler, reservers of 2 CLAIM) */
const MIN_RCL = 4;
let lastCheck = 0;

/** The player whose remote we hold, if the room is seized */
export function seizedFrom(roomName: string): string | undefined {
    const entry = Memory.remoteReleased?.[roomName];
    return entry?.seize && Game.time < entry.until ? entry.player : undefined;
}

function defendingRooms(): string[] {
    return _.filter(
        Game.rooms,
        r => !!r.controller?.my && r.controller.level >= MIN_RCL && r.find(FIND_MY_SPAWNS).length > 0
    ).map(r => r.name);
}

/** Other players' remotes in the static intel and the contests, with the facts the rule needs */
function candidates(homes: string[]): SeizeFacts[] {
    const aggression = Memory.military?.aggression ?? {};
    const players: { [room: string]: string } = {};
    for (const [room, intel] of Object.entries(intelManager.allIntel()))
        if (!intel.owner && intel.reserver && intel.reserver !== Memory.username) players[room] = intel.reserver;
    for (const [room, entry] of Object.entries(Memory.remoteContested ?? {}))
        if (isContested(entry, Game.time)) players[room] = entry.player;
    const result: SeizeFacts[] = [];
    for (const [room, player] of Object.entries(players)) {
        if (Memory.remoteReleased?.[room]) continue;
        const intel = intelManager.getIntel(room);
        const distance = _.min(homes.map(h => Game.map.getRoomLinearDistance(h, room)));
        const facts: SeizeFacts = {
            room,
            player,
            aggression: aggression[player] ?? 0,
            sources: intel?.sources?.length ?? 0,
            distance,
            keeper: isKeeperRoom(room) || !!intel?.hasSourceKeepers,
            owned: !!intel?.owner,
            failedAt: Memory.remoteSeizeFailed?.[room]
        };
        if (seizeCandidate(facts, Game.time, AGGRESSION_HOSTILE)) result.push(facts);
    }
    return result;
}

function spareBudget(mined: Set<string>): boolean {
    const maxRooms = Memory.remoteMining?.maxRooms;
    return maxRooms === undefined || maxRooms > mined.size;
}

/** Renews, drops and starts seizes (RemoteMining module, before the selection) */
export function updateSeizes(mined: Set<string>): void {
    if (Game.time - lastCheck < SEIZE_CHECK) return;
    lastCheck = Game.time;
    const released = Memory.remoteReleased ?? {};
    const off = Memory.military?.auto === false || Memory.military?.maxSeizes === 0;
    const active: string[] = [];
    for (const [room, entry] of Object.entries(released)) {
        if (!entry.seize) continue;
        const aggression = Memory.military?.aggression?.[entry.player] ?? 0;
        const status = off
            ? "unused"
            : seizeStatus({ aggression, threshold: AGGRESSION_HOSTILE, since: entry.since, now: Game.time, mined: mined.has(room) });
        if (status === "hold") {
            entry.until = Game.time + SEIZE_TTL;
            active.push(room);
            continue;
        }
        delete released[room];
        countStat(`remote:seize:${status}`);
        // Lost (they fought back) or unused (the selection can't mine it): left alone, else it takes a slot again
        if (status === "lost" || (status === "unused" && !off)) {
            Memory.remoteSeizeFailed ??= {};
            Memory.remoteSeizeFailed[room] = Game.time;
        }
        log.info("RemoteSeize", `${room} seize from ${entry.player} ${status} (aggression ${Math.round(aggression)})`);
    }
    for (const room in Memory.remoteSeizeFailed ?? {})
        if (Game.time - Memory.remoteSeizeFailed![room] > 50000) delete Memory.remoteSeizeFailed![room];
    if (off || !spareBudget(mined)) return;
    const homes = defendingRooms();
    if (homes.length === 0) return;
    const facts = candidates(homes);
    for (const room of pickSeizes(facts, active, Memory.military?.maxSeizes ?? DEFAULT_MAX_SEIZES)) {
        const player = facts.find(f => f.room === room)!.player;
        Memory.remoteReleased ??= {};
        Memory.remoteReleased[room] = { player, since: Game.time, until: Game.time + SEIZE_TTL, seize: true };
        if (Memory.remoteContested?.[room]) delete Memory.remoteContested[room];
        countStat("remote:seize");
        log.info("RemoteSeize", `seizing ${room} from ${player}`);
    }
}
