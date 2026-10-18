/**
 * Where carried resources go. Priorities and weights ported from Hivemind (MIT),
 * src/dispatcher/resource-destination/*.ts (spawn, bay, tower, container, worker-creep, storage, drop).
 */

import { whenInRange } from "../core/movement";
import {
    activeParts,
    clearOrder,
    controllerContainer,
    controllerRefillPathLength,
    creepsByRole,
    creepsWithOrder,
    hasEnemies,
    isInBay,
    Order,
    roomBays,
    storageLocation,
    structuresOfType
} from "../core/roomState";
import { cacheEmptyTasks, DispatchContext, Dispatcher, TaskProvider } from "./Dispatcher";

type EnergyStructure = StructureSpawn | StructureExtension | StructureTower | StructureContainer | StructureStorage;

function carriesEnergy(context: DispatchContext): boolean {
    return context.ignoreStoreContent || context.creep.store.energy > 0;
}

/** Base structure destination: valid while it has room; one transfer ends the order */
abstract class StructureDestination implements TaskProvider {
    abstract readonly type: string;
    abstract highestPriority(context: DispatchContext): number;
    abstract tasks(context: DispatchContext): Order[];

    isValid(task: Order, context: DispatchContext): boolean {
        const structure = Game.getObjectById(task.target as Id<EnergyStructure>);
        if (!structure || structure.room.name !== context.creep.room.name) return false;
        if ((structure.store.getFreeCapacity(task.resourceType ?? RESOURCE_ENERGY) ?? 0) <= 0) return false;
        return context.ignoreStoreContent || context.creep.store[task.resourceType ?? RESOURCE_ENERGY] > 0;
    }

    execute(task: Order, context: DispatchContext): void {
        const creep = context.creep;
        const resourceType = task.resourceType ?? RESOURCE_ENERGY;
        const structure = Game.getObjectById(task.target as Id<EnergyStructure>);
        if (!structure || creep.store[resourceType] === 0) {
            clearOrder(creep);
            return;
        }
        whenInRange(creep, 1, structure, () => {
            const amount = task.amount
                ? Math.min(task.amount, creep.store[resourceType], structure.store.getFreeCapacity(resourceType) ?? 0)
                : undefined;
            creep.transfer(structure, resourceType, amount);
            clearOrder(creep);
        });
    }
}

/** Spawns and extensions outside bays: spawn 5, extension 4 */
class SpawnDestination extends StructureDestination {
    readonly type = "spawn";

    highestPriority(): number {
        return 5;
    }

    tasks(context: DispatchContext): Order[] {
        if (context.resourceType && context.resourceType !== RESOURCE_ENERGY) return [];
        const creep = context.creep;
        const room = creep.room;
        return cacheEmptyTasks(`spawn:${room.name}`, () => {
            const rcl = room.controller?.level ?? 0;
            const targets = [
                ...structuresOfType<StructureSpawn>(room, STRUCTURE_SPAWN).filter(s => s.my && (rcl < 3 || !isInBay(room, s))),
                ...structuresOfType<StructureExtension>(room, STRUCTURE_EXTENSION).filter(s => s.my && !isInBay(room, s))
            ].filter(s => s.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
            return targets.map(target => {
                const free = target.store.getFreeCapacity(RESOURCE_ENERGY);
                const transporters = creepsWithOrder(room, this.type, target.id).filter(c => c.memory.role === "transporter");
                return {
                    type: this.type,
                    target: target.id,
                    resourceType: RESOURCE_ENERGY,
                    amount: free,
                    priority: (target.structureType === STRUCTURE_SPAWN ? 5 : 4) - transporters.length * 3,
                    weight:
                        Math.min(creep.store.energy, free) / creep.store.getCapacity() + 1 - creep.pos.getRangeTo(target) / 100
                };
            });
        });
    }
}

/** Bays: stand on the center, fill every spawn/extension around */
class BayDestination implements TaskProvider {
    readonly type = "bay";

    highestPriority(): number {
        return 5;
    }

    tasks(context: DispatchContext): Order[] {
        if (context.resourceType && context.resourceType !== RESOURCE_ENERGY) return [];
        const creep = context.creep;
        const room = creep.room;
        return cacheEmptyTasks(`bay:${room.name}`, () =>
            roomBays(room)
                .filter(bay => bay.energy < bay.energyCapacity)
                .map(bay => {
                    const missing = bay.energyCapacity - bay.energy;
                    return {
                        type: this.type,
                        name: bay.name,
                        resourceType: RESOURCE_ENERGY,
                        amount: missing,
                        priority: 5 - creepsWithOrder(room, this.type, bay.name).length * 3,
                        weight:
                            Math.min(creep.store.energy, missing) / creep.store.getCapacity() +
                            1 -
                            creep.pos.getRangeTo(bay.pos) / 100
                    };
                })
        );
    }

    isValid(task: Order, context: DispatchContext): boolean {
        const bay = roomBays(context.creep.room).find(b => b.name === task.name);
        if (!bay || bay.energy >= bay.energyCapacity || bay.hasHarvester()) return false;
        return carriesEnergy(context);
    }

    execute(task: Order, context: DispatchContext): void {
        const creep = context.creep;
        const bay = roomBays(creep.room).find(b => b.name === task.name);
        if (!bay || creep.store.energy === 0) {
            clearOrder(creep);
            return;
        }
        const arrived = whenInRange(creep, 0, bay.pos, () => {
            if (!bay.refillFrom(creep)) {
                clearOrder(creep);
                const exit = bay.exitPosition();
                if (exit) creep.move(creep.pos.getDirectionTo(exit));
            }
        });
        if (arrived) return;
        // On the way: fill an adjacent bay spawn/extension
        for (const structure of bay.structures) {
            if (structure.structureType !== STRUCTURE_SPAWN && structure.structureType !== STRUCTURE_EXTENSION) continue;
            if (structure.store.getFreeCapacity(RESOURCE_ENERGY) <= 0 || !creep.pos.isNearTo(structure)) continue;
            creep.transfer(structure, RESOURCE_ENERGY);
            return;
        }
    }
}

/** Towers below 80%: 3, +1 with enemies, +1 below 20% */
class TowerDestination extends StructureDestination {
    readonly type = "tower";

    highestPriority(): number {
        return 5;
    }

    tasks(context: DispatchContext): Order[] {
        if (context.resourceType && context.resourceType !== RESOURCE_ENERGY) return [];
        const room = context.creep.room;
        return cacheEmptyTasks(`tower:${room.name}`, () =>
            structuresOfType<StructureTower>(room, STRUCTURE_TOWER)
                .filter(t => t.my && t.store.energy < t.store.getCapacity(RESOURCE_ENERGY) * 0.8)
                .map(tower => {
                    const capacity = tower.store.getCapacity(RESOURCE_ENERGY);
                    let priority = 3;
                    if (hasEnemies(room)) priority++;
                    if (tower.store.energy < capacity * 0.2) priority++;
                    priority -= creepsWithOrder(room, this.type, tower.id).length * 2;
                    return {
                        type: this.type,
                        target: tower.id,
                        resourceType: RESOURCE_ENERGY,
                        amount: capacity - tower.store.energy,
                        priority,
                        weight: (capacity - tower.store.energy) / 100
                    };
                })
        );
    }
}

/** Upgrader energy that a delivery path consumes while the creep walks */
function upgradeWork(room: Room): number {
    return activeParts(creepsByRole(room.name, "upgrader"), WORK);
}

/** Controller container: 4, lowered when it needs little */
class ControllerContainerDestination implements TaskProvider {
    readonly type = "container";

    highestPriority(): number {
        return 4;
    }

    tasks(context: DispatchContext): Order[] {
        if (context.resourceType && context.resourceType !== RESOURCE_ENERGY) return [];
        const room = context.creep.room;
        return cacheEmptyTasks(`controllerContainer:${room.name}`, () => {
            const hasWorkers =
                creepsByRole(room.name, "upgrader").length > 0 || creepsByRole(room.name, "builder").length > 0;
            const container = controllerContainer(room);
            if (!hasWorkers || !container) return [];
            const incoming = _.sum(creepsWithOrder(room, this.type, container.id), c => c.store.energy);
            const needed =
                container.store.getFreeCapacity(RESOURCE_ENERGY) +
                upgradeWork(room) * UPGRADE_CONTROLLER_POWER * controllerRefillPathLength(room) -
                incoming;
            const capacity = container.store.getCapacity(RESOURCE_ENERGY);
            let priority = 4;
            if (needed / capacity < 0.5) priority -= 2;
            else if (needed / capacity < 0.75) priority -= 1;
            return [
                { type: this.type, target: container.id, resourceType: RESOURCE_ENERGY, amount: needed, priority, weight: needed / 100 }
            ];
        });
    }

    isValid(task: Order, context: DispatchContext): boolean {
        const creep = context.creep;
        const container = Game.getObjectById(task.target as Id<StructureContainer>);
        if (!container || container.room.name !== creep.room.name) return false;
        if (!carriesEnergy(context)) return false;
        if (container.store.getFreeCapacity(RESOURCE_ENERGY) === 0 && creep.pos.getRangeTo(container) <= 1) return false;
        const range = creep.pos.getRangeTo(container);
        const others = creepsWithOrder(creep.room, this.type, container.id).filter(
            c => c !== creep && c.pos.getRangeTo(container) <= range
        );
        const needed =
            container.store.getFreeCapacity(RESOURCE_ENERGY) + upgradeWork(creep.room) * range - _.sum(others, c => c.store.energy);
        return needed > 0;
    }

    execute(task: Order, context: DispatchContext): void {
        const creep = context.creep;
        const container = Game.getObjectById(task.target as Id<StructureContainer>);
        if (!container || creep.store.energy === 0) {
            clearOrder(creep);
            return;
        }
        whenInRange(creep, 1, container, () => {
            creep.transfer(container, RESOURCE_ENERGY);
            clearOrder(creep);
        });
    }
}

const WORKER_ROLE_WEIGHTS: { [role: string]: number } = { builder: 1.5, upgrader: 0.5 };

/** Direct delivery to builders/upgraders while the room has no storage: 2, -3 per deliverer */
class WorkerCreepDestination implements TaskProvider {
    readonly type = "workerCreep";

    highestPriority(): number {
        return 2;
    }

    tasks(context: DispatchContext): Order[] {
        if (context.resourceType && context.resourceType !== RESOURCE_ENERGY) return [];
        const creep = context.creep;
        const room = creep.room;
        if (room.storage || room.terminal) return [];
        return cacheEmptyTasks(`workerCreep:${room.name}`, () => {
            const tasks: Order[] = [];
            for (const role in WORKER_ROLE_WEIGHTS) {
                for (const worker of creepsByRole(room.name, role)) {
                    if (worker.spawning || worker.room.name !== room.name) continue;
                    const free = worker.store.getFreeCapacity(RESOURCE_ENERGY);
                    if (free < worker.store.getCapacity() / 3) continue;
                    tasks.push({
                        type: this.type,
                        target: worker.id,
                        resourceType: RESOURCE_ENERGY,
                        amount: creep.store.energy,
                        priority: 2 - creepsWithOrder(room, this.type, worker.id).length * 3,
                        weight: WORKER_ROLE_WEIGHTS[role] + Math.min(1, free / Math.max(1, creep.store.energy))
                    });
                }
            }
            return tasks;
        });
    }

    isValid(task: Order, context: DispatchContext): boolean {
        const worker = Game.getObjectById(task.target as Id<Creep>);
        if (!worker || worker.spawning || worker.room.name !== context.creep.room.name) return false;
        if (worker.store.getFreeCapacity(RESOURCE_ENERGY) < worker.store.getCapacity() / 5) return false;
        return carriesEnergy(context);
    }

    execute(task: Order, context: DispatchContext): void {
        const creep = context.creep;
        const worker = Game.getObjectById(task.target as Id<Creep>);
        if (!worker || creep.store.energy === 0) {
            clearOrder(creep);
            return;
        }
        whenInRange(creep, 1, worker, () => {
            const amount = Math.min(task.amount ?? creep.store.energy, creep.store.energy, worker.store.getFreeCapacity(RESOURCE_ENERGY));
            creep.transfer(worker, RESOURCE_ENERGY, amount);
            clearOrder(creep);
        });
    }
}

/** Storage: lowest priority sink */
class StorageDestination extends StructureDestination {
    readonly type = "storage";

    highestPriority(): number {
        return 0;
    }

    tasks(context: DispatchContext): Order[] {
        const creep = context.creep;
        const storage = creep.room.storage;
        if (!storage?.my) return [];
        const tasks: Order[] = [];
        for (const resourceType in creep.store) {
            const amount = creep.store[resourceType as ResourceConstant];
            if (!amount) continue;
            if (context.resourceType && context.resourceType !== resourceType) continue;
            tasks.push({ type: this.type, target: storage.id, resourceType: resourceType as ResourceConstant, amount, priority: 0, weight: amount / 100 });
        }
        return tasks;
    }
}

/** No storage yet: drop the energy on the base center, where the storage will be */
class DropDestination implements TaskProvider {
    readonly type = "drop";

    highestPriority(): number {
        return 0;
    }

    tasks(context: DispatchContext): Order[] {
        const creep = context.creep;
        if (creep.room.storage?.my || creep.room.terminal?.my) return [];
        const tasks: Order[] = [];
        for (const resourceType in creep.store) {
            const amount = creep.store[resourceType as ResourceConstant];
            if (!amount) continue;
            if (context.resourceType && context.resourceType !== resourceType) continue;
            tasks.push({ type: this.type, resourceType: resourceType as ResourceConstant, amount, priority: 0, weight: 0 });
        }
        return tasks;
    }

    isValid(task: Order, context: DispatchContext): boolean {
        return context.creep.store[task.resourceType ?? RESOURCE_ENERGY] > 0;
    }

    execute(task: Order, context: DispatchContext): void {
        const creep = context.creep;
        const resourceType = task.resourceType ?? RESOURCE_ENERGY;
        const location = storageLocation(creep.room);
        if (resourceType === RESOURCE_ENERGY && location && !creep.pos.isEqualTo(location)) {
            whenInRange(creep, 0, location, () => {
                if (creep.drop(resourceType) === OK) clearOrder(creep);
            });
            return;
        }
        if (creep.drop(resourceType) === OK) clearOrder(creep);
    }
}

export const destinationDispatcher = new Dispatcher([
    new BayDestination(),
    new ControllerContainerDestination(),
    new DropDestination(),
    new SpawnDestination(),
    new StorageDestination(),
    new TowerDestination(),
    new WorkerCreepDestination()
]);
