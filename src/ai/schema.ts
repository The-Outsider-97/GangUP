/**
 * Observation / action interface between the authoritative engine and SLAI (GDD 12.4).
 * The same JSON shapes are validated by the Python service (slai/schema.py). Observations carry ONLY information
 * the team may legitimately know: own state, current sightings, timestamped last-known records (<= 3 s), static terrain.
 */
export const OBS_SCHEMA = 'gangup.obs.v1';
export const ACT_SCHEMA = 'gangup.act.v1';

export interface Rect { x0: number; y0: number; x1: number; y1: number }

export interface ObsActor {
  id: number;
  x: number;
  y: number;
  theta: number;
  hp: number;
  shield: number;
}
export interface ObsOwnSoldier extends ObsActor {
  squad: number; // 0 = unassigned
  guard: boolean;
  ammo: number; // magazine + reserve
  task: string;
}
export interface ObsSquad {
  slot: number;
  members: number[];
  leader: number;
  move: { kind: string; x: number; y: number; followId: number };
  doctrine: string;
  formation: string;
  target: { kind: string; id: number; x: number; y: number };
  blocked: number;
  centroid: { x: number; y: number } | null;
  avgHp: number; // 0..1 of max soldier HP
  avgAmmo: number; // carried rounds average
}

export interface Observation {
  schema: typeof OBS_SCHEMA;
  version: '0.3';
  seed: number;
  tick: number;
  time: number;
  generation: number;
  team: 0 | 1;
  difficulty: 'easy' | 'normal' | 'hard';
  own: {
    main: ObsActor & { alive: boolean; mode: string; ammo: number; mag: number; strain: number; shieldMax: number };
    soldiers: ObsOwnSoldier[];
    soldierCount: number;
    stance: string;
    streak: { active: boolean; remaining: number; cooldown: number; killsInWindow: number };
  };
  squads: ObsSquad[];
  unassigned: number[];
  enemies: {
    visible: (ObsActor & { kind: string })[];
    lastKnown: { id: number; x: number; y: number; age: number }[];
    enemyStreakActive: boolean;
  };
  terrain: { width: number; height: number; obstacles: Rect[]; supply: { x: number; y: number }; zone: Rect; enemyZone: Rect };
  resources: { pickup: { x: number; y: number } | null; nextPickupIn: number; nextWaveIn: number; waveBase: number };
  legal: {
    stances: string[];
    doctrines: string[];
    formations: string[];
    mainGoals: string[];
    freeSlots: number[];
    maxSquadSize: number;
  };
  budget: { deadlineMs: number; maxActions: number };
}

export type ActionCommand =
  | 'SetStance'
  | 'CreateSquad'
  | 'DisbandSquad'
  | 'MoveSquad'
  | 'FollowUnit'
  | 'HoldPosition'
  | 'SetDoctrine'
  | 'SetFormation'
  | 'SetTarget'
  | 'SetLeader'
  | 'SetRally'
  | 'MainGoal';

export interface AIAction {
  command: ActionCommand;
  /** acting entity: a squad slot (1-9) for squad commands */
  squad?: number;
  /** actor id (the Main for MainGoal, soldier for SetLeader) */
  actor?: number;
  target?: { id?: number; x?: number; y?: number; kind?: string };
  destination?: { x: number; y: number };
  doctrine?: string;
  formation?: string;
  stance?: string;
  goal?: string;
  members?: number[];
  /** observation generation the action is based on, issue/expiry in simulation ticks */
  generation: number;
  issuedAt: number;
  expiresAt: number;
  confidence?: number;
}

export interface DecideResponse {
  schema: typeof ACT_SCHEMA;
  generation: number;
  actions: AIAction[];
  meta?: {
    policy?: string;
    agents?: string[];
    latencyMs?: number;
    objectives?: Record<string, string>;
    fallback?: boolean;
    note?: string;
  };
}
