/**
 * Factory production choice (pure, offline check: tests/factory/run.mjs), used by resources/factory.ts.
 *
 * Level 0 recipes only (no power creep): bars (500 mineral + 200 energy -> 100 bars), battery and their
 * reverse. One recipe at a time per room. Rules (Hivemind factory-manager.ts isRecipeAvailable, with
 * deviations, docs/decisions/resources.md):
 * 1. a bar is decompressed while the labs' chain lacks its mineral (Hivemind: below 2000 of the mineral);
 * 2. batteries are decompressed while the room's energy is below ENERGY_LOW (Hivemind: same, 10 000);
 * 3. a base mineral the labs' chain doesn't lack is compressed down to KEEP_MINERAL, once the bar sells for
 *    at least MIN_MARGIN x its inputs. Hivemind compresses only at 95% storage use; shard0 2026-11-15
 *    never fills (storage ~10%, terminal <= 18%) but a keanium bar sold at 638-737 for 500 K at 53-61.
 * Energy is never compressed into batteries: it funds upgrading, and 600 energy at the best buy order
 * (96) were worth more than 50 batteries (909) on shard0 2026-11-15.
 */

export interface FactoryRecipe {
    product: string;
    amount: number;
    cooldown: number;
    components: { [resourceType: string]: number };
}

/** COMMODITIES entries without a level (level 0), by product */
export function levelZeroRecipes(commodities: { [product: string]: { amount: number; cooldown: number; level?: number; components: { [r: string]: number } } }): FactoryRecipe[] {
    const result: FactoryRecipe[] = [];
    for (const product in commodities) {
        const recipe = commodities[product];
        if (recipe.level) continue;
        result.push({ product, amount: recipe.amount, cooldown: recipe.cooldown, components: recipe.components });
    }
    return result;
}

/** Base mineral -> bar (compression recipes); the reverse recipes have the bar as their only non-energy component */
export const BARS: { [mineral: string]: string } = {
    U: "utrium_bar",
    L: "lemergium_bar",
    K: "keanium_bar",
    Z: "zynthium_bar",
    G: "ghodium_melt",
    O: "oxidant",
    H: "reductant",
    X: "purifier"
};

/** Mineral kept per room: the MarketManager sells base minerals above this (STORAGE_CAPACITY / 50) */
export const KEEP_MINERAL = 20000;
/** A bar is made only when it sells for at least this many times its inputs */
export const MIN_MARGIN = 1.2;
/** Energy below this: no compression; batteries are decompressed */
export const ENERGY_LOW = 10000;
/** Compression stops when the room's energy would fall below this */
export const ENERGY_FLOOR = 20000;
/** Hivemind factoryFillTime: the factory holds components for this many ticks of production */
export const FILL_TIME = 500;

export interface FactoryState {
    /** Storage + terminal + factory of the room */
    stock: (resourceType: string) => number;
    /** What the labs' chain lacks of a resource (labs/chain.ts chainDeficits, 0 when nothing) */
    labDeficit: (resourceType: string) => number;
    /** Credits per unit of a recipe input (what selling it now pays: the higher of average and best buy) */
    inputValue: (resourceType: string) => number | undefined;
    /** Credits per unit of a product (what it sells for, conservatively: the lower of average and best buy) */
    productValue: (resourceType: string) => number | undefined;
}

export interface FactoryJob {
    product: string;
    /** Number of produce() calls to make */
    batches: number;
}

/** Product value over input value of a recipe, undefined without prices */
export function recipeMargin(recipe: FactoryRecipe, state: Pick<FactoryState, "inputValue" | "productValue">): number | undefined {
    const out = state.productValue(recipe.product);
    if (!out) return undefined;
    let cost = 0;
    for (const resourceType in recipe.components) {
        const value = state.inputValue(resourceType);
        if (value === undefined) return undefined;
        cost += value * recipe.components[resourceType];
    }
    return cost > 0 ? (out * recipe.amount) / cost : undefined;
}

function find(recipes: FactoryRecipe[], product: string): FactoryRecipe | undefined {
    return recipes.find(r => r.product === product);
}

/** Batches the stock allows: each component divided by what one batch takes */
function affordable(recipe: FactoryRecipe, available: (resourceType: string) => number): number {
    let batches = Infinity;
    for (const resourceType in recipe.components) batches = Math.min(batches, Math.floor(available(resourceType) / recipe.components[resourceType]));
    return Number.isFinite(batches) ? Math.max(0, batches) : 0;
}

/** Whether compressing this mineral pays at today's prices (RoomBuilder: build a factory where it does) */
export function compressionPays(recipes: FactoryRecipe[], mineral: string, state: Pick<FactoryState, "inputValue" | "productValue">): boolean {
    const bar = BARS[mineral];
    const recipe = bar ? find(recipes, bar) : undefined;
    if (!recipe) return false;
    const margin = recipeMargin(recipe, state);
    return margin !== undefined && margin >= MIN_MARGIN;
}

/** The recipe to run in a room, or null */
export function chooseFactoryJob(recipes: FactoryRecipe[], state: FactoryState): FactoryJob | null {
    const energy = state.stock("energy");
    // 1. Bars whose mineral the labs lack
    for (const mineral in BARS) {
        const need = state.labDeficit(mineral);
        if (need <= 0) continue;
        const recipe = find(recipes, mineral);
        if (!recipe || state.stock(BARS[mineral]) < (recipe.components[BARS[mineral]] ?? Infinity)) continue;
        const batches = Math.min(Math.ceil(need / recipe.amount), affordable(recipe, state.stock));
        if (batches > 0) return { product: mineral, batches };
    }
    // 2. Batteries back to energy when the room runs low
    if (energy < ENERGY_LOW) {
        const recipe = find(recipes, "energy");
        const batches = recipe ? Math.min(Math.ceil((ENERGY_LOW - energy) / recipe.amount), affordable(recipe, state.stock)) : 0;
        if (recipe && batches > 0) return { product: "energy", batches };
    }
    // 3. The surplus mineral whose bar pays most
    let best: { job: FactoryJob; margin: number } | null = null;
    for (const mineral in BARS) {
        const recipe = find(recipes, BARS[mineral]);
        if (!recipe) continue;
        // A deficit is counted after the stock: the labs already lack this mineral
        if (state.labDeficit(mineral) > 0) continue;
        const surplus = state.stock(mineral) - KEEP_MINERAL;
        if (surplus < (recipe.components[mineral] ?? Infinity)) continue;
        const margin = recipeMargin(recipe, state);
        if (margin === undefined || margin < MIN_MARGIN) continue;
        const available = (r: string) => (r === mineral ? surplus : r === "energy" ? Math.max(0, energy - ENERGY_FLOOR) : state.stock(r));
        const batches = affordable(recipe, available);
        if (batches > 0 && (!best || margin > best.margin)) best = { job: { product: recipe.product, batches }, margin };
    }
    return best?.job ?? null;
}

/** Components the factory should hold for a job: FILL_TIME ticks of production, at most what the job has left */
export function requestedComponents(recipe: FactoryRecipe, batches: number): { [resourceType: string]: number } {
    const fill = Math.min(batches, Math.max(1, Math.floor(FILL_TIME / recipe.cooldown)));
    const result: { [resourceType: string]: number } = {};
    for (const resourceType in recipe.components) result[resourceType] = recipe.components[resourceType] * fill;
    return result;
}
