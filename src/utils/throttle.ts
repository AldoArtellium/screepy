/**
 * CPU throttling by bucket. Ported from Hivemind (MIT), src/utils/throttle.ts and the process
 * scheduling of src/hivemind.ts (getThrottleMultiplier).
 *
 * - `throttle(offset, stopAt, throttleAt)`: skip an operation this tick? Never above `throttleAt`
 *   bucket, always below `stopAt`, in between a share of ticks growing as the bucket drains, spread
 *   by a Van der Corput sequence so throttled creeps don't all skip the same ticks.
 * - `throttleMultiplier(stopAt, throttleAt)`: factor applied to a periodic module's interval.
 */

/** Bucket for CPU decisions (no bucket in the simulation room: full) */
export function decisionBucket(): number {
    return Game.cpu.bucket ?? 10000;
}

const throttleNumbers: number[] = [];
let nextOffset = 0;

/** Van der Corput sequence of base^power numbers, the largest first */
function evenSequence(power: number, base: number): number[] {
    const digits: number[] = new Array(power).fill(0);
    const increase = (digit: number): void => {
        if (digit >= power) return;
        digits[digit]++;
        if (digits[digit] >= base) {
            digits[digit] = 0;
            increase(digit + 1);
        }
    };
    const value = (): number => digits.reduce((sum, d) => sum * base + d, 0);
    increase(0);
    let number = value();
    const numbers = [number * base];
    while (number !== 0) {
        numbers.push(number);
        increase(0);
        number = value();
    }
    return numbers;
}

function init(): void {
    if (throttleNumbers.length > 0) return;
    const sequence = evenSequence(8, 2);
    const max = sequence[0];
    sequence.forEach((n, i) => (throttleNumbers[i] = 1 - n / max));
    throttleNumbers[0] = 1;
}

/** A new offset for a throttled operation (kept per creep in the heap) */
export function throttleOffset(): number {
    return nextOffset++;
}

/** True when the operation should be skipped this tick */
export function throttle(offset: number, stopAt = 2000, throttleAt = 8000): boolean {
    init();
    const bucket = decisionBucket();
    if (bucket >= throttleAt) return false;
    if (bucket < stopAt) return true;
    const ratio = (bucket - stopAt) / (throttleAt - stopAt);
    return ratio < throttleNumbers[(Game.time + offset) % throttleNumbers.length];
}

/** Interval multiplier (>= 1) from the recent CPU use, this tick's CPU use and the bucket */
export function throttleMultiplier(stopAt = 0, throttleAt = 5000): number {
    const average = Memory.stats?.cpuAvg ?? 0;
    let multiplier = Math.max(average / Game.cpu.limit, 1);
    const minThrottle = Game.cpu.limit / 2;
    const maxThrottle = Game.cpu.tickLimit;
    const used = Game.cpu.getUsed();
    if (used > minThrottle) multiplier /= Math.max(0.01, 1 - (used - minThrottle) / (maxThrottle - minThrottle));
    const bucket = decisionBucket();
    if (bucket <= stopAt) return 99999;
    if (bucket < throttleAt) multiplier *= (throttleAt - stopAt) / (bucket - stopAt);
    return multiplier;
}

/**
 * Harvester size factor (Hivemind spawn-role/harvester.ts getHarvesterSizeFactor): each harvest
 * intent costs 0.2 official CPU whatever the WORK count, so twice the WORK drains a source with half
 * the intents. Hivemind does it from RCL 6 when the CPU use is above 75% of the limit; we do it as
 * soon as the room has a storage (energy to spare for the bigger bodies), with the same CPU condition.
 * Memory.stats.cpuAvg includes the intents' CPU on the official server.
 */
export function harvesterSizeFactor(room: Room): number {
    if (!room.storage) return 1;
    return (Memory.stats?.cpuAvg ?? 0) > Game.cpu.limit * 0.75 ? 2 : 1;
}
