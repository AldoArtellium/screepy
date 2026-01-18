import { REUSE_PATH } from "../../utils/creepUtils";
import { log } from "../../utils/logger";
import { ensureRoomMemory, findSourceContainer, findSourceContainerSite } from "../../utils/roomUtils";

/**
 * Miner role - Dedicated source mining
 * Strict role: always follows role logic, never accepts tasks
 *
 * Behavior:
 * - Assigns to unoccupied source
 * - Creates container construction site if needed
 * - Stands on container and harvests continuously
 */
class Miner {
    static run(creep: Creep) {
        if (!creep.memory.targetId) {
            this.assignSource(creep);
        } else {
            this.mine(creep);
        }
    }

    private static assignSource(creep: Creep) {
        // Ensure room memory is initialized
        const roomMemory = ensureRoomMemory(creep.room.name);
        const sources = roomMemory.sources ?? {};
        const sourceIds = Object.keys(sources) as Id<Source>[];
        let targetId: Id<Source> | undefined;

        for (const sourceId of sourceIds) {
            const sourceData = sources[sourceId];
            if (!sourceData) continue;

            const miners = sourceData.miners ?? [];
            // Only assign to sources with no miners (one miner per source)
            if (miners.length === 0) {
                targetId = sourceId;
                break;
            }
        }

        if (targetId) {
            // Ensure miners array exists
            if (!sources[targetId].miners) {
                sources[targetId].miners = [];
            }
            sources[targetId].miners.push(creep.name);
            creep.memory.targetId = targetId;

            const source = Game.getObjectById(targetId);
            if (source) {
                this.ensureContainerForSource(source, creep.room);
            }
        }
    }

    private static mine(creep: Creep) {
        const source = Game.getObjectById(creep.memory.targetId as Id<Source>);

        // Validate target - clear if source doesn't exist
        if (!source) {
            delete creep.memory.targetId;
            return;
        }

        // Use shared helper to find container
        const container = findSourceContainer(source);

        if (container) {
            if (creep.pos.isEqualTo(container.pos)) {
                // Already on container, harvest
                creep.harvest(source);
            } else {
                creep.moveTo(container, { reusePath: REUSE_PATH });
            }
        } else {
            // No container, check for construction site to stand on
            const constructionSite = findSourceContainerSite(source);

            if (constructionSite) {
                // Stand on the future container location
                if (creep.pos.isEqualTo(constructionSite.pos)) {
                    creep.harvest(source);
                } else {
                    creep.moveTo(constructionSite, { reusePath: REUSE_PATH });
                }
            } else {
                // No container or site, just get adjacent to source
                if (creep.pos.isNearTo(source)) {
                    creep.harvest(source);
                } else {
                    creep.moveTo(source, { reusePath: REUSE_PATH });
                }
            }
        }
    }

    private static findContainerPosition(source: Source, room: Room): RoomPosition | null {
        const terrain = room.getTerrain();
        const adjacentOffsets = [
            { x: -1, y: -1 }, { x: 0, y: -1 }, { x: 1, y: -1 },
            { x: -1, y: 0 },                   { x: 1, y: 0 },
            { x: -1, y: 1 },  { x: 0, y: 1 },  { x: 1, y: 1 }
        ];

        for (const offset of adjacentOffsets) {
            const x = source.pos.x + offset.x;
            const y = source.pos.y + offset.y;

            // Skip walls
            if (terrain.get(x, y) === TERRAIN_MASK_WALL) {
                continue;
            }

            const pos = new RoomPosition(x, y, room.name);

            // Skip tiles with existing structures
            const structures = pos.lookFor(LOOK_STRUCTURES);
            if (structures.length > 0) {
                continue;
            }

            // Skip tiles with existing construction sites
            const sites = pos.lookFor(LOOK_CONSTRUCTION_SITES);
            if (sites.length > 0) {
                continue;
            }

            return pos;
        }

        return null;
    }

    private static ensureContainerForSource(source: Source, room: Room): void {
        const roomMemory = ensureRoomMemory(room.name);
        const sourceMemory = roomMemory.sources?.[source.id];
        if (!sourceMemory) {
            return;
        }

        // Check if container already exists in memory and is still valid
        if (sourceMemory.container) {
            const container = Game.getObjectById(sourceMemory.container);
            if (container) {
                return;
            }
            // Container reference is stale, clear it
            delete sourceMemory.container;
        }

        // Check if container exists near source (not in memory yet)
        const existingContainer = findSourceContainer(source);
        if (existingContainer) {
            sourceMemory.container = existingContainer.id;
            return;
        }

        // Check if construction site already exists in memory and is still valid
        if (sourceMemory.containerSite) {
            const site = Game.getObjectById(sourceMemory.containerSite);
            if (site) {
                return;
            }
            // Site reference is stale (might have completed), check for container again
            const completedContainer = findSourceContainer(source);
            if (completedContainer) {
                sourceMemory.container = completedContainer.id;
                delete sourceMemory.containerSite;
                return;
            }
            delete sourceMemory.containerSite;
        }

        // Check if construction site exists near source (not in memory yet)
        const existingSite = findSourceContainerSite(source);
        if (existingSite) {
            sourceMemory.containerSite = existingSite.id;
            return;
        }

        // No container or site exists, create a new construction site
        const pos = this.findContainerPosition(source, room);
        if (!pos) {
            return;
        }

        const result = room.createConstructionSite(pos, STRUCTURE_CONTAINER);
        if (result === OK) {
            // Find the newly created site and store its ID
            const newSite = pos.lookFor(LOOK_CONSTRUCTION_SITES).find(
                (site) => site.structureType === STRUCTURE_CONTAINER
            );
            if (newSite) {
                sourceMemory.containerSite = newSite.id;
            }
        } else if (result === ERR_FULL) {
            log.warn("Miner", `Cannot create container site at ${pos}: construction sites limit reached`);
        }
    }
}

export default Miner;
