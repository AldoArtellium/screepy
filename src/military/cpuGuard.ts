/**
 * CPU guard of attack missions (pure, offline check: tests/militaryCpu/run.mjs), used by military.ts.
 *
 * Not in Hivemind or The International. shard0 2026-10-25 (20 CPU limit): the W27N9 quad took ~5.3 CPU
 * per tick for 4000 ticks (stuck on a step its PathFinder path took and cartographer refused, ERR_NO_PATH
 * every tick), the bucket fell to 5271 and the remote budget dropped from 7 rooms to 3. A mission whose
 * module CPU stays above MILITARY_CPU_SHARE of the limit while the bucket is below MILITARY_CPU_BUCKET
 * is abandoned (logged, the room left alone like after too many losses).
 */

/** Share of the CPU limit the Military module may average while the bucket is low */
export const MILITARY_CPU_SHARE = 0.15;
/** Bucket below which an expensive mission is abandoned */
export const MILITARY_CPU_BUCKET = 6000;
/** Weight of one tick in the module's CPU average: ~500 ticks */
const DECAY = 1 / 500;

/** Slow average of the Military module's CPU per tick */
export function militaryCpuAverage(previous: number | undefined, sample: number): number {
    return previous === undefined ? sample : previous * (1 - DECAY) + sample * DECAY;
}

/** Whether a running mission costs more CPU than the account can give it */
export function militaryCpuTooHigh(average: number | undefined, limit: number, bucket: number): boolean {
    return average !== undefined && bucket < MILITARY_CPU_BUCKET && average > limit * MILITARY_CPU_SHARE;
}
