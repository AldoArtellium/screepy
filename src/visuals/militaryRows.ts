/**
 * Military section of the world map panel (`mapPanel.ts`): one row per squad on a target (type, target,
 * state, members alive / roster with losses, strategic reason, return on investment, boost tier, age),
 * the drainer's measure of the towers under a quad, then sieges, remote seizes, safe mode baits, loot,
 * nukes in flight, the offensive boost demand and the latest results. Rows only for what exists: the
 * section is left out in peace time. Pure (Memory slices and the tick as arguments), checked offline by
 * `tests/militaryVisuals/run.mjs`.
 */

import type { Cell } from "./mapPanel";
import { rate, short } from "../utils/format";

type Military = NonNullable<Memory["military"]>;
type Released = Memory["remoteReleased"];
type Compounds = { [effect: string]: string | null | undefined };

const BAD = "#ff5c5c";
const WARN = "#e8a23a";
const OK = "#7ee08a";
const TEXT = "#d8d8d8";
const DIM = "#a8a8a8";

/** Members of a full squad (duo.ts DUO_ATTACKER + DUO_HEALER, quad.ts QUAD_ROSTER) */
const ROSTER = { duo: 2, quad: 4 };
/** Latest results shown, and how old they may be */
const LOG_ROWS = 3;
const LOG_SHOWN = 20000;
/** Rows of the section at most (the panel sits on 150 tiles of keeper rooms, other sections included) */
const MAX_ROWS = 12;

const RESULT_COLORS: { [result: string]: string } = { success: OK, taken: OK, abandoned: BAD, safeMode: WARN, retargeted: DIM };

/** Tier of a compound: X-prefixed T3, three-element (with O2 / H2O) T2, else T1 */
function compoundTier(compound: string): number {
    if (compound.startsWith("X")) return 3;
    return compound.length > 2 ? 2 : 1;
}

/** Boosts of a squad: "max" (absent: the strongest in stock), "plain" (none), else the highest tier */
export function boostTier(boosts: Compounds | undefined): string {
    if (!boosts) return "max";
    const tiers = Object.values(boosts)
        .filter((c): c is string => !!c)
        .map(compoundTier);
    return tiers.length === 0 ? "plain" : `T${Math.max(...tiers)}`;
}

interface Squad {
    type: "duo" | "quad";
    memory: Military["duos"][string] | NonNullable<Military["quads"]>[string];
}

function missionRows(military: Military, time: number, alive: (name: string) => boolean): Cell[][] {
    const rows: Cell[][] = [];
    const squads: Squad[] = [
        ...Object.values(military.duos ?? {}).map(memory => ({ type: "duo" as const, memory })),
        ...Object.values(military.quads ?? {}).map(memory => ({ type: "quad" as const, memory }))
    ];
    // Squads whose target left the list (retargeted, finishing) are still shown, after the listed ones
    const targets = new Set([
        ...(military.attack ? [military.attack] : []),
        ...(military.targets ?? []).map(t => t.room),
        ...squads.map(s => s.memory.targetRoom)
    ]);

    for (const room of targets) {
        const entry = military.targets?.find(t => t.room === room);
        const reason = military.attack === room ? "manual" : (entry?.reason ?? "");
        const detail = (boosts?: string): string =>
            [reason, entry?.roi !== undefined ? `roi ${entry.roi.toFixed(1)}` : "", boosts ?? "", entry ? short(time - entry.since) : ""]
                .filter(part => part)
                .join(" · ");
        const onTarget = squads.filter(s => s.memory.targetRoom === room);
        if (onTarget.length === 0) {
            rows.push([cell("attack", BAD), cell(room, BAD), cell("no squad", DIM), cell(detail(), DIM)]);
            continue;
        }
        for (const { type, memory } of onTarget) {
            const members = memory.members.filter(alive).length;
            const losses = memory.losses > 0 ? ` -${memory.losses}` : "";
            const color = memory.state === "retreat" ? WARN : TEXT;
            rows.push([
                cell(type, BAD),
                cell(room, BAD),
                cell(`${memory.state} ${members}/${ROSTER[type]}${losses}`, color),
                cell(detail(boostTier(memory.boosts as Compounds | undefined)), DIM)
            ]);
            if (type === "quad") rows.push(...probeRows(memory as NonNullable<Military["quads"]>[string]));
        }
    }
    return rows;
}

/** The drainer's measure of the target's towers (drainForecast.ts): energy left, net drain rate */
function probeRows(quad: NonNullable<Military["quads"]>[string]): Cell[][] {
    if (quad.probeEnergy === undefined) return [];
    const towers = `towers ${quad.probeTowers ?? "?"} · ${short(quad.probeEnergy)}e`;
    const drain = quad.probe?.rate;
    const trend =
        drain === undefined
            ? cell("measuring", DIM)
            : drain >= 0
              ? cell(`drain ${rate(drain)}/t`, OK)
              : cell(`refill ${rate(-drain)}/t`, WARN);
    return [[cell("", DIM), cell("", DIM), cell(towers, DIM), trend]];
}

function cell(text: string, color: string): Cell {
    return { text, color };
}

/** Rows of the military section, empty when nothing military is under way */
export function militaryRows(military: Military | undefined, released: Released, time: number, alive: (name: string) => boolean): Cell[][] {
    const rows: Cell[][] = [];
    if (military) rows.push(...missionRows(military, time, alive));

    for (const [room, siege] of Object.entries(military?.sieges ?? {})) {
        const left = siege.downgrade !== undefined ? ` · ${short(siege.downgrade - time)} to downgrade` : "";
        rows.push([cell("siege", BAD), cell(room, BAD), cell(siege.owner, TEXT), cell(`RCL ${siege.level ?? "?"} · ${siege.attacks} attacks${left}`, DIM)]);
    }
    for (const [room, entry] of Object.entries(released ?? {})) {
        if (!entry.seize || entry.until <= time) continue;
        rows.push([cell("seize", WARN), cell(room, WARN), cell(entry.player, TEXT), cell(`${short(entry.until - time)} left`, DIM)]);
    }
    for (const [room, bait] of Object.entries(military?.baits ?? {})) {
        if (bait.since === undefined) continue;
        const failed = bait.failures > 0 ? ` · ${bait.failures} failed` : "";
        rows.push([
            cell("bait", WARN),
            cell(room, WARN),
            cell(bait.base ? `from ${bait.base}` : "", TEXT),
            cell(`${bait.sent ? "sent" : "spawning"}${failed}`, DIM)
        ]);
    }
    for (const [room, loot] of Object.entries(military?.loot ?? {})) {
        rows.push([cell("loot", OK), cell(room, OK), cell(`${short(loot.amount)} left`, TEXT), cell(`${short(loot.looted)} home`, DIM)]);
    }
    for (const [room, nuke] of Object.entries(military?.nukes ?? {})) {
        rows.push([cell("nuke", BAD), cell(room, BAD), cell(`${nuke.x},${nuke.y}`, TEXT), cell(`lands in ${short(nuke.landTime - time)}`, DIM)]);
    }
    const demand = military?.boostDemand;
    if (demand) {
        // Names only, the total beside the home: a T3 squad asks 3-5 compounds, amounts overflowed the panel
        const total = Object.values(demand.compounds).reduce((sum, amount) => sum + amount, 0);
        rows.push([
            cell("boosts", DIM),
            cell(demand.target, TEXT),
            cell(`${demand.home} · ${short(total)}`, TEXT),
            cell(Object.keys(demand.compounds).join(" "), DIM)
        ]);
    }

    const log = (military?.log ?? [])
        .filter(entry => time - entry.time < LOG_SHOWN)
        .sort((a, b) => b.time - a.time)
        .slice(0, LOG_ROWS);
    for (const entry of log) {
        rows.push([
            cell(entry.result, RESULT_COLORS[entry.result] ?? DIM),
            cell(entry.room, TEXT),
            cell(entry.losses > 0 ? `lost ${entry.losses}` : "", DIM),
            cell(`${short(time - entry.time)} ago`, DIM)
        ]);
    }
    if (rows.length <= MAX_ROWS) return rows;
    const kept = rows.slice(0, MAX_ROWS - 1);
    kept.push([cell("", DIM), cell(`+${rows.length - kept.length} more`, DIM), cell("", DIM), cell("", DIM)]);
    return kept;
}
