/**
 * Counts successful intents (Memory.stats.counters `intents` and `intents:<method>`). Every server
 * charges 0.2 CPU per intent on top of the code's own CPU, inside `Game.cpu.getUsed()` (the private
 * server and the mockup too: @screeps/driver runtime.js `intentCpu`). Creep intents are also counted
 * per role (`intents:role:<role>`, moves in `intents:move:<role>`).
 */

import { countStat } from "./stats";

const METHODS: [{ prototype: object }, string[]][] = [
    [
        Creep,
        [
            "move",
            "harvest",
            "transfer",
            "withdraw",
            "pickup",
            "drop",
            "build",
            "repair",
            "dismantle",
            "upgradeController",
            "reserveController",
            "attackController",
            "claimController",
            "attack",
            "rangedAttack",
            "rangedMassAttack",
            "heal",
            "rangedHeal",
            "suicide"
        ]
    ],
    [StructureSpawn, ["spawnCreep", "recycleCreep", "renewCreep"]],
    [StructureTower, ["attack", "heal", "repair"]],
    [StructureLink, ["transferEnergy"]],
    [StructureTerminal, ["send"]],
    [RoomPosition, ["createConstructionSite"]],
    [Room, ["createConstructionSite"]],
    [ConstructionSite, ["remove"]],
    [StructureController, ["activateSafeMode"]]
];

let installed = false;

export function installIntentCounter(): void {
    if (installed) return;
    installed = true;
    for (const [type, names] of METHODS) {
        const proto = type.prototype as Record<string, unknown>;
        for (const name of names) {
            const original = proto[name];
            if (typeof original !== "function") continue;
            proto[name] = function (this: unknown, ...args: unknown[]) {
                const result = (original as (...a: unknown[]) => unknown).apply(this, args);
                if (result === OK) {
                    countStat("intents");
                    countStat(`intents:${name}`);
                    // Per role: cpu:<role> holds the role's intents but its moves, which the TrafficManager issues
                    const role = this instanceof Creep ? this.memory.role : undefined;
                    if (role) {
                        countStat(`intents:role:${role}`);
                        if (name === "move") countStat(`intents:move:${role}`);
                    }
                }
                return result;
            };
        }
    }
}
