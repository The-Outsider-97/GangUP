import type { Command, CommandEnvelope, Team } from '../engine/types.js';
import type { AIAction } from './schema.js';

const COMMANDS = new Set([
  'SetStance', 'CreateSquad', 'DisbandSquad', 'MoveSquad', 'FollowUnit', 'HoldPosition',
  'SetDoctrine', 'SetFormation', 'SetTarget', 'SetLeader', 'SetRally', 'MainGoal',
]);

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export type Translated = { ok: true; cmd: Command } | { ok: false; reason: string };

/**
 * Translate a wire-format AI action into an engine command. Missing identifiers are rejected here; stale generations,
 * ownership, visibility and reachability are rejected by the engine (executeCommand) — defence in depth (GDD 12.4).
 */
export function translateAction(a: AIAction, ownMainId: number): Translated {
  if (!a || typeof a !== 'object' || !COMMANDS.has(a.command)) return { ok: false, reason: 'unknown-command' };
  if (!num(a.generation) || !num(a.issuedAt) || !num(a.expiresAt)) return { ok: false, reason: 'missing-envelope' };
  const slot = a.squad;
  const needSquad = !['SetStance', 'MainGoal'].includes(a.command);
  if (needSquad && !(Number.isInteger(slot) && slot! >= 1 && slot! <= 9)) return { ok: false, reason: 'missing-squad-id' };
  switch (a.command) {
    case 'SetStance':
      if (a.stance !== 'defensive' && a.stance !== 'offensive') return { ok: false, reason: 'bad-stance' };
      return { ok: true, cmd: { t: 'Stance', stance: a.stance } };
    case 'CreateSquad':
      if (!Array.isArray(a.members) || !a.members.every(Number.isInteger)) return { ok: false, reason: 'missing-members' };
      return { ok: true, cmd: { t: 'CreateSquad', slot: slot!, members: a.members } };
    case 'DisbandSquad':
      return { ok: true, cmd: { t: 'DisbandSquad', slot: slot! } };
    case 'MoveSquad':
      if (!a.destination || !num(a.destination.x) || !num(a.destination.y)) return { ok: false, reason: 'missing-destination' };
      return { ok: true, cmd: { t: 'SquadMove', slot: slot!, x: a.destination.x, y: a.destination.y } };
    case 'FollowUnit':
      if (!a.target || !Number.isInteger(a.target.id)) return { ok: false, reason: 'missing-target-id' };
      return { ok: true, cmd: { t: 'SquadFollow', slot: slot!, targetId: a.target.id! } };
    case 'HoldPosition':
      return { ok: true, cmd: { t: 'SquadHold', slot: slot! } };
    case 'SetDoctrine':
      if (!a.doctrine) return { ok: false, reason: 'missing-doctrine' };
      return { ok: true, cmd: { t: 'SquadDoctrine', slot: slot!, doctrine: a.doctrine as any } };
    case 'SetFormation':
      if (!a.formation) return { ok: false, reason: 'missing-formation' };
      return { ok: true, cmd: { t: 'SquadFormation', slot: slot!, formation: a.formation as any } };
    case 'SetTarget': {
      const t = a.target;
      if (!t || t.kind === 'none') return { ok: true, cmd: { t: 'SquadTarget', slot: slot!, kind: 'none' } };
      if (Number.isInteger(t.id)) return { ok: true, cmd: { t: 'SquadTarget', slot: slot!, kind: (t.kind === 'squad' ? 'squad' : 'unit'), id: t.id } };
      if (num(t.x) && num(t.y)) return { ok: true, cmd: { t: 'SquadTarget', slot: slot!, kind: 'area', x: t.x, y: t.y } };
      return { ok: false, reason: 'missing-target' };
    }
    case 'SetLeader':
      if (!Number.isInteger(a.actor)) return { ok: false, reason: 'missing-actor-id' };
      return { ok: true, cmd: { t: 'SquadLeader', slot: slot!, soldierId: a.actor! } };
    case 'SetRally':
      if (!a.destination || !num(a.destination.x) || !num(a.destination.y)) return { ok: false, reason: 'missing-destination' };
      return { ok: true, cmd: { t: 'SquadRally', slot: slot!, x: a.destination.x, y: a.destination.y } };
    case 'MainGoal': {
      if (a.actor !== ownMainId) return { ok: false, reason: 'not-own-main' };
      if (!a.goal) return { ok: false, reason: 'missing-goal' };
      const d = a.destination ?? { x: NaN, y: NaN };
      if (!num(d.x) || !num(d.y)) return { ok: false, reason: 'missing-destination' };
      return { ok: true, cmd: { t: 'MainGoal', goal: { kind: a.goal as any, x: d.x, y: d.y, targetId: a.target && Number.isInteger(a.target.id) ? a.target.id! : -1 } } };
    }
    default:
      return { ok: false, reason: 'unknown-command' };
  }
}

export function toEnvelope(a: AIAction, team: Team, cmd: Command, source: 'slai' | 'baseline', issuedAt: number): CommandEnvelope {
  return { source, team, cmd, generation: a.generation, issuedAt, expiresAt: a.expiresAt };
}
