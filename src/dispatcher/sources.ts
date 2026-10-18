/**
 * Where creeps take resources from. Priorities and weights ported from Hivemind (MIT),
 * src/dispatcher/resource-source/*.ts (container, drop, grave, storage, overfull-extension).
 * Storage and terminal: see core/resources.ts (bestStorageSource / bestStorageTarget).
 */

import { whenInRange } from "../core/movement";
import {
    clearOrder,
    controllerContainer,
    creepsByRole,
    creepsWithOrder,
    currentEnergy,
    effectiveEnergy,
    mineralContainer,
    Order,
    roomBays,
    sourceContainer,
    storageLocation,
    structuresOfType
} from "../core/roomState";
import { roomPlanner } from "../planner/RoomPlanner";
import { bestStorageSource, bestStorageTarget } from "../core/resources";
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

type Withdrawable = StructureContainer | StructureStorage | StructureTerminal | StructureExtension | Tombstone | Ruin;

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

/**
 * Containers: 1, source containers 2, filling source containers 4; -3 per creep already on it.
 * Other resources 3 (-2 per creep) once there is a storage or terminal; the mineral container's own
 * mineral only from half full.
 */
class ContainerSource extends StoreSource {
    readonly type = "container";

    highestPriority(): number {
        return 4;
    }

    tasks(context: DispatchContext): Order[] {
        return [...this.energyTasks(context), ...this.resourceTasks(context)];
    }

    private resourceTasks(context: DispatchContext): Order[] {
        const room = context.creep.room;
        if (!room.storage && !room.terminal) return [];
        if (context.resourceType === RESOURCE_ENERGY) return [];
        const assigned = new Map<string, ResourceConstant>();
        for (const mineral of room.find(FIND_MINERALS)) {
            const container = mineralContainer(mineral);
            if (container) assigned.set(container.id, mineral.mineralType);
        }
        const tasks: Order[] = [];
        for (const container of structuresOfType<StructureContainer>(room, STRUCTURE_CONTAINER)) {
            if (container.store.getUsedCapacity() === container.store.energy) continue;
            for (const resourceType in container.store) {
                const amount = container.store[resourceType as ResourceConstant] ?? 0;
                if (resourceType === RESOURCE_ENERGY || amount === 0) continue;
                if (context.resourceType && context.resourceType !== resourceType) continue;
                if (assigned.get(container.id) === resourceType && amount < CONTAINER_CAPACITY / 2) continue;
                tasks.push({
                    type: this.type,
                    target: container.id,
                    resourceType: resourceType as ResourceConstant,
                    priority: 3 - creepsWithOrder(room, this.type, container.id).length * 2,
                    weight: amount / 20
                });
            }
        }
        return tasks;
    }

    private energyTasks(context: DispatchContext): Order[] {
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

/**
 * Storage or terminal (bestStorageSource): energy 2 for energy requests (non-transporters leave 5000 in
 * the storage), another requested resource 0, and the biggest resource of a terminal over 80% full
 * towards the storage 1 (3 when the terminal has no room left for 5000 energy)
 */
class StorageSource extends StoreSource {
    readonly type = "storage";

    highestPriority(): number {
        return 3;
    }

    tasks(context: DispatchContext): Order[] {
        const room = context.creep.room;
        if (!room.storage?.my) return [];
        const tasks: Order[] = [];
        if (context.resourceType === RESOURCE_ENERGY) {
            const source = bestStorageSource(room, RESOURCE_ENERGY);
            if (source && (context.creep.memory.role === "transporter" || source.store.energy > 5000 || source.id !== room.storage.id)) {
                tasks.push({ type: this.type, target: source.id, resourceType: RESOURCE_ENERGY, priority: 2, weight: 0 });
            }
        } else if (context.resourceType) {
            const source = bestStorageSource(room, context.resourceType);
            if (source) tasks.push({ type: this.type, target: source.id, resourceType: context.resourceType, priority: 0, weight: 0 });
        }
        const clearing = this.clearTerminalTask(context);
        if (clearing) tasks.push(clearing);
        return tasks;
    }

    private clearTerminalTask(context: DispatchContext): Order | null {
        const room = context.creep.room;
        const { storage, terminal } = room;
        if (!terminal?.my || !storage) return null;
        const noSpaceForEnergy = terminal.store.getFreeCapacity() + terminal.store.energy < 5000;
        if (terminal.store.getUsedCapacity() <= terminal.store.getCapacity() * 0.8 && !noSpaceForEnergy) return null;
        let best: ResourceConstant | null = null;
        for (const key in terminal.store) {
            const resourceType = key as ResourceConstant;
            if (context.resourceType && resourceType !== context.resourceType) continue;
            // Energy only when the storage has little, nor what is being prepared or would come straight back
            if (resourceType === RESOURCE_ENERGY && storage.store.energy > terminal.store.energy * 5) continue;
            if (resourceType === room.memory.fillTerminal) continue;
            if (bestStorageTarget(room, context.creep.store.getFreeCapacity(), resourceType)?.id === terminal.id) continue;
            if (!best || terminal.store[resourceType] > terminal.store[best]) best = resourceType;
        }
        if (!best) return null;
        return { type: this.type, target: terminal.id, resourceType: best, priority: noSpaceForEnergy ? 3 : 1, weight: 0 };
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

export const sourceDispatcher = new Dispatcher([
    new ContainerSource(),
    new DropSource(),
    new GraveSource(),
    new OverfullExtensionSource(),
    new StorageSource()
]);
