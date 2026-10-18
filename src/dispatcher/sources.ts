/**
 * Where creeps take resources from. Priorities and weights ported from Hivemind (MIT),
 * src/dispatcher/resource-source/*.ts (container, drop, grave, link, storage, overfull-extension).
 */

import { whenInRange } from "../core/movement";
import {
    clearOrder,
    controllerContainer,
    creepsByRole,
    creepsWithOrder,
    currentEnergy,
    effectiveEnergy,
    linkNetwork,
    Order,
    roomBays,
    sourceContainer,
    storageLocation,
    structuresOfType
} from "../core/roomState";
import { roomPlanner } from "../planner/RoomPlanner";
import { cacheEmptyTasks, DispatchContext, Dispatcher, TaskProvider } from "./Dispatcher";

/** Without storage, Hivemind counts 10 000 of "virtual" room for dropped resources */
const DEFAULT_STORAGE_LIMIT = 10000;

function freeStorage(room: Room): number {
    const storage = room.storage;
    if (!storage) return DEFAULT_STORAGE_LIMIT - currentEnergy(room);
    return storage.store.getFreeCapacity();
}

function wantsEnergy(context: DispatchContext): boolean {
    return !context.resourceType || context.resourceType === RESOURCE_ENERGY;
}

type Withdrawable = StructureContainer | StructureStorage | StructureExtension | StructureLink | Tombstone | Ruin;

/** Base withdraw source */
abstract class StoreSource implements TaskProvider {
    abstract readonly type: string;
    abstract highestPriority(context: DispatchContext): number;
    abstract tasks(context: DispatchContext): Order[];

    isValid(task: Order, context: DispatchContext): boolean {
        const resourceType = task.resourceType ?? RESOURCE_ENERGY;
        const target = Game.getObjectById(task.target as Id<Withdrawable>);
        if (!target || (target.store[resourceType] ?? 0) <= 0) return false;
        return context.creep.store.getFreeCapacity(resourceType) > 0;
    }

    execute(task: Order, context: DispatchContext): void {
        const creep = context.creep;
        const resourceType = task.resourceType ?? RESOURCE_ENERGY;
        const target = Game.getObjectById(task.target as Id<Withdrawable>);
        if (!target) {
            clearOrder(creep);
            return;
        }
        whenInRange(creep, 1, target, () => {
            const amount = task.amount
                ? Math.min(target.store[resourceType] ?? 0, task.amount, creep.store.getFreeCapacity(resourceType))
                : undefined;
            if (creep.withdraw(target, resourceType, amount) === OK) clearOrder(creep);
        });
    }
}

/** Containers: 1, source containers 2, filling source containers 4; -3 per creep already on it */
class ContainerSource extends StoreSource {
    readonly type = "container";

    highestPriority(): number {
        return 4;
    }

    tasks(context: DispatchContext): Order[] {
        if (!wantsEnergy(context)) return [];
        const creep = context.creep;
        const room = creep.room;
        const plan = roomPlanner.getPlan(room.name);
        const sourceContainers = new Set(room.find(FIND_SOURCES).map(s => sourceContainer(s)?.id));
        const controllerContainerId = controllerContainer(room)?.id;
        const hasWorkers =
            creepsByRole(room.name, "upgrader").length > 0 || creepsByRole(room.name, "builder").length > 0;
        const tasks: Order[] = [];
        for (const container of structuresOfType<StructureContainer>(room, STRUCTURE_CONTAINER)) {
            const energy = container.store.energy;
            if (energy <= creep.store.getCapacity() * 0.1) continue;
            if (container.id === controllerContainerId && hasWorkers && creep.memory.role === "transporter") continue;
            let priority = 1;
            if (sourceContainers.has(container.id)) {
                priority++;
                if (
                    container.store.getUsedCapacity() >= creep.store.getFreeCapacity() &&
                    (room.energyAvailable >= room.energyCapacityAvailable || !room.storage || creep.memory.role !== "transporter")
                ) {
                    priority += 2;
                }
            }
            // Leave the energy of a harvester bay container to its harvester
            if (plan?.has(container.pos, "harvester") && roomBays(room).some(b => b.pos.isEqualTo(container.pos))) {
                if (container.store.getUsedCapacity() < container.store.getCapacity() / 3) priority = -1;
            }
            priority -= creepsWithOrder(room, this.type, container.id).length * 3;
            tasks.push({ type: this.type, target: container.id, resourceType: RESOURCE_ENERGY, priority, weight: energy / 100 });
        }
        return tasks;
    }
}

/** Dropped resources: 4, less for small piles; the base-center pile is the transporters' last resort */
class DropSource implements TaskProvider {
    readonly type = "drop";

    highestPriority(): number {
        return 5;
    }

    tasks(context: DispatchContext): Order[] {
        const creep = context.creep;
        const room = creep.room;
        const location = storageLocation(room);
        const isTransporter = creep.memory.role === "transporter";
        const tasks: Order[] = [];
        for (const resource of room.find(FIND_DROPPED_RESOURCES)) {
            if (resource.amount < 10) continue;
            if (context.resourceType && context.resourceType !== resource.resourceType) continue;
            const isEnergy = resource.resourceType === RESOURCE_ENERGY;
            let priority = 4;
            if (resource.resourceType === RESOURCE_POWER) priority++;
            else if (isEnergy) {
                if (location && resource.pos.isEqualTo(location)) {
                    priority = isTransporter ? (room.storage || room.terminal ? 1 : 0) : 4;
                } else {
                    if (resource.amount < 100) priority--;
                    if (resource.amount < 200) priority--;
                    if (room.energyAvailable < room.energyCapacityAvailable && currentEnergy(room) > 5000 && isTransporter) priority -= 2;
                    if (room.storage && freeStorage(room) < resource.amount && effectiveEnergy(room) > 20000) priority -= 2;
                }
            }
            if ((room.storage || room.terminal) && freeStorage(room) < resource.amount) continue;
            if (resource.amount < creep.store.getCapacity() * 2) {
                priority -= creepsWithOrder(room, this.type, resource.id).length * 2;
            }
            tasks.push({
                type: this.type,
                target: resource.id,
                resourceType: resource.resourceType,
                priority,
                weight: resource.amount / (isEnergy ? 100 : 30)
            });
        }
        return tasks;
    }

    isValid(task: Order, context: DispatchContext): boolean {
        const resource = Game.getObjectById(task.target as Id<Resource>);
        if (!resource || resource.amount === 0) return false;
        return context.creep.store.getFreeCapacity(resource.resourceType) > 0;
    }

    execute(task: Order, context: DispatchContext): void {
        const resource = Game.getObjectById(task.target as Id<Resource>);
        if (!resource) {
            clearOrder(context.creep);
            return;
        }
        // The order stays: it becomes invalid once the creep is full or the pile is gone
        whenInRange(context.creep, 1, resource, () => context.creep.pickup(resource));
    }
}

/** Tombstones and ruins */
class GraveSource extends StoreSource {
    readonly type = "grave";

    highestPriority(): number {
        return 5;
    }

    tasks(context: DispatchContext): Order[] {
        const creep = context.creep;
        const room = creep.room;
        const isTransporter = creep.memory.role === "transporter";
        const tasks: Order[] = [];
        const graves: (Tombstone | Ruin)[] = [...room.find(FIND_TOMBSTONES), ...room.find(FIND_RUINS)];
        for (const grave of graves) {
            if (grave.store.getUsedCapacity() <= 10) continue;
            for (const resourceType in grave.store) {
                const amount = grave.store[resourceType as ResourceConstant];
                if (!amount) continue;
                if (context.resourceType && context.resourceType !== resourceType) continue;
                const isEnergy = resourceType === RESOURCE_ENERGY;
                let priority = 4;
                if (resourceType === RESOURCE_POWER) priority++;
                else if (isEnergy) {
                    if (amount < 100) priority--;
                    if (amount < 200) priority--;
                    if (room.energyAvailable < room.energyCapacityAvailable && currentEnergy(room) > 5000 && isTransporter) priority -= 2;
                    if (room.storage && freeStorage(room) < amount && effectiveEnergy(room) > 20000) priority -= 2;
                }
                if (freeStorage(room) < amount) continue;
                if (grave.store.getUsedCapacity() < creep.store.getCapacity() * 2) {
                    priority -= creepsWithOrder(room, this.type, grave.id).length * 2;
                }
                tasks.push({
                    type: this.type,
                    target: grave.id,
                    resourceType: resourceType as ResourceConstant,
                    priority,
                    weight: amount / (isEnergy ? 100 : 30)
                });
            }
        }
        return tasks;
    }
}

/** Storage energy, only for energy requests; non-transporters leave 5000 */
class StorageSource extends StoreSource {
    readonly type = "storage";

    highestPriority(): number {
        return 3;
    }

    tasks(context: DispatchContext): Order[] {
        const storage = context.creep.room.storage;
        if (!storage?.my || context.resourceType !== RESOURCE_ENERGY) return [];
        if (storage.store.energy <= 0) return [];
        if (context.creep.memory.role !== "transporter" && storage.store.energy <= 5000) return [];
        return [{ type: this.type, target: storage.id, resourceType: RESOURCE_ENERGY, priority: 2, weight: 0 }];
    }
}

/** Extensions holding more than their capacity (inactive after a downgrade) */
class OverfullExtensionSource extends StoreSource {
    readonly type = "overfullExtension";

    highestPriority(): number {
        return 5;
    }

    tasks(context: DispatchContext): Order[] {
        if (!wantsEnergy(context)) return [];
        const creep = context.creep;
        const room = creep.room;
        return cacheEmptyTasks(`overfullExtension:${room.name}`, () =>
            structuresOfType<StructureExtension>(room, STRUCTURE_EXTENSION)
                .filter(e => e.my && e.store.energy > e.store.getCapacity(RESOURCE_ENERGY))
                .map(extension => ({
                    type: this.type,
                    target: extension.id,
                    resourceType: RESOURCE_ENERGY,
                    priority: 5 - creepsWithOrder(room, this.type, extension.id).length * 2,
                    weight: 1 - creep.pos.getRangeTo(extension) / 100
                }))
        );
    }
}

/**
 * Neutral links (storage link) while the link network holds more than it wants: 5, -1 beyond 10
 * tiles, -2 per creep already on it (Hivemind resource-source/link.ts)
 */
class LinkSource extends StoreSource {
    readonly type = "link";

    highestPriority(): number {
        return 5;
    }

    tasks(context: DispatchContext): Order[] {
        if (!wantsEnergy(context)) return [];
        const creep = context.creep;
        const room = creep.room;
        const network = linkNetwork(room);
        if (!network) return [];
        return cacheEmptyTasks(`link:${room.name}`, () =>
            network.neutral
                .filter(link => link.store.energy > 0)
                .map(link => {
                    let priority = 5;
                    if (creep.pos.getRangeTo(link) > 10) priority--;
                    priority -= creepsWithOrder(room, this.type, link.id).length * 2;
                    return { type: this.type, target: link.id, resourceType: RESOURCE_ENERGY, priority, weight: link.store.energy / 100 };
                })
        );
    }

    isValid(task: Order, context: DispatchContext): boolean {
        const network = linkNetwork(context.creep.room);
        if (!network || network.energy <= network.maxEnergy) return false;
        return super.isValid(task, context);
    }
}

export const sourceDispatcher = new Dispatcher([
    new ContainerSource(),
    new DropSource(),
    new GraveSource(),
    new LinkSource(),
    new OverfullExtensionSource(),
    new StorageSource()
]);
