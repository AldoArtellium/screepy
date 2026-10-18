/**
 * TerminalTransfers - evens resources out between owned rooms with terminals (terminal.send).
 * Ported from Hivemind (MIT), src/process/resources.ts and src/empire/trade-route-manager.ts
 * (getAvailableTransportRoutes). Rules: docs/hivemind/hivemind-endgame.md §4.
 *
 * A room whose level of a resource is high or excessive (core/resources.ts resourceLevel) sends 5000
 * to a room where it is low (energy: also medium while it has enemies; or medium when the sender is
 * excessive). Funnel targets (roomsToFunnel) pull energy through their higher energy levels. The
 * resource is first brought to the terminal (room.memory.fillTerminal); each room sends or receives
 * once per run. Not ported: evacuation, terminal/storage clearing, allies' requests.
 */

import { ENEMY_STRENGTH_NONE, enemyStrength } from "../defense/RoomDefense";
import { getBestOption } from "../core/options";
import { myRoomsWithTerminal, prepareForTrading, resourceAmount, resourceLevel, totalResources } from "../core/resources";
import { log } from "../utils/logger";

/** Amount per send */
const TRADE_VOLUME = 5000;

interface TransportRoute {
    priority: number;
    weight: number;
    resourceType: ResourceConstant;
    source: string;
    target: string;
}

/** Terminal and storage both over 90% full */
function needsStorageSpace(room: Room): boolean {
    const { terminal, storage } = room;
    if (!terminal || !storage) return false;
    return terminal.store.getFreeCapacity() < terminal.store.getCapacity() * 0.1 && storage.store.getFreeCapacity() < storage.store.getCapacity() * 0.1;
}

function availableRoutes(rooms: Room[]): TransportRoute[] {
    const routes: TransportRoute[] = [];
    for (const room of rooms) {
        const terminal = room.terminal!;
        const fullStorage = needsStorageSpace(room);
        // Not while preparing a transfer, nor on cooldown
        if ((room.memory.fillTerminal && !fullStorage) || terminal.cooldown) continue;
        const resources = totalResources(room);
        for (const key in resources) {
            const resourceType = key as ResourceConstant;
            const amount = resources[resourceType];
            if (!amount) continue;
            const level = resourceLevel(room, resourceType, amount);
            if (level !== "high" && level !== "excessive") continue;
            if (resourceType === RESOURCE_ENERGY && amount < 10000) continue;

            for (const other of rooms) {
                if (other === room || other.terminal!.store.getFreeCapacity() < 5000) continue;
                const otherAmount = totalResources(other)[resourceType] ?? 0;
                const otherLevel = resourceLevel(other, resourceType, otherAmount);
                const isLow =
                    otherLevel === "low" ||
                    (resourceType === RESOURCE_ENERGY && enemyStrength(other) > ENEMY_STRENGTH_NONE && otherLevel === "medium");
                if (!fullStorage && !isLow && !(level === "excessive" && otherLevel === "medium")) continue;

                // Energy to pay the transfer (and 5000 to send when sending energy)
                const needed = Game.market.calcTransactionCost(TRADE_VOLUME, room.name, other.name) + (resourceType === RESOURCE_ENERGY ? TRADE_VOLUME : 0);
                if (terminal.store.energy < needed) continue;

                routes.push({
                    priority: isLow ? 3 : 2,
                    weight: (amount - otherAmount) / 100000 - Game.map.getRoomLinearDistance(room.name, other.name),
                    resourceType,
                    source: room.name,
                    target: other.name
                });
            }
        }
    }
    return routes;
}

export const terminalTransfersModule = (): void => {
    const rooms = myRoomsWithTerminal();
    if (rooms.length < 2) return;
    let routes = availableRoutes(rooms);
    let best = getBestOption(routes);
    while (best) {
        const route = best;
        const room = Game.rooms[route.source];
        const terminal = room.terminal!;
        if (room.memory.fillTerminal && (terminal.store.getFreeCapacity(room.memory.fillTerminal) ?? 0) < 5000) {
            delete room.memory.fillTerminal;
            delete room.memory.fillTerminalAmount;
        }
        const volume = Math.ceil(Math.min(resourceAmount(room, route.resourceType), TRADE_VOLUME));
        let sent = false;
        if (volume > 0 && terminal.store[route.resourceType] >= volume * 0.9) {
            const amount = Math.min(volume, terminal.store[route.resourceType]);
            const result = terminal.send(route.resourceType, amount, route.target, "Resource equalizing");
            log.info("Terminal", `${route.source}: send ${amount} ${route.resourceType} to ${route.target}: ${result}`);
            sent = result === OK;
        } else if (
            volume > 0 &&
            !room.memory.fillTerminal &&
            (terminal.store.getFreeCapacity(route.resourceType) ?? 0) - terminal.store[route.resourceType] > volume
        ) {
            prepareForTrading(room, route.resourceType);
        }

        // Each room sends or receives once; a failed or prepared route drops its source and resource
        if (sent) {
            const involved = [route.source, route.target];
            routes = routes.filter(r => !involved.includes(r.source) && !involved.includes(r.target));
        } else {
            routes = routes.filter(r => r.source !== route.source || r.resourceType !== route.resourceType);
        }
        best = getBestOption(routes);
    }
};
