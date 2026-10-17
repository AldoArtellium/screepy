/**
 * Role registry: every creep carries `memory.role`; the creep runner calls the handler registered
 * for it each tick. Roles register their handler at load time:
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
