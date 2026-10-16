/**
 * Logistics layer types: offers (energy to take) and needs (energy to deliver), matched
 * greedily with reservations. See docs/superpowers/specs/2026-10-16-logistics-layer-design.md
 */

export type LogisticsKind = "offer" | "need";

/** Anything energy can be taken from or delivered to */
export type LogisticsTarget = AnyStoreStructure | Resource | Tombstone | Ruin;

export interface LogisticsRequest {
    /** `${kind}:${targetId}:${resourceType}` */
    id: string;
    kind: LogisticsKind;
    targetId: Id<LogisticsTarget>;
    pos: RoomPosition;
    resourceType: ResourceConstant;
    /** Effective amount: stock (offer) or free capacity (need), reservations deducted */
    amount: number;
    /** Lower = more important */
    priority: number;
    /** Controller container offer: only creeps on an upgrade task may take from it */
    upgradersOnly?: boolean;
}

/** A creep's claim on a request, kept in creep memory so it survives global resets */
export interface LogisticsReservation {
    kind: LogisticsKind;
    targetId: string;
    resourceType: ResourceConstant;
    amount: number;
    /** Tick of the reservation, for expiry */
    since: number;
}

declare global {
    interface CreepMemory {
        logistics?: LogisticsReservation;
        /** Worker temporarily hauling for the spawn/extensions */
        hauling?: boolean;
    }
}
