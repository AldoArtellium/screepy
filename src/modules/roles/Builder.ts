import {
    clearTargetCache,
    findEnergySource,
    idleNearSpawn,
    isCacheValid,
    REUSE_PATH,
    TARGET_CACHE_TICKS,
    updateEnergyState
} from "../../utils/creepUtils";

/**
 * Builder role - Construction and repair
 * Flexible role: accepts tasks when available, falls back to role behavior
 *
 * Phase-aware behavior:
 * - Phase 1: Prioritize containers
 * - Phase 2+: Prioritize extensions
 * - Defense mode: Repair walls/ramparts first
 */
class Builder {
    static run(creep: Creep) {
        // Use unified state management
        const state = updateEnergyState(creep);

        if (state === "acquiring") {
            if (creep.memory.state === "executing") {
                clearTargetCache(creep);
            }
            creep.memory.state = "acquiring";
            this.getEnergy(creep);
        } else {
            if (creep.memory.state === "acquiring") {
                clearTargetCache(creep);
            }
            creep.memory.state = "executing";
            this.build(creep);
        }
    }

    private static build(creep: Creep) {
        const room = creep.room;
        const phase = room.memory.phase ?? 0;
        const defenseMode = room.memory.defenseMode ?? false;

        // Check cached target first
        if (creep.memory.targetId && isCacheValid(creep)) {
            type BuildTarget = ConstructionSite | Structure;
            const cachedTarget = Game.getObjectById(creep.memory.targetId as Id<BuildTarget>);
            if (cachedTarget) {
                if ("progress" in cachedTarget) {
                    this.buildTarget(creep, cachedTarget);
                    return;
                } else if ("hits" in cachedTarget && cachedTarget.hits < cachedTarget.hitsMax) {
                    this.repairTarget(creep, cachedTarget);
                    return;
                }
            }
            clearTargetCache(creep);
        }

        // Defense mode: Repair walls/ramparts first
        if (defenseMode) {
            const damagedDefense = this.findDamagedDefense(room);
            if (damagedDefense) {
                this.cacheAndRepair(creep, damagedDefense);
                return;
            }
        }

        // Find construction site based on phase priorities
        const site = this.findConstructionSite(creep, phase);
        if (site) {
            this.cacheAndBuild(creep, site);
            return;
        }

        // No construction sites, repair damaged structures
        const damaged = this.findDamagedStructure(room, defenseMode);
        if (damaged) {
            this.cacheAndRepair(creep, damaged);
            return;
        }

        // Nothing to do - idle near spawn
        idleNearSpawn(creep);
    }

    private static findConstructionSite(creep: Creep, phase: number): ConstructionSite | null {
        // Phase-specific priority order
        const priorities: StructureConstant[][] = [];

        if (phase === 1) {
            priorities.push([STRUCTURE_CONTAINER]);
        }
        if (phase >= 2) {
            priorities.push([STRUCTURE_EXTENSION]);
        }
        priorities.push([STRUCTURE_CONTAINER]);
        if (phase >= 3) {
            priorities.push([STRUCTURE_TOWER]);
        }
        if (phase >= 4) {
            priorities.push([STRUCTURE_STORAGE]);
        }

        // Search each priority level
        for (const types of priorities) {
            const site = creep.pos.findClosestByPath(FIND_MY_CONSTRUCTION_SITES, {
                filter: s => types.includes(s.structureType)
            });
            if (site) return site;
        }

        // Any other construction site
        const sites = creep.room.find(FIND_MY_CONSTRUCTION_SITES);
        if (sites.length > 0) {
            // Sort by most progress (closest to completion)
            sites.sort((a, b) => b.progress - a.progress);
            return creep.pos.findClosestByPath(sites);
        }

        return null;
    }

    private static findDamagedDefense(room: Room): Structure | null {
        const defenses = room.find(FIND_STRUCTURES, {
            filter: s =>
                (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) &&
                s.hits < Math.min(s.hitsMax, 100000)
        });

        if (defenses.length === 0) return null;

        // Return lowest hits
        defenses.sort((a, b) => a.hits - b.hits);
        return defenses[0];
    }

    private static findDamagedStructure(room: Room, defenseMode: boolean): Structure | null {
        const filter = defenseMode
            ? (s: Structure) =>
                s.hits < s.hitsMax &&
                s.hits < 100000 &&
                (s.structureType === STRUCTURE_WALL ||
                 s.structureType === STRUCTURE_RAMPART ||
                 s.structureType === STRUCTURE_TOWER)
            : (s: Structure) =>
                s.hits < s.hitsMax &&
                s.hits < 100000 &&
                s.structureType !== STRUCTURE_WALL &&
                s.structureType !== STRUCTURE_RAMPART;

        const structures = room.find(FIND_STRUCTURES, { filter });

        if (structures.length === 0) {
            // Low priority: repair walls under 10k hits
            if (!defenseMode) {
                const walls = room.find(FIND_STRUCTURES, {
                    filter: s =>
                        (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) &&
                        s.hits < 10000
                });
                if (walls.length > 0) {
                    walls.sort((a, b) => a.hits - b.hits);
                    return walls[0];
                }
            }
            return null;
        }

        structures.sort((a, b) => a.hits - b.hits);
        return structures[0];
    }

    private static cacheAndBuild(creep: Creep, target: ConstructionSite) {
        creep.memory.targetId = target.id;
        creep.memory.targetTick = Game.time;
        this.buildTarget(creep, target);
    }

    private static cacheAndRepair(creep: Creep, target: Structure) {
        creep.memory.targetId = target.id;
        creep.memory.targetTick = Game.time;
        this.repairTarget(creep, target);
    }

    private static buildTarget(creep: Creep, target: ConstructionSite) {
        if (creep.pos.inRangeTo(target, 3)) {
            creep.build(target);
        } else {
            creep.moveTo(target, { reusePath: REUSE_PATH, visualizePathStyle: { stroke: "#ffffff" } });
        }
    }

    private static repairTarget(creep: Creep, target: Structure) {
        if (creep.pos.inRangeTo(target, 3)) {
            creep.repair(target);
        } else {
            creep.moveTo(target, { reusePath: REUSE_PATH, visualizePathStyle: { stroke: "#ffff00" } });
        }
    }

    private static getEnergy(creep: Creep) {
        const room = creep.room;
        const phase = room.memory.phase ?? 0;

        // Check cached target first
        if (creep.memory.targetId && isCacheValid(creep)) {
            type EnergyTarget = StructureContainer | StructureStorage | Resource;
            const cachedTarget = Game.getObjectById(creep.memory.targetId as Id<EnergyTarget>);

            if (cachedTarget) {
                if ("store" in cachedTarget && cachedTarget.store.getUsedCapacity(RESOURCE_ENERGY) > 200) {
                    this.withdrawFrom(creep, cachedTarget);
                    return;
                } else if ("resourceType" in cachedTarget) {
                    this.pickupFrom(creep, cachedTarget);
                    return;
                }
            }
            clearTargetCache(creep);
        }

        // Use shared energy finder
        const target = findEnergySource(creep, {
            includeStorage: phase >= 4,
            includeSources: false
        });

        if (target) {
            creep.memory.targetId = target.id;
            creep.memory.targetTick = Game.time;

            if ("resourceType" in target) {
                this.pickupFrom(creep, target);
            } else if ("store" in target) {
                this.withdrawFrom(creep, target as StructureContainer | StructureStorage);
            }
        }
    }

    private static withdrawFrom(creep: Creep, target: StructureContainer | StructureStorage) {
        if (creep.pos.isNearTo(target)) {
            creep.withdraw(target, RESOURCE_ENERGY);
        } else {
            creep.moveTo(target, { reusePath: REUSE_PATH });
        }
    }

    private static pickupFrom(creep: Creep, target: Resource) {
        if (creep.pos.isNearTo(target)) {
            creep.pickup(target);
        } else {
            creep.moveTo(target, { reusePath: REUSE_PATH });
        }
    }
}

export default Builder;
