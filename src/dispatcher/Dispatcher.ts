/**
 * Resource dispatcher: providers offer tasks (priority, weight) for a creep, the best one becomes its order.
 * Ported from Hivemind (MIT), src/dispatcher/dispatcher.ts and task-provider.ts.
 */

import { getBestOption } from "../core/options";
import { Order } from "../core/roomState";

export interface DispatchContext {
    creep: Creep;
    resourceType?: ResourceConstant;
    /** Plan a delivery before carrying anything (transporter choosing a source for a destination) */
    ignoreStoreContent?: boolean;
}

export interface TaskProvider {
    readonly type: string;
    /** Upper bound of the priorities this provider can return (prunes the search); a constant */
    highestPriority(): number;
    tasks(context: DispatchContext): Order[];
    isValid(task: Order, context: DispatchContext): boolean;
    execute(task: Order, context: DispatchContext): void;
}

/**
 * Hivemind's cacheEmptyTaskListFor: once a provider has nothing for a room, skip it for `timeout`
 * ticks. Hivemind recreated providers every tick, so the timeout only lasted the tick: we keep that.
 */
const emptyUntil: Map<string, number> = new Map();
export function cacheEmptyTasks(key: string, compute: () => Order[]): Order[] {
    if ((emptyUntil.get(key) ?? -1) >= Game.time) return [];
    const tasks = compute();
    if (tasks.length === 0) emptyUntil.set(key, Game.time);
    return tasks;
}

export class Dispatcher {
    private readonly providers: Map<string, TaskProvider> = new Map();
    /** Highest priority first, ties in registration order */
    private readonly sorted: TaskProvider[];

    constructor(providers: TaskProvider[]) {
        for (const provider of providers) this.providers.set(provider.type, provider);
        this.sorted = _.sortBy([...this.providers.values()], p => -p.highestPriority());
    }

    getTask(context: DispatchContext, validator?: (task: Order) => boolean): Order | null {
        const options: Order[] = [];
        let highest = -10;
        for (const provider of this.sorted) {
            if (provider.highestPriority() < highest) break;
            for (const task of provider.tasks(context)) {
                if (task.priority < highest) continue;
                if (!provider.isValid(task, context)) continue;
                if (validator && !validator(task)) continue;
                options.push(task);
                highest = Math.max(highest, task.priority);
            }
        }
        return getBestOption(options);
    }

    has(task: Order): boolean {
        return this.providers.has(task.type);
    }

    validateTask(task: Order, context: DispatchContext): boolean {
        const provider = this.providers.get(task.type);
        return !!provider && provider.isValid(task, context);
    }

    executeTask(task: Order, context: DispatchContext): void {
        this.providers.get(task.type)?.execute(task, context);
    }
}
