/**
 * GangUP v0.3 — authoritative alpha constants.
 * Every number here is taken from the Game Design Document v0.3 / Official Ruleset (R1–R12).
 * All timers are stored as integer simulation ticks (60 Hz) to avoid float drift; use sec() to convert.
 */

export const TICK_RATE = 60; // GDD 17.1
export const DT = 1 / TICK_RATE;
export const sec = (s: number): number => Math.round(s * TICK_RATE);
export const ticksToSec = (t: number): number => t / TICK_RATE;
export const deg = (d: number): number => (d * Math.PI) / 180;

// ---------------------------------------------------------------- Teams
export const TEAM_GREEN = 0; // human side in the initial mode
export const TEAM_RED = 1; // SLAI side
export const MAX_SOLDIERS = 50; // R1.1
export const START_SOLDIERS = 4; // R1.1

// ---------------------------------------------------------------- Attributes (GDD 3.1, R2.1)
export const MAIN = {
  hp: 100,
  shield: 25,
  forward: 4.0,
  radius: 0.5,
  accel: 12, // m/s^2 (4.3)
  turnRate: deg(180), // rad/s
  damageMult: 1.0,
};
export const SOLDIER = {
  hp: 30,
  shield: 8,
  forward: 6.0,
  radius: 0.35,
  accel: 16,
  turnRate: deg(240),
  damageMult: 0.2,
};
export const BACKWARD_FACTOR = 0.7; // R2.3 — exactly 70 % of modified forward speed
export const MOVING_SPEED_THRESHOLD = 0.2; // m/s (5.2)

// ---------------------------------------------------------------- Rifles (5.1, R3)
export const RIFLE = {
  main: { interval: sec(0.8), mag: 10, carry: 50, reload: sec(1.5) },
  soldier: { interval: sec(1.5), mag: 6, carry: 24, reload: sec(1.5) },
  range: 18,
  closeRange: 2,
  closeDamage: 15,
  /** 15 - 13 (d-2)/16 for 2 < d <= 18 ; 15 for d <= 2 ; 0 beyond 18 m */
  falloffSpan: 16,
  falloffDrop: 13,
};
export const SPREAD_DEG = {
  mainStill: 1.5,
  mainMoving: 2.5,
  soldierStill: 4.0,
  soldierMoving: 6.0,
};

// ---------------------------------------------------------------- Sword (5.5, 5.6, R5)
export const SWORD = {
  swipe: { damage: 7, reach: 2.0, sector: deg(120), maxVictims: 3, strain: 18 },
  thrust: { damage: 12, reach: 2.5, sector: deg(20), maxVictims: 1, strain: 24 },
  cooldown: sec(0.85),
  strainMax: 100,
  recoveryDelay: sec(1.0),
  recoveryRate: 12, // points / s
  overload: sec(6.0),
  overloadResetStrain: 40,
};

// ---------------------------------------------------------------- Vision (6.1, R4)
export const VISION = {
  range: 24,
  fov: deg(220),
  lastKnown: sec(3.0),
  perceptionInterval: 6, // ticks between an actor's visibility refreshes (10 Hz, staggered by id)
  sampleInset: 0.96, // boundary samples placed just inside the collider
  tieEpsilon: 0.001, // 1 mm — solid cover wins ties (6.5)
};

// ---------------------------------------------------------------- Shield (7, R6)
export const SHIELD = {
  arcDot: -0.5, // dot(f, i) <= -0.5  => 120-degree rear arc
  regenDelay: sec(8.0),
  mainRegen: 2.5,
  soldierRegen: 1.0,
  pressConsumption: 1.25,
};
export const CONTACT = {
  bodyDamage: 5,
  shieldDamage: 1,
  pairCooldown: sec(1.0),
  rearmSeparation: 0.1,
};

// ---------------------------------------------------------------- Healing (7.5, R6.4)
export const HEAL = {
  lowThreshold: 50,
  lowFraction: 0.25,
  lowCap: 3,
  highFraction: 0.2,
  highCap: 2,
  cooldown: sec(1.0),
};

// ---------------------------------------------------------------- Reinforcements (8, R7)
export const WAVE = {
  interval: sec(20),
  /** [minHp%, maxHp% exclusive, soldiers]; the last band is inclusive of 100 */
  bands: [
    { lo: 0, hi: 10, n: 0 },
    { lo: 10, hi: 40, n: 3 },
    { lo: 40, hi: 80, n: 4 },
    { lo: 80, hi: 100.0001, n: 5 },
  ],
};
export const SUPPLY = {
  interval: sec(30),
  mainRestore: 20,
  pickupRadius: 1.2,
  soldierRefill: 6,
  soldierRefillCooldown: sec(20),
};

// ---------------------------------------------------------------- Kill-streak (9, R8)
export const STREAK = {
  kills: 4,
  window: sec(30),
  duration: sec(40),
  cooldown: sec(90),
  shieldBonus: 5,
};

// ---------------------------------------------------------------- Squads & doctrine (10, R9)
export const SQUAD = {
  slots: 9,
  maxMembers: 10,
  bodyguardsDefensive: 5,
  bodyguardsOffensive: 2,
  bodyguardLockout: sec(1.0),
  guardRadius: 8,
};
export type DoctrineName = 'Defend' | 'Press' | 'Harass' | 'Disengage';
export const DOCTRINE: Record<DoctrineName, { damage: number; speed: number; shieldTaken: number; canInitiate: boolean }> = {
  Defend: { damage: 1.0, speed: 1.0, shieldTaken: 1.0, canInitiate: true },
  Press: { damage: 1.15, speed: 0.85, shieldTaken: 1.25, canInitiate: true },
  Harass: { damage: 0.8, speed: 1.25, shieldTaken: 1.0, canInitiate: true },
  Disengage: { damage: 1.0, speed: 1.0, shieldTaken: 1.0, canInitiate: false },
};
export type FormationName = 'Compact' | 'Line' | 'Spread';
export const FORMATION_SPACING: Record<FormationName, number> = { Compact: 1.0, Line: 1.5, Spread: 2.0 };
export const HARASS = { maxHits: 2, maxEngagement: sec(3.0), withdrawDistance: 6 };

// ---------------------------------------------------------------- Local AI (11)
export const LOCAL_AI = {
  controllerInterval: 3, // 20 Hz (within the 10–30 Hz budget)
  targetHysteresis: sec(0.5),
  retryBase: sec(0.5),
  retryMax: sec(4.0),
  pathBudgetExpansions: 6000, // deterministic stand-in for the 150 ms planning budget
};
export const SQUAD_CONTROL_INTERVAL = 30; // 2 Hz squad tactical controller (1–5 Hz)
export const SLAI_STRATEGY_HZ = { min: 0.5, max: 2 };

// ---------------------------------------------------------------- Match (14, R11)
export const LAST_STAND = { hpBelow: 10, duration: sec(30) };
export const PHASES = { earlyEnd: sec(120), middleEnd: sec(300) };

// ---------------------------------------------------------------- Arena
export const ARENA = { width: 100, height: 60 };
