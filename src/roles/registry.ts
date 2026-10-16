/**
 * Role registry for module-driven creeps.
 *
 * Creeps spawned through spawnManager.requestSpawn() carry `memory.role`. TaskExecutor
 * runs the handler registered for that role every tick instead of the task system.
 * Modules register their handlers at load time:
 *
 *   registerRole("scout", creep => scoutManager.runScout(creep));
 *
 * A role without handler (e.g. its module is disabled) leaves the creep parked.
 */

export type RoleHandler = (creep: Creep) => void;

const handlers: Map<string, RoleHandler> = new Map();

export function registerRole(role: string, handler: RoleHandler): void {
    handlers.set(role, handler);
}

export function getRoleHandler(role: string): RoleHandler | undefined {
    return handlers.get(role);
}

/** Creeps that belong to the task system (no role) */
export function isTaskCreep(creep: Creep): boolean {
    return !creep.memory.role;
}
