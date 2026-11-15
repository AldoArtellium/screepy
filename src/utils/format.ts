/** Number formats shared by the reports and the room panel */

/** 1234 -> "1234", 12345 -> "12.3k", 1234567 -> "1.23M" */
export function short(value: number): string {
    const abs = Math.abs(value);
    if (abs >= 1e6) return `${(value / 1e6).toPrecision(3)}M`;
    if (abs >= 1e4) return `${(value / 1e3).toPrecision(3)}k`;
    return `${Math.round(value)}`;
}

/** A rate per tick: one decimal below 100, whole above ("-" when unknown) */
export function rate(value: number | undefined): string {
    if (value === undefined) return "-";
    return Math.abs(value) >= 100 ? `${Math.round(value)}` : value.toFixed(1);
}
