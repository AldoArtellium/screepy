/**
 * Segment stores: big, rarely written data (intel, room plans, remote paths) kept in RawMemory
 * segments instead of Memory, with the decoded copy in the heap. Memory is parsed once per global
 * (MemHack) but serialized every tick: data moved here is only serialized when it changes.
 * Inspired by Hivemind (MIT) src/utils/segmented-memory.ts, simplified: each store owns fixed
 * segment ids, its JSON is split across them (100 KB each).
 *
 * Activation: the engine keeps the active segment list across ticks and global resets (driver
 * runtime/make.js saves it in the user document), so after a reset the segments are visible on the
 * first tick and loaded by `segmentsPreTick`. Only the very first tick (segments never requested,
 * or the list changed by someone else) has the one-tick delay: the store is then not `ready`, its
 * `get()` returns the legacy Memory copy (migration) or an empty pending object, and whatever is
 * written there is merged into the segment data once it loads. Writers that must not run on
 * partial data (the planner) check `ready`.
 *
 * Migration: a store with a `legacy` accessor merges the old Memory copy into the segment data
 * when it loads, writes the segment and only then deletes the Memory copy (same tick save).
 */

import { log } from "./logger";
import { countStat } from "./stats";

const MAX_SEGMENT_LENGTH = 100 * 1024;

interface LegacySource<T> {
    /** The old Memory copy, undefined once migrated */
    read(): T | undefined;
    /** Drops the old Memory copy (after the segment write) */
    clear(): void;
}

export class SegmentStore<T extends object> {
    private data: T | undefined;
    private pending: T | undefined;
    private dirty = false;
    private legacyPending = false;
    /** Write on the next save, whatever the delay */
    private force = false;
    private lastWrite = -Infinity;

    constructor(
        readonly name: string,
        readonly ids: number[],
        /** Ticks a change may wait before the segment write (heap keeps the truth meanwhile) */
        private readonly writeDelay: number,
        private readonly legacy?: LegacySource<T>
    ) {}

    /** Segment data loaded: get() returns the full data */
    get ready(): boolean {
        return this.data !== undefined;
    }

    /** The data (mutable: call touch() after a change). Before the load: legacy copy or pending writes */
    get(): T {
        if (this.data) return this.data;
        this.pending ??= this.legacy?.read() ?? ({} as T);
        return this.pending;
    }

    /** Marks the data changed: written within writeDelay ticks */
    touch(): void {
        this.dirty = true;
    }

    /** Marks the data changed and writes it this tick */
    touchNow(): void {
        this.dirty = true;
        this.force = true;
    }

    /** Loads the data if every segment is visible; false when they must be requested */
    load(): boolean {
        if (this.data) return true;
        const parts: string[] = [];
        for (const id of this.ids) {
            const part = RawMemory.segments[id];
            if (typeof part !== "string") return false;
            parts.push(part);
        }
        const text = parts.join("");
        let data = {} as T;
        if (text) {
            try {
                data = JSON.parse(text) as T;
            } catch (e) {
                log.error("Segments", `${this.name}: unreadable segment data (${text.length} chars), starting empty: ${String(e)}`);
                countStat(`segments:corrupt:${this.name}`);
            }
        }
        const legacy = this.legacy?.read();
        if (legacy) {
            Object.assign(data, legacy);
            this.legacyPending = true;
            this.touchNow();
            log.info("Segments", `${this.name}: migrating ${Object.keys(legacy).length} entries from Memory`);
        }
        if (this.pending && this.pending !== legacy) {
            Object.assign(data, this.pending);
            this.touchNow();
        }
        this.pending = undefined;
        this.data = data;
        return true;
    }

    /** Writes the segments if the data changed (and its delay passed) */
    save(): void {
        if (!this.data || !this.dirty) return;
        if (!this.force && Game.time - this.lastWrite < this.writeDelay) return;
        const text = JSON.stringify(this.data);
        this.dirty = false;
        this.force = false;
        this.lastWrite = Game.time;
        if (text.length > MAX_SEGMENT_LENGTH * this.ids.length) {
            log.error("Segments", `${this.name}: ${text.length} chars, more than its ${this.ids.length} segments hold; not saved`);
            countStat(`segments:overflow:${this.name}`);
            return;
        }
        this.ids.forEach((id, i) => {
            RawMemory.segments[id] = text.slice(i * MAX_SEGMENT_LENGTH, (i + 1) * MAX_SEGMENT_LENGTH);
        });
        countStat(`segments:write:${this.name}`);
        if (this.legacyPending) {
            this.legacy?.clear();
            this.legacyPending = false;
        }
    }
}

const stores: SegmentStore<object>[] = [];

/**
 * A store on fixed segment ids (at most 10 active segments for all stores together; ids never
 * shared between stores). The writeDelay keeps frequently touched data from being serialized every tick.
 */
export function segmentStore<T extends object>(
    name: string,
    ids: number[],
    writeDelay: number,
    legacy?: LegacySource<T>
): SegmentStore<T> {
    const store = new SegmentStore<T>(name, ids, writeDelay, legacy);
    stores.push(store as unknown as SegmentStore<object>);
    return store;
}

/** Start of the tick: loads the stores whose segments are visible, requests the others */
export function segmentsPreTick(): void {
    let missing = false;
    for (const store of stores) if (!store.load()) missing = true;
    if (missing) RawMemory.setActiveSegments(_.flatten(stores.map(s => s.ids)).slice(0, 10));
}

/** End of the tick: writes the changed stores */
export function segmentsPostTick(): void {
    for (const store of stores) {
        try {
            store.save();
        } catch (e) {
            log.error("Segments", `${store.name}: save failed: ${String(e)}`);
        }
    }
}
