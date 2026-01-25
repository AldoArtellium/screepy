import { log } from "../utils/logger";
import { RCL_EXTENSION_LIMITS } from "./RoomManager";

/**
 * ConstructionManager - Phase-aware construction planning
 * Handles extension placement, road planning, and other structures
 */
class ConstructionManager {
    private readonly MAX_CONSTRUCTION_SITES = 5; // Limit active sites per room

    /**
     * Main construction management function
     */
    manage(): void {
        for (const roomName in Game.rooms) {
            const room = Game.rooms[roomName];
            if (!room.controller?.my) continue;

            this.manageRoom(room);
        }
    }

    /**
     * Manage construction for a specific room
     */
    private manageRoom(room: Room): void {
        const phase = room.memory.phase ?? 0;
        const rcl = room.controller?.level ?? 0;
        const activeSites = room.find(FIND_MY_CONSTRUCTION_SITES).length;

        if (activeSites >= this.MAX_CONSTRUCTION_SITES) return;

        // Phase 1+: Plan source containers
        if (phase >= 1) {
            this.planSourceContainers(room);
        }

        // Phase 2+: Plan extensions
        if (phase >= 2 && rcl >= 2) {
            this.planExtensions(room);
        }

        // Phase 3+: Plan roads
        if (phase >= 3 && rcl >= 3) {
            this.planRoads(room);
        }

        // Phase 4+: Plan storage
        if (phase >= 4 && rcl >= 4) {
            this.planStorage(room);
        }

        // Phase 3+: Plan tower
        if (phase >= 3 && rcl >= 3) {
            this.planTower(room);
        }
    }

    /**
     * Plan containers near sources
     */
    private planSourceContainers(room: Room): void {
        const sources = room.find(FIND_SOURCES);

        for (const source of sources) {
            const sourceMemory = room.memory.sources?.[source.id];
            if (!sourceMemory) continue;

            // Skip if already has container or site
            if (sourceMemory.container || sourceMemory.containerSite) continue;

            // Find existing container near source
            const existingContainer = source.pos.findInRange(FIND_STRUCTURES, 1, {
                filter: s => s.structureType === STRUCTURE_CONTAINER
            })[0];

            if (existingContainer) {
                sourceMemory.container = existingContainer.id as Id<StructureContainer>;
                continue;
            }

            // Find existing construction site
            const existingSite = source.pos.findInRange(FIND_MY_CONSTRUCTION_SITES, 1, {
                filter: s => s.structureType === STRUCTURE_CONTAINER
            })[0];

            if (existingSite) {
                sourceMemory.containerSite = existingSite.id;
                continue;
            }

            // Find spawn to determine container position (between source and spawn)
            const spawn = room.find(FIND_MY_SPAWNS)[0];
            if (!spawn) continue;

            // Find best position for container (adjacent to source, towards spawn)
            const containerPos = this.findContainerPosition(source, spawn);
            if (containerPos) {
                const result = room.createConstructionSite(containerPos.x, containerPos.y, STRUCTURE_CONTAINER);
                if (result === OK) {
                    log.info("ConstructionManager", `${room.name}: Placed container site at ${containerPos.x},${containerPos.y} for source ${source.id}`);
                }
            }
        }
    }

    /**
     * Find best position for a container near a source
     */
    private findContainerPosition(source: Source, spawn: StructureSpawn): RoomPosition | null {
        const terrain = source.room.getTerrain();
        const positions: { pos: RoomPosition; distance: number }[] = [];

        // Check all adjacent positions
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if (dx === 0 && dy === 0) continue;

                const x = source.pos.x + dx;
                const y = source.pos.y + dy;

                // Skip walls and edges
                if (x < 1 || x > 48 || y < 1 || y > 48) continue;
                if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;

                // Check for existing structures
                const pos = new RoomPosition(x, y, source.room.name);
                const structures = pos.lookFor(LOOK_STRUCTURES);
                if (structures.length > 0) continue;

                const sites = pos.lookFor(LOOK_CONSTRUCTION_SITES);
                if (sites.length > 0) continue;

                positions.push({
                    pos,
                    distance: pos.getRangeTo(spawn)
                });
            }
        }

        // Sort by distance to spawn (closer is better for haulers)
        positions.sort((a, b) => a.distance - b.distance);
        return positions[0]?.pos ?? null;
    }

    /**
     * Plan extensions in a spiral pattern around spawn
     */
    private planExtensions(room: Room): void {
        const rcl = room.controller?.level ?? 0;
        const maxExtensions = RCL_EXTENSION_LIMITS[rcl] ?? 0;

        // Count current extensions and sites
        const currentExtensions = room.find(FIND_MY_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_EXTENSION
        }).length;

        const extensionSites = room.find(FIND_MY_CONSTRUCTION_SITES, {
            filter: s => s.structureType === STRUCTURE_EXTENSION
        }).length;

        const neededExtensions = maxExtensions - currentExtensions - extensionSites;
        if (neededExtensions <= 0) return;

        const spawn = room.find(FIND_MY_SPAWNS)[0];
        if (!spawn) return;

        // Generate spiral positions around spawn
        const positions = this.generateSpiralPositions(spawn.pos, room);

        // Place up to 3 extension sites at a time
        let placed = 0;
        for (const pos of positions) {
            if (placed >= Math.min(3, neededExtensions)) break;

            const result = room.createConstructionSite(pos.x, pos.y, STRUCTURE_EXTENSION);
            if (result === OK) {
                placed++;
                log.info("ConstructionManager", `${room.name}: Placed extension site at ${pos.x},${pos.y}`);
            }
        }
    }

    /**
     * Generate spiral positions around a center point
     */
    private generateSpiralPositions(center: RoomPosition, room: Room): RoomPosition[] {
        const terrain = room.getTerrain();
        const positions: RoomPosition[] = [];

        // Spiral outward from spawn (skip immediate adjacent to leave room for creeps)
        const maxRadius = 10;

        for (let radius = 2; radius <= maxRadius; radius++) {
            // Generate positions at this radius in spiral order
            for (let dx = -radius; dx <= radius; dx++) {
                for (let dy = -radius; dy <= radius; dy++) {
                    // Only consider positions on the edge of the square at this radius
                    if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;

                    const x = center.x + dx;
                    const y = center.y + dy;

                    // Skip edges and walls
                    if (x < 2 || x > 47 || y < 2 || y > 47) continue;
                    if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;

                    // Check for existing structures or sites
                    const pos = new RoomPosition(x, y, room.name);
                    const structures = pos.lookFor(LOOK_STRUCTURES);
                    if (structures.some(s => s.structureType !== STRUCTURE_ROAD)) continue;

                    const sites = pos.lookFor(LOOK_CONSTRUCTION_SITES);
                    if (sites.length > 0) continue;

                    positions.push(pos);
                }
            }
        }

        return positions;
    }

    /**
     * Plan roads from spawn to sources and controller
     */
    private planRoads(room: Room): void {
        if (room.memory.phaseData?.roadsPlanned) return;

        const spawn = room.find(FIND_MY_SPAWNS)[0];
        if (!spawn) return;

        const sources = room.find(FIND_SOURCES);
        const controller = room.controller;

        let roadsPlaced = 0;
        const maxRoadsPerTick = 5;

        // Plan roads to sources
        for (const source of sources) {
            if (roadsPlaced >= maxRoadsPerTick) break;

            const path = room.findPath(spawn.pos, source.pos, {
                ignoreCreeps: true,
                swampCost: 2,
                plainCost: 1
            });

            for (const step of path) {
                if (roadsPlaced >= maxRoadsPerTick) break;

                // Skip if near source or spawn
                if (spawn.pos.getRangeTo(step.x, step.y) <= 1) continue;
                if (source.pos.getRangeTo(step.x, step.y) <= 1) continue;

                const pos = new RoomPosition(step.x, step.y, room.name);

                // Skip if road already exists
                const existingRoad = pos.lookFor(LOOK_STRUCTURES).find(s => s.structureType === STRUCTURE_ROAD);
                if (existingRoad) continue;

                const existingSite = pos.lookFor(LOOK_CONSTRUCTION_SITES).find(s => s.structureType === STRUCTURE_ROAD);
                if (existingSite) continue;

                const result = room.createConstructionSite(step.x, step.y, STRUCTURE_ROAD);
                if (result === OK) {
                    roadsPlaced++;
                }
            }
        }

        // Plan roads to controller
        if (controller && roadsPlaced < maxRoadsPerTick) {
            const path = room.findPath(spawn.pos, controller.pos, {
                ignoreCreeps: true,
                swampCost: 2,
                plainCost: 1,
                range: 3
            });

            for (const step of path) {
                if (roadsPlaced >= maxRoadsPerTick) break;

                if (spawn.pos.getRangeTo(step.x, step.y) <= 1) continue;

                const pos = new RoomPosition(step.x, step.y, room.name);

                const existingRoad = pos.lookFor(LOOK_STRUCTURES).find(s => s.structureType === STRUCTURE_ROAD);
                if (existingRoad) continue;

                const existingSite = pos.lookFor(LOOK_CONSTRUCTION_SITES).find(s => s.structureType === STRUCTURE_ROAD);
                if (existingSite) continue;

                const result = room.createConstructionSite(step.x, step.y, STRUCTURE_ROAD);
                if (result === OK) {
                    roadsPlaced++;
                }
            }
        }

        // Mark roads as planned after initial batch
        if (roadsPlaced === 0) {
            room.memory.phaseData = room.memory.phaseData || { lastEvaluation: Game.time };
            room.memory.phaseData.roadsPlanned = true;
        }
    }

    /**
     * Plan storage structure
     */
    private planStorage(room: Room): void {
        // Check if storage already exists or is being built
        const existingStorage = room.find(FIND_MY_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_STORAGE
        });
        if (existingStorage.length > 0) return;

        const storageSite = room.find(FIND_MY_CONSTRUCTION_SITES, {
            filter: s => s.structureType === STRUCTURE_STORAGE
        });
        if (storageSite.length > 0) return;

        const spawn = room.find(FIND_MY_SPAWNS)[0];
        if (!spawn) return;

        // Find a good spot for storage near spawn
        const positions = this.generateSpiralPositions(spawn.pos, room);

        for (const pos of positions) {
            // Prefer positions 3-5 tiles from spawn
            const distance = pos.getRangeTo(spawn);
            if (distance < 3 || distance > 5) continue;

            const result = room.createConstructionSite(pos.x, pos.y, STRUCTURE_STORAGE);
            if (result === OK) {
                log.info("ConstructionManager", `${room.name}: Placed storage site at ${pos.x},${pos.y}`);
                return;
            }
        }
    }

    /**
     * Plan tower structure
     */
    private planTower(room: Room): void {
        const rcl = room.controller?.level ?? 0;

        // Tower limits by RCL: 3=1, 4=1, 5=2, 6=2, 7=3, 8=6
        const towerLimits: { [rcl: number]: number } = {
            3: 1, 4: 1, 5: 2, 6: 2, 7: 3, 8: 6
        };
        const maxTowers = towerLimits[rcl] ?? 0;

        const existingTowers = room.find(FIND_MY_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_TOWER
        }).length;

        const towerSites = room.find(FIND_MY_CONSTRUCTION_SITES, {
            filter: s => s.structureType === STRUCTURE_TOWER
        }).length;

        if (existingTowers + towerSites >= maxTowers) return;

        const spawn = room.find(FIND_MY_SPAWNS)[0];
        if (!spawn) return;

        // Place tower near spawn (but not too close)
        const positions = this.generateSpiralPositions(spawn.pos, room);

        for (const pos of positions) {
            const distance = pos.getRangeTo(spawn);
            if (distance < 2 || distance > 6) continue;

            const result = room.createConstructionSite(pos.x, pos.y, STRUCTURE_TOWER);
            if (result === OK) {
                log.info("ConstructionManager", `${room.name}: Placed tower site at ${pos.x},${pos.y}`);
                return;
            }
        }
    }
}

// Singleton instance
const constructionManagerInstance = new ConstructionManager();

export const constructionManagerModule = () => {
    constructionManagerInstance.manage();
};
