import type { DoctrineName, FormationName } from './constants.js';

export type Team = 0 | 1;
export type Kind = 'main' | 'soldier';
export type Stance = 'defensive' | 'offensive';
export type WeaponMode = 'rifle' | 'sword';
export type TaskState =
  | 'Idle'
  | 'Moving'
  | 'Following'
  | 'Guarding'
  | 'Seeking'
  | 'Engaging'
  | 'Harassing'
  | 'Retreating'
  | 'Regrouping'
  | 'Defeated';

export interface SoldierAI {
  task: TaskState;
  targetId: number; // -1 none
  targetSince: number;
  nextThink: number;
  blocked: boolean;
  blockedUntil: number;
  blockedFails: number;
  engagementStart: number; // -1 none
  hitsInEngagement: number;
  withdrawing: boolean;
  lastOpponentId: number;
  lastRefillTick: number;
  bodyguard: boolean;
  goalX: number;
  goalY: number;
  progressTick: number;
  progressX: number;
  progressY: number;
}

export interface Actor {
  id: number;
  team: Team;
  kind: Kind;
  x: number;
  y: number;
  /** position at the start of the tick (used to derive effective speed after collision) */
  px: number;
  py: number;
  theta: number;
  /** signed speed along the facing vector (negative = backward) */
  speed: number;
  radius: number;
  hp: number;
  hpMax: number;
  shield: number;
  shieldMax: number;
  alive: boolean;
  deathTick: number;
  // weapons
  mode: WeaponMode;
  mag: number;
  reserve: number;
  nextFireTick: number;
  reloadEnd: number; // -1 = not reloading
  nextSwordTick: number;
  strain: number;
  lastSwordAttempt: number;
  overloadEnd: number; // -1 = not overloaded
  /** last tick of an attack attempt, damaging contact or damage received (shield regen delay) */
  lastCombatTick: number;
  lastHealTick: number;
  // controller outputs (intents)
  throttle: number; // -1..1 (negative = backward)
  turn: number; // -1..1 (negative = counter-clockwise)
  wantFire: boolean;
  wantSwipe: boolean;
  wantThrust: boolean;
  wantReload: boolean;
  wantSwitch: boolean;
  // squad membership (0 = unassigned reserve)
  squadSlot: number;
  // perception: enemy ids this actor currently sees
  sees: number[];
  // per-tick scratch
  eligibleHeal: number;
  // stats
  stats: { shots: number; hits: number; damageDealt: number; kills: number };
  ai: SoldierAI;
}

export interface LastKnown {
  id: number;
  x: number;
  y: number;
  observedAt: number;
}

export type MovementKind = 'None' | 'Move' | 'Follow' | 'Hold';
export type TargetKind = 'none' | 'unit' | 'squad' | 'area';

export interface Squad {
  slot: number; // 1..9
  members: number[];
  leader: number; // -1 none
  move: { kind: MovementKind; x: number; y: number; followId: number; orient: number };
  doctrine: DoctrineName;
  formation: FormationName;
  target: { kind: TargetKind; id: number; x: number; y: number };
  rally: { x: number; y: number } | null;
  blockedCount: number;
  lastOrderTick: number;
}

export interface StreakState {
  active: boolean;
  kills: number[]; // tick of each credited kill in the current window
  activatedAt: number; // -1 none
  activeUntil: number; // exclusive; -1 none
  cooldownUntil: number; // exclusive; -1 none
  activations: number;
}

export type MainGoalKind = 'Engage' | 'MoveTo' | 'Retreat' | 'HoldNear' | 'Resupply';
export interface MainGoal {
  kind: MainGoalKind;
  x: number;
  y: number;
  targetId: number;
  issuedAt: number;
  expiresAt: number;
}

export interface WaveReport {
  tick: number;
  team: Team;
  base: number;
  ownBonus: number;
  enemyPenalty: number;
  adjusted: number;
  capacityRoom: number;
  spawned: number;
  note: string;
}

export interface TeamState {
  id: Team;
  mainId: number;
  stance: Stance;
  squads: Squad[]; // index 0..8 => slots 1..9
  bodyguards: number[];
  bodyguardLockoutUntil: number;
  streak: StreakState;
  teamVisible: Set<number>;
  lastKnown: Map<number, LastKnown>;
  mainGoal: MainGoal;
  collapseStart: number; // -1 none
  surrendered: boolean;
  humanControlled: boolean;
  controls: { throttle: number; turn: number };
  waves: WaveReport[];
  aiGeneration: number;
  soldiersSpawned: number;
}

export type GameEvent = { tick: number; type: string } & Record<string, any>;

export type Command =
  | { t: 'Stance'; stance: Stance }
  | { t: 'CreateSquad'; slot: number; members: number[] }
  | { t: 'DisbandSquad'; slot: number }
  | { t: 'AddToSquad'; slot: number; members: number[] }
  | { t: 'RemoveFromSquad'; members: number[] }
  | { t: 'SquadMove'; slot: number; x: number; y: number }
  | { t: 'SquadFollow'; slot: number; targetId: number }
  | { t: 'SquadHold'; slot: number }
  | { t: 'SquadDoctrine'; slot: number; doctrine: DoctrineName }
  | { t: 'SquadFormation'; slot: number; formation: FormationName }
  | { t: 'SquadTarget'; slot: number; kind: TargetKind; id?: number; x?: number; y?: number }
  | { t: 'SquadLeader'; slot: number; soldierId: number }
  | { t: 'SquadRally'; slot: number; x: number; y: number }
  | { t: 'MainGoal'; goal: Omit<MainGoal, 'issuedAt' | 'expiresAt'> }
  | { t: 'Surrender' };

export type CommandSource = 'human' | 'slai' | 'baseline';
export interface CommandEnvelope {
  source: CommandSource;
  team: Team;
  cmd: Command;
  /** observation generation the AI based the command on (AI sources only) */
  generation?: number;
  issuedAt: number;
  expiresAt?: number;
}

export interface CommandResult {
  ok: boolean;
  reason?: string;
}

export type MatchResult = {
  over: boolean;
  winner: Team | null; // null with over=true => draw
  reason: string;
  tick: number;
};

export interface Pickup {
  x: number;
  y: number;
  spawnedAt: number;
}
