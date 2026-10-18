/**
 * Links - moves energy between the links of each owned room: source links ("in") empty into the
 * controller link ("out"), neutral links (storage) take the surplus or make up for the shortfall.
 * Ported from Hivemind (MIT), src/process/rooms/owned/links.ts. See docs/hivemind/hivemind-links.md.
 */

import { LinkAndDelta, linkNetwork, LinkNetwork } from "../core/roomState";
import { countStat } from "../utils/stats";

/** Smallest transfer worth a link cooldown */
const MIN_ENERGY_TRANSFER = LINK_CAPACITY / 4;

/** Biggest surplus without cooldown, else the fullest neutral link */
function bestSourceLink(network: LinkNetwork): LinkAndDelta | undefined {
    const sorted = _.sortBy(
        network.overfull.filter(l => l.link.cooldown <= 0),
        l => -l.delta
    );
    if (sorted[0] && sorted[0].delta >= MIN_ENERGY_TRANSFER) return sorted[0];
    const neutral = _.sortBy(
        network.neutral.filter(l => l.cooldown <= 0),
        l => -l.store.energy
    )[0];
    if (neutral) return { link: neutral, delta: neutral.store.energy };
    return sorted[0];
}

/** Biggest shortfall, else the emptiest neutral link */
function bestDestinationLink(network: LinkNetwork): LinkAndDelta | undefined {
    const sorted = _.sortBy(network.underfull, l => -l.delta);
    if (sorted[0] && sorted[0].delta >= MIN_ENERGY_TRANSFER) return sorted[0];
    const neutral = _.sortBy(network.neutral, l => l.store.energy)[0];
    if (neutral) return { link: neutral, delta: neutral.store.getFreeCapacity(RESOURCE_ENERGY) };
    return sorted[0];
}

function manageLinks(room: Room): void {
    const network = linkNetwork(room);
    if (!network || (network.overfull.length === 0 && network.underfull.length === 0)) return;
    const from = bestSourceLink(network);
    const to = bestDestinationLink(network);
    if (!from || !to || from.link.id === to.link.id) return;
    const amount = Math.floor(Math.min(from.delta, to.delta));
    if (amount < MIN_ENERGY_TRANSFER) return;
    if (from.link.transferEnergy(to.link, amount) === OK) countStat("link:transfer", amount);
}

/** Module for ModuleManager (Hivemind: every 3 ticks, high priority) */
export const linksModule = (): void => {
    for (const name in Game.rooms) {
        const room = Game.rooms[name];
        if (!room.controller?.my || (room.controller.level ?? 0) < 5) continue;
        manageLinks(room);
    }
};
