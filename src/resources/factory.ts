/**
 * Factory: production choice per room (factoryPlan.ts, pure), components for the dispatcher (factory
 * destination and source, Hivemind resource-destination/factory.ts and resource-source/factory.ts) and
 * the produce() module (Hivemind process/rooms/owned/factory.ts). Hivemind (MIT), with the deviations
 * listed in factoryPlan.ts and docs/decisions/resources.md.
 */

import { totalResources } from "../core/resources";
import { structuresOfType } from "../core/roomState";
import { chainDeficits } from "../labs/chain";
import { demandTargetsOf, labResources } from "../labs/reactions";
import { tradeValue } from "../modules/MarketManager";
import { countStat } from "../utils/stats";
import { log } from "../utils/logger";
import { chooseFactoryJob, compressionPays, FactoryJob, FactoryRecipe, FactoryState, levelZeroRecipes, requestedComponents } from "./factoryPlan";

/** The job is chosen again after this many ticks (Hivemind getJobs: 50) */
const JOB_TICKS = 100;
/** Whether a room's mineral pays a factory, heap cache */
const WANTED_TICKS = 5000;

let recipesCache: FactoryRecipe[] | undefined;
function recipes(): FactoryRecipe[] {
    recipesCache ??= levelZeroRecipes(COMMODITIES as unknown as Parameters<typeof levelZeroRecipes>[0]);
    return recipesCache;
}

const jobs: Map<string, { until: number; job: FactoryJob | null }> = new Map();
const wanted: Map<string, { until: number; wanted: boolean }> = new Map();

export function factoryOf(room: Room): StructureFactory | undefined {
    // One factory from RCL 7: active whenever the controller allows one (isActive walks the whole room)
    if ((room.controller?.level ?? 0) < 7) return undefined;
    const factory = structuresOfType<StructureFactory>(room, STRUCTURE_FACTORY)[0];
    return factory?.my ? factory : undefined;
}

declare global {
    interface Memory {
        /** Credits per unit used instead of the market for the factory (mockup: no market orders; or to force a recipe) */
        factoryPrices?: { [resourceType: string]: number };
    }
}

const prices = {
    inputValue: (r: string) => Memory.factoryPrices?.[r] ?? tradeValue(r as ResourceConstant, "input"),
    productValue: (r: string) => Memory.factoryPrices?.[r] ?? tradeValue(r as ResourceConstant, "product")
};

function factoryState(room: Room): FactoryState {
    const stock = totalResources(room);
    let deficits: { [resourceType: string]: number } | undefined;
    return {
        ...prices,
        stock: r => stock[r] ?? 0,
        labDeficit: r => {
            deficits ??= chainDeficits(
                demandTargetsOf(room).map(t => [t.compound, t.amount]),
                resourceType => labResources(room)[resourceType] ?? 0
            );
            return Math.max(0, deficits[r] ?? 0);
        }
    };
}

/** The room's current job (chosen every JOB_TICKS, dropped once its batches are done) */
export function factoryJob(room: Room): FactoryJob | null {
    const cached = jobs.get(room.name);
    if (cached && cached.until > Game.time && (!cached.job || cached.job.batches > 0)) return cached.job;
    const job = room.terminal?.my ? chooseFactoryJob(recipes(), factoryState(room)) : null;
    jobs.set(room.name, { until: Game.time + JOB_TICKS, job });
    return job;
}

/** What the factory should hold for the current job (dispatcher factory destination and source) */
export function factoryComponents(room: Room): { [resourceType: string]: number } {
    const job = factoryJob(room);
    const recipe = job && recipes().find(r => r.product === job.product);
    return recipe ? requestedComponents(recipe, job.batches) : {};
}

/**
 * Whether the room should build its factory (RoomBuilder): a terminal to sell the bars and a mineral of its
 * own whose bar pays at today's prices. Not in Hivemind (constructFactories: every room); a factory costs
 * 100k energy and only W28N7 (K) of shard0's 7 rooms mined a mineral worth compressing on 2026-11-15.
 */
export function factoryWanted(room: Room): boolean {
    if (!room.terminal?.my) return false;
    const cached = wanted.get(room.name);
    if (cached && cached.until > Game.time) return cached.wanted;
    const mineral = room.find(FIND_MINERALS)[0]?.mineralType;
    const result = !!mineral && compressionPays(recipes(), mineral, prices);
    wanted.set(room.name, { until: Game.time + WANTED_TICKS, wanted: result });
    return result;
}

/**
 * Resources a factory's current job takes (MarketManager: not sold meanwhile): the mineral a bar is made
 * from sells for less than the bar, a bar decompressed for the labs is not sold
 */
export function factoryInputs(): Set<string> {
    const result = new Set<string>();
    for (const name in Game.rooms) {
        const room = Game.rooms[name];
        if (!room.controller?.my || !factoryOf(room)) continue;
        for (const resourceType in factoryComponents(room)) if (resourceType !== RESOURCE_ENERGY) result.add(resourceType);
    }
    return result;
}

function hasComponents(factory: StructureFactory, recipe: FactoryRecipe): boolean {
    for (const resourceType in recipe.components) {
        if ((factory.store[resourceType as ResourceConstant] ?? 0) < recipe.components[resourceType]) return false;
    }
    return true;
}

/** Produces the current job in every room with a factory off cooldown (priority low) */
export const factoryModule = (): void => {
    for (const name in Game.rooms) {
        const room = Game.rooms[name];
        if (!room.controller?.my) continue;
        const factory = factoryOf(room);
        if (!factory || factory.cooldown > 0) continue;
        const job = factoryJob(room);
        const recipe = job && recipes().find(r => r.product === job.product);
        if (!job || !recipe || !hasComponents(factory, recipe)) continue;
        const result = factory.produce(job.product as CommodityConstant);
        if (result === OK) {
            job.batches--;
            countStat(`factory:${job.product}`, recipe.amount);
        } else {
            log.warn("Factory", `${room.name}: produce ${job.product}: ${result}`);
            jobs.delete(room.name);
        }
    }
};
