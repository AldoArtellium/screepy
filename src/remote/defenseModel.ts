/**
 * Remote defense model: which defender answers the hostiles of a remote (Hivemind getDefenseCreepSize,
 * src/spawn-role/brawler.ts, MIT) and whether it wins the fight. No game state: the bodies are given,
 * so tests/remoteDefense/run.mjs checks it offline.
 */

import type { EnemyData } from "./RemoteMining";

export const enum DefenseResponse {
    /** Melee only, against invader cores */
    ATTACKER = "attacker",
    MINI_BRAWLER = "miniBrawler",
    MINI_BLINKY = "miniBlinky",
    /** Blinky sized to the energy capacity */
    BLINKY = "blinky",
    /** Two blinkies leaving together (Hivemind RESPONSE_BLINKY_BLINKY_TRAIN, without the train) */
    BLINKY_PAIR = "blinkyPair"
}

/** 5 ATTACK + 3 HEAL; heal weighs 3 against melee */
const SMALL_DEFENDER_POWER = 5 * ATTACK_POWER + 3 * HEAL_POWER * 3;
/** 6 RANGED_ATTACK + 2 HEAL; heal weighs 5 */
const SMALL_BLINKY_POWER = 6 * RANGED_ATTACK_POWER + 2 * HEAL_POWER * 5;

/** Hivemind's power of a blinky body: heal weighs 5 */
function blinkyPower(body: BodyPartConstant[]): number {
    return _.sum(body, p => (p === RANGED_ATTACK ? RANGED_ATTACK_POWER : p === HEAL ? HEAL_POWER * 5 : 0));
}

/** Margin of the fight model: the hostiles must die this many times faster than our focused creep */
const WIN_MARGIN = 1.5;

/** Our damage against their hits faster, by WIN_MARGIN, than their incoming damage kills our focused creep */
function wins(enemies: EnemyData, body: BodyPartConstant[], damage: number, heal: number, incoming: number): boolean {
    if (damage <= 0) return false;
    if (incoming <= heal) return true;
    const killTicks = enemies.hits / damage;
    const deathTicks = (body.length * 100) / (incoming - heal);
    return killTicks * WIN_MARGIN < deathTicks;
}

/**
 * Whether `count` creeps of `body` win against the hostiles (not in Hivemind, whose power alone sent a
 * blinky pair against 720 boosted ranged damage): our ranged damage minus their healing against their
 * hits, their damage minus our healing against the hits of the creep they focus. Kiting keeps melee
 * hostiles out of reach unless they are as fast as us (W7N4 mockup: a bigMelee* caught a lone blinky
 * along the room edge and killed it).
 */
export function blinkyWins(enemies: EnemyData, body: BodyPartConstant[], count: number): boolean {
    const damage = count * RANGED_ATTACK_POWER * body.filter(p => p === RANGED_ATTACK).length - enemies.heal;
    const heal = count * HEAL_POWER * body.filter(p => p === HEAL).length;
    const incoming = enemies.fastMelee ? enemies.damage : enemies.rangedDamage;
    return wins(enemies, body, damage, heal, incoming);
}

/** Ticks a brawler fight is simulated for: past it, our heal holds against theirs */
const MELEE_FIGHT_TICKS = 200;

/**
 * Whether a melee brawler wins at range 1, where every hostile part reaches it. Only against invaders
 * with ATTACK: they walk up to us, whereas a ranged-only hostile or a player can kite it. Simulated tick
 * by tick with their damage x WIN_MARGIN: damage destroys parts from the front (the engine keeps the
 * hits on the last parts), so ATTACK parts in front stop hitting long before the creep dies (mockup
 * W7N4: an ATTACK-first brawler left a smallMelee at 310 of its 1000 hits).
 */
export function brawlerWins(enemies: EnemyData, body: BodyPartConstant[]): boolean {
    if (enemies.players || enemies.damage <= enemies.rangedDamage) return false;
    const maxHits = body.length * 100;
    let hits = maxHits;
    let enemyHits = enemies.hits;
    for (let tick = 0; tick < MELEE_FIGHT_TICKS; tick++) {
        const alive = body.slice(body.length - Math.ceil(hits / 100));
        enemyHits -= ATTACK_POWER * alive.filter(p => p === ATTACK).length - enemies.heal;
        if (enemyHits <= 0) return true;
        hits = Math.min(maxHits, hits - enemies.damage * WIN_MARGIN + HEAL_POWER * alive.filter(p => p === HEAL).length);
        if (hits <= 0) return false;
    }
    return false;
}

/**
 * MOVE parts first on a melee defender: the invaders it fights walk up to it, so its MOVE parts are a
 * buffer that keeps the ATTACK parts hitting (bodyBuilder puts the military parts in front)
 */
export function meleeOrder(body: BodyPartConstant[]): BodyPartConstant[] {
    return [...body.filter(p => p === MOVE), ...body.filter(p => p !== MOVE)];
}

/**
 * Only a player's unarmed creeps (no ATTACK, RANGED_ATTACK or HEAL; abroad RoomIntel counts a CLAIM
 * part as dangerous): a reserver or a harvester of theirs gets no defender (not in Hivemind, whose
 * power 0 answers them with a mini brawler). shard0 2026-10-26: W28N7 sent a remoteDefender to W28N4
 * against Blindfold's reserver (damage 0), a fight with a much stronger player for a room it mines
 * (the room is now contested, remoteRooms.ts). An invader core keeps its ATTACKER.
 */
export function unarmedPlayers(enemies: EnemyData): boolean {
    return enemies.players && !enemies.hasInvaderCore && enemies.damage <= 0 && enemies.heal <= 0;
}

/**
 * Response to the hostiles (Hivemind getDefenseCreepSize); `miniBrawler` / `miniBlinky` / `blinky`: the
 * bodies the home can spawn. Not in Hivemind: a blinky response also has to win the fight (blinkyWins),
 * else the next step, else none: the remote waits for the hostiles to die. A mini brawler also answers
 * ranged invaders it beats at range 1 (shard0 W28N5: Hivemind's rule left a lone smallMelee, one
 * RANGED_ATTACK, to an RCL 3 home whose 800-energy blinkies all lose).
 */
export function defenseResponse(
    enemies: EnemyData,
    miniBrawler: BodyPartConstant[],
    miniBlinky: BodyPartConstant[],
    blinky: BodyPartConstant[]
): DefenseResponse | null {
    if (unarmedPlayers(enemies)) return null;
    const power = enemies.damage + 5 * enemies.heal;
    if (enemies.hasInvaderCore && power < SMALL_DEFENDER_POWER) return DefenseResponse.ATTACKER;
    if (power < SMALL_DEFENDER_POWER / 2 && (!enemies.ranged || brawlerWins(enemies, miniBrawler))) {
        return DefenseResponse.MINI_BRAWLER;
    }
    if (power < SMALL_BLINKY_POWER && blinkyWins(enemies, miniBlinky, 1)) return DefenseResponse.MINI_BLINKY;
    if (power < blinkyPower(blinky) && blinkyWins(enemies, blinky, 1)) return DefenseResponse.BLINKY;
    if (power < 2 * blinkyPower(blinky) && blinkyWins(enemies, blinky, 2)) return DefenseResponse.BLINKY_PAIR;
    return null;
}

/**
 * Hivemind defends no remote while the home has less than 5000 effective energy: before the storage
 * that is almost always, and an RCL 3 room living off its remotes lost them for each invader's 1500
 * ticks (shard0 W27N5). Not in Hivemind: before the storage, invaders get a defender anyway.
 */
export function skipsEnergyGate(hasStorage: boolean, enemies: EnemyData): boolean {
    return !hasStorage && !enemies.players;
}
