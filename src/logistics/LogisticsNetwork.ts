/**
 * LogisticsNetwork - per-room energy offers and needs, matched greedily with reservations.
 *
 * - Requests live in the heap and are rebuilt lazily, at most once per tick and room.
 * - Reservations live in creep memory (`creep.memory.logistics`) so they survive global resets.
 *   Effective offer = stock - reserved withdrawals; effective need = free capacity - reserved deliveries.
 * - Claiming a request lowers its heap amount immediately, so the next creep in the same tick sees it.
 */

import { BodyType } from "../config/bodyTypes";
import { ENERGY_THRESHOLDS } from "../utils/creepUtils";
import { countStat } from "../utils/stats";
import { LogisticsRequest, LogisticsReservation, LogisticsTarget } from "./types";

/** Need priorities (lower = more important). Defense: towers first. */
export const NEED_PRIORITY = {
    TOWER_DEFENSE: 0,
    SPAWN: 1,
    EXTENSION: 1,
    TOWER: 3,
    CONTROLLER_CONTAINER: 5,
    STORAGE: 9
} as const;

/** Offer priorities (lower = taken first): dropped energy decays, storage is the reserve */
const OFFER_PRIORITY = {
    DROPPED: 0,
    TOMBSTONE: 1,
    CONTAINER: 2,
    CONTROLLER_CONTAINER: 2,
    STORAGE: 3
} as const;

/** One priority step is worth this many tiles of walking */
const PRIORITY_WEIGHT = 10;

/** Energy non-haulers must leave in storage when the room has haulers */
export const STORAGE_FLOOR = 5000;

/** Reservations older than this are dropped (dead target, stuck creep...) */
const RESERVATION_TTL = 100;

/** Towers below this fill ratio post a need */
const TOWER_REFILL_RATIO = 0.8;

interface RoomRequests {
    tick: number;
    offers: LogisticsRequest[];
    needs: LogisticsRequest[];
    hasHaulers: boolean;
}

class LogisticsNetwork {
    private rooms: Map<string, RoomRequests> = new Map();

    /** Reserved amounts per target id (withdrawals out, deliveries in), rebuilt once per tick */
    private reserved: Map<string, { out: number; in: number }> = new Map();
    private reservedTick = -1;

    claimOffer(creep: Creep, opts: { forUpgrade?: boolean } = {}): LogisticsRequest | null {
        const requests = this.getRequests(creep.room);
        const free = creep.store.getFreeCapacity(RESOURCE_ENERGY);
        if (free <= 0) return null;

        const isHauler = creep.memory.bodyType === BodyType.TRANSPORT;
        let best: LogisticsRequest | null = null;
        let bestAvailable = 0;
        let bestScore = Infinity;

        for (const offer of requests.offers) {
            if (offer.upgradersOnly && !opts.forUpgrade) continue;
            let available = offer.amount;
            if (!isHauler && requests.hasHaulers && offer.priority === OFFER_PRIORITY.STORAGE) {
                available -= STORAGE_FLOOR;
            }
            if (available <= 0) continue;

            const range = creep.pos.getRangeTo(offer.pos);
            // Not worth crossing the room for a few units
            if (available < free * 0.5 && range > 3) {
                countStat("logistics:offerSkippedSmall");
                continue;
            }

            const score = offer.priority * PRIORITY_WEIGHT + range;
            if (score < bestScore) {
                bestScore = score;
                best = offer;
                bestAvailable = available;
            }
        }

        if (!best) return null;
        this.reserve(creep, best, Math.min(bestAvailable, free));
        countStat("logistics:offerClaimed");
        return best;
    }

    claimNeed(creep: Creep, opts: { maxPriority?: number } = {}): LogisticsRequest | null {
        const requests = this.getRequests(creep.room);
        const carried = creep.store.getUsedCapacity(RESOURCE_ENERGY);
        if (carried <= 0) return null;

        let best: LogisticsRequest | null = null;
        let bestScore = Infinity;
        for (const need of requests.needs) {
            if (need.amount <= 0) continue;
            if (opts.maxPriority !== undefined && need.priority > opts.maxPriority) continue;
            const score = need.priority * PRIORITY_WEIGHT + creep.pos.getRangeTo(need.pos);
            if (score < bestScore) {
                bestScore = score;
                best = need;
            }
        }

        if (!best) return null;
        this.reserve(creep, best, Math.min(best.amount, carried));
        countStat("logistics:needClaimed");
        return best;
    }

    /** Target of the creep's reservation; releases the reservation if the target is gone */
    getTarget(creep: Creep): LogisticsTarget | null {
        const reservation = creep.memory.logistics;
        if (!reservation) return null;
        const target = Game.getObjectById(reservation.targetId as Id<LogisticsTarget>);
        if (!target) this.release(creep);
        return target;
    }

    release(creep: Creep): void {
        const reservation = creep.memory.logistics;
        if (!reservation) return;
        // Keep this tick's heap view consistent for the next claimers
        const entry = this.reserved.get(reservation.targetId);
        if (entry && this.reservedTick === Game.time) {
            if (reservation.kind === "offer") entry.out -= reservation.amount;
            else entry.in -= reservation.amount;
        }
        delete creep.memory.logistics;
    }

    /** Whether a need at or above this priority (<= value) still lacks deliveries */
    hasUncoveredNeed(room: Room, maxPriority: number): boolean {
        return this.uncoveredNeedAmount(room, maxPriority) > 0;
    }

    /** Energy still missing on needs at or above this priority (<= value), reservations deducted */
    uncoveredNeedAmount(room: Room, maxPriority: number): number {
        return _.sum(this.getRequests(room).needs.filter(n => n.priority <= maxPriority), n => n.amount);
    }

    // ------------------------------------------------------------------ internals

    private reserve(creep: Creep, request: LogisticsRequest, amount: number): void {
        this.release(creep);
        const reservation: LogisticsReservation = {
            kind: request.kind,
            targetId: request.targetId,
            resourceType: request.resourceType,
            amount,
            since: Game.time
        };
        creep.memory.logistics = reservation;
        request.amount -= amount;
        this.addReserved(reservation);
    }

    private addReserved(reservation: LogisticsReservation): void {
        const entry = this.reserved.get(reservation.targetId) ?? { out: 0, in: 0 };
        if (reservation.kind === "offer") entry.out += reservation.amount;
        else entry.in += reservation.amount;
        this.reserved.set(reservation.targetId, entry);
    }

    /** Sum every live creep's reservation once per tick; drop expired ones */
    private refreshReservations(): void {
        if (this.reservedTick === Game.time) return;
        this.reservedTick = Game.time;
        this.reserved.clear();
        for (const name in Game.creeps) {
            const creep = Game.creeps[name];
            const reservation = creep.memory.logistics;
            if (!reservation) continue;
            if (Game.time - reservation.since > RESERVATION_TTL) {
                delete creep.memory.logistics;
                countStat("logistics:reservationExpired");
                continue;
            }
            this.addReserved(reservation);
        }
    }

    private getRequests(room: Room): RoomRequests {
        const cached = this.rooms.get(room.name);
        if (cached && cached.tick === Game.time) return cached;

        this.refreshReservations();
        const requests: RoomRequests = {
            tick: Game.time,
            offers: [],
            needs: [],
            hasHaulers: _.some(Game.creeps, c =>
                c.memory.bodyType === BodyType.TRANSPORT && (c.memory.room ?? c.room.name) === room.name
            )
        };
        this.buildOffers(room, requests.offers);
        this.buildNeeds(room, requests.needs);
        this.rooms.set(room.name, requests);
        return requests;
    }

    private push(list: LogisticsRequest[], kind: "offer" | "need", target: LogisticsTarget, amount: number,
        priority: number, upgradersOnly = false): void {
        const reserved = this.reserved.get(target.id);
        const effective = amount - (kind === "offer" ? reserved?.out ?? 0 : reserved?.in ?? 0);
        if (effective <= 0) return;
        list.push({
            id: `${kind}:${target.id}:${RESOURCE_ENERGY}`,
            kind,
            targetId: target.id as Id<LogisticsTarget>,
            pos: target.pos,
            resourceType: RESOURCE_ENERGY,
            amount: effective,
            priority,
            ...(upgradersOnly && { upgradersOnly })
        });
    }

    private buildOffers(room: Room, offers: LogisticsRequest[]): void {
        for (const r of room.find(FIND_DROPPED_RESOURCES)) {
            if (r.resourceType === RESOURCE_ENERGY && r.amount > ENERGY_THRESHOLDS.DROPPED_MIN) {
                this.push(offers, "offer", r, r.amount, OFFER_PRIORITY.DROPPED);
            }
        }
        for (const t of room.find(FIND_TOMBSTONES)) {
            const energy = t.store.getUsedCapacity(RESOURCE_ENERGY);
            if (energy > 0) this.push(offers, "offer", t, energy, OFFER_PRIORITY.TOMBSTONE);
        }
        for (const r of room.find(FIND_RUINS)) {
            const energy = r.store.getUsedCapacity(RESOURCE_ENERGY);
            if (energy > 0) this.push(offers, "offer", r, energy, OFFER_PRIORITY.TOMBSTONE);
        }
        for (const s of room.find(FIND_STRUCTURES)) {
            if (s.structureType !== STRUCTURE_CONTAINER) continue;
            const energy = s.store.getUsedCapacity(RESOURCE_ENERGY);
            if (energy <= 0) continue;
            if (this.isControllerContainer(room, s)) {
                this.push(offers, "offer", s, energy, OFFER_PRIORITY.CONTROLLER_CONTAINER, true);
            } else {
                this.push(offers, "offer", s, energy, OFFER_PRIORITY.CONTAINER);
            }
        }
        if (room.storage?.my) {
            const energy = room.storage.store.getUsedCapacity(RESOURCE_ENERGY);
            if (energy > 0) this.push(offers, "offer", room.storage, energy, OFFER_PRIORITY.STORAGE);
        }
    }

    private buildNeeds(room: Room, needs: LogisticsRequest[]): void {
        const defense = room.memory.defenseMode ?? false;
        for (const s of room.find(FIND_MY_STRUCTURES)) {
            if (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) {
                const free = s.store.getFreeCapacity(RESOURCE_ENERGY);
                if (free > 0) {
                    const priority = s.structureType === STRUCTURE_SPAWN
                        ? NEED_PRIORITY.SPAWN
                        : NEED_PRIORITY.EXTENSION;
                    this.push(needs, "need", s, free, priority);
                }
            } else if (s.structureType === STRUCTURE_TOWER) {
                const capacity = s.store.getCapacity(RESOURCE_ENERGY);
                const energy = s.store.getUsedCapacity(RESOURCE_ENERGY);
                if (energy < capacity * TOWER_REFILL_RATIO || (defense && energy < capacity)) {
                    this.push(needs, "need", s, capacity - energy, defense ? NEED_PRIORITY.TOWER_DEFENSE : NEED_PRIORITY.TOWER);
                }
            }
        }
        for (const s of room.find(FIND_STRUCTURES)) {
            if (s.structureType !== STRUCTURE_CONTAINER || !this.isControllerContainer(room, s)) continue;
            const free = s.store.getFreeCapacity(RESOURCE_ENERGY);
            if (free > 0) this.push(needs, "need", s, free, NEED_PRIORITY.CONTROLLER_CONTAINER);
        }
        if (room.storage?.my) {
            const free = room.storage.store.getFreeCapacity(RESOURCE_ENERGY);
            if (free > 0) this.push(needs, "need", room.storage, free, NEED_PRIORITY.STORAGE);
        }
    }

    /** Container within range 3 of the controller and not next to a source */
    private isControllerContainer(room: Room, container: StructureContainer): boolean {
        const controller = room.controller;
        if (!controller || !container.pos.inRangeTo(controller, 3)) return false;
        return !room.find(FIND_SOURCES).some(source => container.pos.inRangeTo(source, 2));
    }
}

export const logistics = new LogisticsNetwork();
