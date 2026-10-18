/**
 * Jittered cache lifetimes. Heap caches are all filled on the first ticks after a global reset;
 * with a fixed lifetime they all expire on the same later tick and recompute together (CPU spike).
 * +-10% spreads them.
 */

/** Random lifetime in [ttl * (1 - spread), ttl * (1 + spread)] */
export function jitter(ttl: number, spread = 0.1): number {
    return Math.round(ttl * (1 - spread + Math.random() * 2 * spread));
}

/**
 * Deterministic lifetime for a key (same key, same lifetime): for data whose age is checked
 * against a TTL without storing an expiry (e.g. paths stored with their generation tick)
 */
export function jitterFor(key: string, ttl: number, spread = 0.1): number {
    let hash = 0;
    for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
    const unit = ((hash >>> 0) % 1000) / 999;
    return Math.round(ttl * (1 - spread + unit * 2 * spread));
}
