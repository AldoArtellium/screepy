import { REUSE_PATH } from "../../utils/creepUtils";
import { getSpawn } from "../../utils/roomUtils";

/**
 * Defender role - Combat
 * Strict role: always follows role logic, never accepts tasks
 *
 * Behavior:
 * - Attack hostiles with priority targeting (healers > ranged > melee)
 * - When idle, position on ramparts or patrol room exits
 * - Recycle self when threat subsides for 300+ ticks
 */
class Defender {
    static run(creep: Creep) {
        const targets = creep.room.find(FIND_HOSTILE_CREEPS);

        if (targets.length > 0) {
            // Clear patrol state when engaging
            delete creep.memory.patrolIndex;

            // Use priority targeting (healers > ranged > melee)
            const priorityTarget = this.findPriorityTarget(targets);
            creep.say("X");

            if (creep.attack(priorityTarget) === ERR_NOT_IN_RANGE) {
                creep.moveTo(priorityTarget, { visualizePathStyle: { stroke: "#ff0000" } });
            }
        } else {
            // Recycle if no threat for 300+ ticks
            if (Game.time - (creep.room.memory.threatLevelLastTick ?? 0) > 300) {
                const spawn = getSpawn(creep.room);
                if (spawn) {
                    creep.say("R");
                    if (spawn.recycleCreep(creep) === ERR_NOT_IN_RANGE) {
                        creep.moveTo(spawn);
                    }
                }
            } else {
                // Try ramparts first, then patrol
                if (!this.positionOnRampart(creep)) {
                    this.patrol(creep);
                }
            }
        }
    }

    private static findPriorityTarget(hostiles: Creep[]): Creep {
        return hostiles.sort((a, b) => {
            const aPoints = this.evaluateThreatLevel(a);
            const bPoints = this.evaluateThreatLevel(b);
            if (aPoints === bPoints) {
                return a.hits - b.hits; // Lower health = higher priority
            }
            return bPoints - aPoints;
        })[0];
    }

    private static evaluateThreatLevel(creep: Creep): number {
        let threat = 0;
        for (const part of creep.body) {
            switch (part.type) {
                case HEAL: threat += 12; break;
                case RANGED_ATTACK: threat += 8; break;
                case ATTACK: threat += 5; break;
                case WORK: threat += 3; break;
                case CLAIM: threat += 15; break;
            }
        }
        return threat;
    }

    private static positionOnRampart(creep: Creep): boolean {
        // Check if already on a rampart
        const currentStructures = creep.pos.lookFor(LOOK_STRUCTURES);
        const onRampart = currentStructures.some(s => s.structureType === STRUCTURE_RAMPART);

        if (onRampart) {
            creep.say("S");
            return true;
        }

        const ramparts = creep.room.find(FIND_MY_STRUCTURES, {
            filter: (s): s is StructureRampart => s.structureType === STRUCTURE_RAMPART
        });

        if (ramparts.length === 0) {
            return false; // No ramparts, should patrol instead
        }

        // Get cached occupancy or build it
        const occupiedPositions = this.getOccupiedPositions(creep);

        const availableRamparts = ramparts.filter(
            r => !occupiedPositions.has(`${r.pos.x},${r.pos.y}`)
        );

        if (availableRamparts.length === 0) {
            return false; // All ramparts occupied, should patrol
        }

        // Prefer ramparts near spawn for strategic positioning
        const spawn = getSpawn(creep.room);
        const targetRampart = spawn
            ? availableRamparts.reduce((closest, r) =>
                r.pos.getRangeTo(spawn) < closest.pos.getRangeTo(spawn) ? r : closest
            )
            : availableRamparts[0];

        creep.moveTo(targetRampart, { visualizePathStyle: { stroke: "#00ff00" } });
        return true;
    }

    private static getOccupiedPositions(creep: Creep): Set<string> {
        // Build occupancy set from other creeps (excluding self)
        const occupied = new Set<string>();
        for (const otherCreep of creep.room.find(FIND_MY_CREEPS)) {
            if (otherCreep.id !== creep.id) {
                occupied.add(`${otherCreep.pos.x},${otherCreep.pos.y}`);
            }
        }
        return occupied;
    }

    private static patrol(creep: Creep) {
        const patrolPoints = this.getPatrolPoints(creep.room);

        if (patrolPoints.length === 0) {
            // No patrol points, stay near spawn
            const spawn = getSpawn(creep.room);
            if (spawn && creep.pos.getRangeTo(spawn) > 3) {
                creep.moveTo(spawn);
            }
            return;
        }

        // Initialize or get current patrol index
        if (creep.memory.patrolIndex === undefined) {
            creep.memory.patrolIndex = 0;
        }

        const targetPoint = patrolPoints[creep.memory.patrolIndex];
        const targetPos = new RoomPosition(targetPoint.x, targetPoint.y, creep.room.name);

        creep.say("P");

        // Move to current patrol point
        if (creep.pos.getRangeTo(targetPos) <= 1) {
            // Reached patrol point, move to next
            creep.memory.patrolIndex = (creep.memory.patrolIndex + 1) % patrolPoints.length;
        } else {
            creep.moveTo(targetPos, { visualizePathStyle: { stroke: "#ffff00" } });
        }
    }

    private static getPatrolPoints(room: Room): { x: number; y: number }[] {
        // Cache patrol points in room memory (refresh every 1000 ticks)
        if (room.memory.patrolPoints && Game.time % 1000 !== 0) {
            return room.memory.patrolPoints;
        }

        const points: { x: number; y: number }[] = [];
        const spawn = getSpawn(room);
        const controller = room.controller;

        // Add points near room exits (5 tiles inside from each exit)
        const exits = Game.map.describeExits(room.name);

        if (exits) {
            // Define exit directions with their FIND constants and offsets
            const exitConfigs: Array<{
                exitKey: ExitKey;
                findConst: FindConstant;
                yOffset: number;
                xOffset: number;
            }> = [
                { exitKey: "1", findConst: FIND_EXIT_TOP, yOffset: 5, xOffset: 0 },
                { exitKey: "3", findConst: FIND_EXIT_RIGHT, yOffset: 0, xOffset: -5 },
                { exitKey: "5", findConst: FIND_EXIT_BOTTOM, yOffset: -5, xOffset: 0 },
                { exitKey: "7", findConst: FIND_EXIT_LEFT, yOffset: 0, xOffset: 5 }
            ];

            for (const { exitKey, findConst, yOffset, xOffset } of exitConfigs) {
                if (exits[exitKey]) {
                    const exitTiles = room.find(findConst) as RoomPosition[];
                    if (exitTiles.length > 0) {
                        const midExit = exitTiles[Math.floor(exitTiles.length / 2)];
                        const x = Math.max(5, Math.min(44, midExit.x + xOffset));
                        const y = Math.max(5, Math.min(44, midExit.y + yOffset));
                        points.push({ x, y });
                    }
                }
            }
        }

        // Add spawn position as a patrol point (home base)
        if (spawn) {
            points.push({ x: spawn.pos.x, y: spawn.pos.y });
        }

        // Add controller position (important to defend)
        if (controller) {
            points.push({ x: controller.pos.x, y: controller.pos.y });
        }

        // Sort points to create efficient patrol route (nearest neighbor from spawn)
        const sortedPoints = this.sortPatrolRoute(points, spawn?.pos);

        room.memory.patrolPoints = sortedPoints;
        return sortedPoints;
    }

    private static sortPatrolRoute(
        points: { x: number; y: number }[],
        start?: RoomPosition
    ): { x: number; y: number }[] {
        if (points.length <= 2) return points;

        const sorted: { x: number; y: number }[] = [];
        const remaining = [...points];

        // Start from spawn or first point
        let current = start
            ? { x: start.x, y: start.y }
            : remaining.shift()!;

        if (!start) {
            sorted.push(current);
        }

        // Simple greedy nearest neighbor
        while (remaining.length > 0) {
            let nearestIdx = 0;
            let nearestDist = Infinity;

            for (let i = 0; i < remaining.length; i++) {
                const dist = Math.abs(remaining[i].x - current.x) +
                             Math.abs(remaining[i].y - current.y);
                if (dist < nearestDist) {
                    nearestDist = dist;
                    nearestIdx = i;
                }
            }

            current = remaining.splice(nearestIdx, 1)[0];
            sorted.push(current);
        }

        return sorted;
    }
}

export default Defender;
