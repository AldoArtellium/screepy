/**
 * Transporter: fetch resources from the best source, deliver them to the best destination.
 * Also the energy fetching / delivery library of harvesters, builders and upgraders.
 * Ported from Hivemind (MIT), src/role/transporter.ts.
 */

import { stayInPlace } from "../core/movement";
import { clearOrder, currentEnergy, Order, roomBays, setOrder, storageLocation } from "../core/roomState";
import { DispatchContext } from "../dispatcher/Dispatcher";
import { destinationDispatcher } from "../dispatcher/destinations";
import { sourceDispatcher } from "../dispatcher/sources";
import { countCreep } from "../utils/history";
import { countStat } from "../utils/stats";
import { registerRole } from "./registry";

declare global {
    interface CreepMemory {
        delivering?: boolean;
    }
}

/** Heap only: ticks left to wait after finding no source */
const idlingFor: Map<string, number> = new Map();

function setDelivering(creep: Creep, delivering: boolean): void {
    creep.memory.delivering = delivering;
    clearOrder(creep);
}

export function runTransporter(creep: Creep): void {
    const order = creep.memory.order;
    const idle = idlingFor.get(creep.name) ?? 0;
    if (idle > 0) {
        idlingFor.set(creep.name, idle - 1);
        countCreep(creep, `idle:${creep.memory.role}`);
        stayInPlace(creep);
        return;
    }

    const used = creep.store.getUsedCapacity();
    const capacity = creep.store.getCapacity();
    if (used >= capacity * 0.9 && !order && !creep.memory.delivering) {
        setDelivering(creep, true);
    } else if (used <= capacity * 0.1 && creep.memory.delivering && !order && used === creep.store.energy) {
        setDelivering(creep, false);
    }

    if (unblockBay(creep)) return;
    if (creep.memory.delivering) {
        countStat(`deliver:${creep.memory.order?.type ?? "none"}`);
        performDeliver(creep);
        return;
    }

    // Don't park on the pile at the base center
    const location = storageLocation(creep.room);
    if (!creep.room.storage && location && creep.pos.isEqualTo(location) && !creep.memory.order?.target) {
        creep.move((1 + Math.floor(Math.random() * 8)) as DirectionConstant);
        return;
    }

    performGetResources(creep, () => calculateSource(creep));
}

/** Leave a bay center we are not filling when it has a single way out (we would block it) */
function unblockBay(creep: Creep): boolean {
    const order = creep.memory.order;
    for (const bay of roomBays(creep.room)) {
        if (!bay.pos.isEqualTo(creep.pos)) continue;
        if (order?.type === "bay" && order.name === bay.name) continue;
        const exits = walkableNeighbours(creep.pos);
        if (exits.length !== 1) continue;
        creep.move(creep.pos.getDirectionTo(exits[0]));
        return true;
    }
    return false;
}

function walkableNeighbours(pos: RoomPosition): RoomPosition[] {
    const terrain = Game.map.getRoomTerrain(pos.roomName);
    const result: RoomPosition[] = [];
    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            if (!dx && !dy) continue;
            const x = pos.x + dx;
            const y = pos.y + dy;
            if (x < 1 || x > 48 || y < 1 || y > 48 || terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
            const neighbour = new RoomPosition(x, y, pos.roomName);
            const blocked = neighbour
                .lookFor(LOOK_STRUCTURES)
                .some(s => (OBSTACLE_OBJECT_TYPES as string[]).includes(s.structureType));
            if (!blocked) result.push(neighbour);
        }
    }
    return result;
}

export function performDeliver(creep: Creep): void {
    const context: DispatchContext = { creep };
    if (!ensureDeliveryOrder(creep, context)) {
        stayInPlace(creep);
        clearOrder(creep);
        return;
    }
    destinationDispatcher.executeTask(creep.memory.order!, context);
}

function ensureDeliveryOrder(creep: Creep, context: DispatchContext): boolean {
    if (!creep.memory.order) {
        const order = destinationDispatcher.getTask(context);
        setOrder(creep, order);
        if (!order && creep.store.getFreeCapacity() > 0) setDelivering(creep, false);
    }
    const order = creep.memory.order;
    if (!order) return false;
    return destinationDispatcher.has(order) && destinationDispatcher.validateTask(order, context);
}

export function performGetResources(creep: Creep, calculate: () => void): void {
    const context: DispatchContext = { creep };
    if (!ensureSourceOrder(creep, context, calculate)) {
        clearOrder(creep);
        stayInPlace(creep);
        if (creep.memory.role === "transporter") {
            setDelivering(creep, creep.store.getUsedCapacity() > creep.store.getCapacity() * 0.1);
        }
        return;
    }
    sourceDispatcher.executeTask(creep.memory.order!, { creep, resourceType: creep.memory.order!.resourceType });
}

function ensureSourceOrder(creep: Creep, context: DispatchContext, calculate: () => void): boolean {
    if (!creep.memory.order) calculate();
    const order = creep.memory.order;
    if (!order) {
        if (creep.store.getUsedCapacity() > 0) {
            if (creep.memory.role === "transporter") setDelivering(creep, true);
            return false;
        }
        if (creep.memory.role === "transporter") idlingFor.set(creep.name, 5);
        return false;
    }
    return sourceDispatcher.has(order) && sourceDispatcher.validateTask(order, { ...context, resourceType: order.resourceType });
}

/** With a storage, fetch what the most important destination needs */
function calculateSource(creep: Creep): void {
    const room = creep.room;
    const hasStorage = !!(room.storage || room.terminal);
    let best = sourceDispatcher.getTask({ creep, resourceType: hasStorage ? undefined : RESOURCE_ENERGY });
    if (hasStorage) {
        const destination = destinationDispatcher.getTask(
            { creep, ignoreStoreContent: true },
            task => (task.resourceType ?? RESOURCE_ENERGY) !== RESOURCE_ENERGY || currentEnergy(room) > 0
        );
        if (destinationFirst(destination, best)) {
            const source = sourceDispatcher.getTask(
                { creep, resourceType: destination!.resourceType ?? RESOURCE_ENERGY },
                task => !(task.target && destination!.target) || task.target !== destination!.target
            );
            if (source) best = source;
        }
    }
    setOrder(creep, best);
}

function destinationFirst(destination: Order | null, source: Order | null): boolean {
    if (!destination) return false;
    if (!source) return true;
    if (destination.priority !== source.priority) return destination.priority > source.priority;
    return destination.weight > source.weight;
}

/** Energy for builders / upgraders: best energy source of the room */
export function performGetEnergy(creep: Creep): void {
    performGetResources(creep, () => setOrder(creep, sourceDispatcher.getTask({ creep, resourceType: RESOURCE_ENERGY })));
}

registerRole("transporter", runTransporter);
