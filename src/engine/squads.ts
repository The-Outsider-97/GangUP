import { FORMATION_SPACING, SQUAD } from './constants.js';
import { isFree } from './arena.js';
import type { Match } from './match.js';
import type { Actor, CommandResult, Squad, Team } from './types.js';

export function newSquad(slot: number): Squad {
  return {
    slot,
    members: [],
    leader: -1,
    move: { kind: 'None', x: 0, y: 0, followId: -1, orient: 0 },
    doctrine: 'Defend',
    formation: 'Compact',
    target: { kind: 'none', id: -1, x: 0, y: 0 },
    rally: null,
    blockedCount: 0,
    lastOrderTick: -1,
  };
}

export const squadOf = (m: Match, a: Actor): Squad | null => (a.squadSlot ? m.teams[a.team].squads[a.squadSlot - 1] : null);

export function livingMembers(m: Match, sq: Squad): Actor[] {
  const out: Actor[] = [];
  for (const id of sq.members) {
    const a = m.actors.get(id);
    if (a && a.alive) out.push(a);
  }
  return out;
}

export function squadCentroid(m: Match, sq: Squad): { x: number; y: number } | null {
  const ms = livingMembers(m, sq);
  if (!ms.length) return null;
  let x = 0;
  let y = 0;
  for (const a of ms) { x += a.x; y += a.y; }
  return { x: x / ms.length, y: y / ms.length };
}

/** Where a squad falls back to: its rally point, or its Main by default. */
export function fallbackPoint(m: Match, team: Team, sq: Squad): { x: number; y: number } {
  if (sq.rally) return sq.rally;
  const main = m.actors.get(m.teams[team].mainId)!;
  return { x: main.x, y: main.y };
}

// ----------------------------------------------------------------- roster management (atomic)
function detach(m: Match, ids: number[]): void {
  const set = new Set(ids);
  for (const t of m.teams) {
    for (const sq of t.squads) {
      if (!sq.members.some((id) => set.has(id))) continue;
      sq.members = sq.members.filter((id) => !set.has(id));
      if (!sq.members.includes(sq.leader)) sq.leader = pickLeader(m, sq);
    }
  }
  for (const id of ids) {
    const a = m.actors.get(id);
    if (a) a.squadSlot = 0;
  }
}

function pickLeader(m: Match, sq: Squad): number {
  let best = -1;
  for (const id of sq.members) {
    const a = m.actors.get(id);
    if (a && a.alive && (best < 0 || id < best)) best = id; // replacement: lowest living unit ID (10.4)
  }
  return best;
}

export function createSquad(m: Match, team: Team, slot: number, members: number[]): CommandResult {
  if (!Number.isInteger(slot) || slot < 1 || slot > SQUAD.slots) return { ok: false, reason: 'bad-slot' };
  const uniq = [...new Set(members)];
  if (uniq.length > SQUAD.maxMembers) return { ok: false, reason: 'squad-full' };
  for (const id of uniq) {
    const a = m.actors.get(id);
    if (!a || !a.alive || a.team !== team || a.kind !== 'soldier') return { ok: false, reason: 'bad-member' };
  }
  const ts = m.teams[team];
  const sq = ts.squads[slot - 1];
  // Atomic transfer: old rosters and the new roster change together.
  detach(m, sq.members.slice());
  detach(m, uniq);
  sq.members = uniq.sort((p, q) => p - q);
  for (const id of sq.members) {
    const a = m.actors.get(id)!;
    a.squadSlot = slot;
    a.ai.bodyguard = false;
  }
  ts.bodyguards = ts.bodyguards.filter((id) => !sq.members.includes(id));
  sq.leader = pickLeader(m, sq);
  sq.lastOrderTick = m.tick;
  const c = squadCentroid(m, sq);
  if (c && sq.move.kind === 'None') {
    sq.move = { kind: 'Hold', x: c.x, y: c.y, followId: -1, orient: m.actors.get(ts.mainId)!.theta };
  }
  return { ok: true };
}

export function disbandSquad(m: Match, team: Team, slot: number): CommandResult {
  if (slot < 1 || slot > SQUAD.slots) return { ok: false, reason: 'bad-slot' };
  const sq = m.teams[team].squads[slot - 1];
  detach(m, sq.members.slice());
  m.teams[team].squads[slot - 1] = newSquad(slot);
  return { ok: true };
}

export function addToSquad(m: Match, team: Team, slot: number, members: number[]): CommandResult {
  if (slot < 1 || slot > SQUAD.slots) return { ok: false, reason: 'bad-slot' };
  const sq = m.teams[team].squads[slot - 1];
  const merged = [...new Set([...sq.members, ...members])];
  if (merged.length > SQUAD.maxMembers) return { ok: false, reason: 'squad-full' };
  const keepLeader = sq.leader;
  const r = createSquad(m, team, slot, merged);
  if (r.ok && keepLeader >= 0 && sq.members.includes(keepLeader)) sq.leader = keepLeader;
  return r;
}

export function removeFromSquad(m: Match, team: Team, members: number[]): CommandResult {
  const ids = members.filter((id) => m.actors.get(id)?.team === team);
  detach(m, ids);
  return { ok: true };
}

/** Called whenever a soldier dies: roster, leader, follow and target references are repaired (GDD 3.3, 10.4). */
export function onActorDeath(m: Match, a: Actor): void {
  const ts = m.teams[a.team];
  if (a.kind === 'soldier') {
    detach(m, [a.id]);
    ts.bodyguards = ts.bodyguards.filter((id) => id !== a.id);
  }
  for (const sq of ts.squads) {
    if (sq.move.kind === 'Follow' && sq.move.followId === a.id) {
      const fb = fallbackPoint(m, a.team, sq);
      sq.move = { kind: 'Move', x: fb.x, y: fb.y, followId: -1, orient: sq.move.orient }; // doctrine unchanged
    }
    if (sq.target.kind !== 'none' && sq.target.id === a.id) sq.target = { kind: 'none', id: -1, x: 0, y: 0 };
  }
  // the opposing team may have had this unit as a designated target
  const other = m.teams[(1 - a.team) as Team];
  for (const sq of other.squads) {
    if (sq.target.kind !== 'none' && sq.target.id === a.id) sq.target = { kind: 'none', id: -1, x: 0, y: 0 };
  }
}

// ----------------------------------------------------------------- follow-cycle guard (10.4)
export function followWouldCycle(m: Match, team: Team, slot: number, targetId: number): boolean {
  const ts = m.teams[team];
  let curSlot = slot;
  let tid = targetId;
  for (let hops = 0; hops < SQUAD.slots + 1; hops++) {
    const t = m.actors.get(tid);
    if (!t) return false;
    if (t.squadSlot === 0) return false;
    if (t.squadSlot === curSlot) return true; // following a member of its own squad / back to itself
    const next = ts.squads[t.squadSlot - 1];
    if (next.move.kind !== 'Follow') return false;
    curSlot = t.squadSlot;
    tid = next.move.followId;
    if (curSlot === slot) return true;
  }
  return true;
}

// ----------------------------------------------------------------- anchors and formations
export function squadAnchor(m: Match, team: Team, sq: Squad): { x: number; y: number; orient: number } {
  const main = m.actors.get(m.teams[team].mainId)!;
  if (sq.move.kind === 'Follow') {
    const t = m.actors.get(sq.move.followId);
    if (t && t.alive) {
      return { x: t.x - Math.cos(t.theta) * 2.5, y: t.y - Math.sin(t.theta) * 2.5, orient: t.theta };
    }
    const fb = fallbackPoint(m, team, sq);
    return { x: fb.x, y: fb.y, orient: sq.move.orient };
  }
  if (sq.move.kind === 'None') return { x: main.x, y: main.y, orient: main.theta };
  return { x: sq.move.x, y: sq.move.y, orient: sq.move.orient };
}

export function formationSlots(n: number, formation: Squad['formation'], orient: number, ax: number, ay: number): { x: number; y: number }[] {
  const s = FORMATION_SPACING[formation];
  const out: { x: number; y: number }[] = [];
  const cols = formation === 'Line' ? n : Math.max(1, Math.ceil(Math.sqrt(n * (formation === 'Spread' ? 1.4 : 1))));
  for (let i = 0; i < n; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    let lx = -row * s;
    let ly = (col - (cols - 1) / 2) * s;
    if (formation === 'Spread' && row % 2 === 1) ly += s / 2;
    out.push({ x: ax + lx * Math.cos(orient) - ly * Math.sin(orient), y: ay + lx * Math.sin(orient) + ly * Math.cos(orient) });
  }
  return out;
}

/** The slot a squad member should hold: leader takes slot 0 at the anchor, others follow in ID order. */
export function memberSlot(m: Match, s: Actor): { x: number; y: number } | null {
  const sq = squadOf(m, s);
  if (!sq) return null;
  const anchor = squadAnchor(m, s.team, sq);
  const order = livingMembers(m, sq).sort((p, q) => (p.id === sq.leader ? -1 : q.id === sq.leader ? 1 : p.id - q.id));
  const idx = order.findIndex((a) => a.id === s.id);
  if (idx < 0) return { x: anchor.x, y: anchor.y };
  const slots = formationSlots(order.length, sq.formation, anchor.orient, anchor.x, anchor.y);
  let p = slots[idx];
  if (!isFree(m.arena, p.x, p.y, 0.4)) {
    const f = m.nav.nearestFree('small', p.x, p.y);
    if (f) p = f;
  }
  return p;
}

// ----------------------------------------------------------------- bodyguards and stance (10.5)
export function bodyguardPosition(m: Match, team: Team, idx: number, count: number): { x: number; y: number } {
  const ts = m.teams[team];
  const main = m.actors.get(ts.mainId)!;
  const ang0 = ts.stance === 'defensive' ? main.theta + Math.PI : main.theta;
  const spread = ts.stance === 'defensive' ? Math.PI * 2 : Math.PI * 0.9;
  const radius = ts.stance === 'defensive' ? 2.4 : 3.2;
  const a = count <= 1 ? ang0 : ts.stance === 'defensive' ? ang0 + (idx / count) * spread : ang0 - spread / 2 + (idx / (count - 1)) * spread;
  let p = { x: main.x + Math.cos(a) * radius, y: main.y + Math.sin(a) * radius };
  if (!isFree(m.arena, p.x, p.y, 0.4)) {
    const f = m.nav.nearestFree('small', p.x, p.y);
    if (f) p = f;
  }
  return p;
}

export function updateBodyguards(m: Match, team: Team): void {
  const ts = m.teams[team];
  const main = m.actors.get(ts.mainId)!;
  if (!main.alive) return;
  const want = ts.stance === 'defensive' ? SQUAD.bodyguardsDefensive : SQUAD.bodyguardsOffensive;
  ts.bodyguards = ts.bodyguards.filter((id) => {
    const a = m.actors.get(id);
    return !!a && a.alive && a.squadSlot === 0;
  });
  const need = ts.bodyguards.length !== want;
  if (!need && ts.bodyguards.every((id) => m.actors.get(id)!.ai.bodyguard)) return;
  if (m.tick < ts.bodyguardLockoutUntil) return; // 1.0 s reassignment lockout
  const pool = m.live
    .filter((a) => a.alive && a.team === team && a.kind === 'soldier' && a.squadSlot === 0)
    .sort((p, q) => Math.hypot(p.x - main.x, p.y - main.y) - Math.hypot(q.x - main.x, q.y - main.y) || p.id - q.id);
  const keep = new Set(ts.bodyguards.slice(0, want));
  for (const a of pool) if (keep.size < want && !keep.has(a.id)) keep.add(a.id);
  const next = [...keep].sort((p, q) => p - q);
  const changed = next.length !== ts.bodyguards.length || next.some((id, i) => id !== ts.bodyguards[i]);
  for (const a of pool) a.ai.bodyguard = keep.has(a.id);
  ts.bodyguards = next;
  if (changed) ts.bodyguardLockoutUntil = m.tick + SQUAD.bodyguardLockout;
}

/** Squad-level tactical controller, 2 Hz (1–5 Hz budget): leader repair, follow-cycle breaking, HUD flags. */
export function squadControl(m: Match): void {
  for (const ts of m.teams) {
    updateBodyguards(m, ts.id);
    for (const sq of ts.squads) {
      if (!sq.members.length) { sq.blockedCount = 0; continue; }
      if (!sq.members.includes(sq.leader)) sq.leader = pickLeader(m, sq);
      if (sq.move.kind === 'Follow' && followWouldCycle(m, ts.id, sq.slot, sq.move.followId)) {
        const c = squadCentroid(m, sq);
        if (c) sq.move = { kind: 'Hold', x: c.x, y: c.y, followId: -1, orient: sq.move.orient };
      }
      let blocked = 0;
      for (const id of sq.members) if (m.actors.get(id)?.ai.blocked) blocked++;
      sq.blockedCount = blocked;
    }
  }
}

