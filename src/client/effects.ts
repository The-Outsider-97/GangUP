/**
 * Visual-only impact feedback (nothing here touches the simulation, its RNG or the replay).
 *
 *  - ImpactTracker: when an actor is hit, or hits something, it is nudged and vibrates for a very short time. The victim is
 *    pushed away from the attacker, the shooter recoils against its aim, a sword attacker lunges forward.
 *  - ScreenShake: a short camera tremor when the player's own Main is hurt.
 *
 * Durations are wall-clock milliseconds with a minimum number of *rendered frames*, so "a frame or two" is visible on a 60 Hz and
 * on a 144 Hz display alike. Tune everything in IMPACT.
 */
export const IMPACT = {
  victimMs: 70, // how long a hit actor shakes
  shooterMs: 45, // how long a shooter / swordsman is displaced
  minFrames: 2, // never shorter than this many rendered frames
  victimPush: 3.2, // px at full strength, away from the attacker
  shooterRecoil: 1.6, // px, opposite to the aim
  swordLunge: 2.6, // px, along the swing
  jitter: 1.5, // px of random vibration at full strength
  flashMs: 60, // white flash on the victim's body
  shakeMs: 130, // camera tremor after the player's Main is hurt
  shakeMax: 5, // px
  hurtMs: 260, // red edge pulse after the player's Main is hurt
} as const;

export interface Offset { x: number; y: number }
const ZERO: Offset = { x: 0, y: 0 };

type Kick = { t0: number; f0: number; ms: number; dx: number; dy: number; push: number; jitter: number; flash: number };

/** Small deterministic hash in [0,1) so the vibration looks random but is the same on every run. */
function hash01(a: number, b: number): number {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

function unit(dx: number, dy: number): { x: number; y: number } {
  const l = Math.hypot(dx, dy);
  return l > 1e-6 ? { x: dx / l, y: dy / l } : { x: 0, y: 0 };
}

export class ImpactTracker {
  private kicks = new Map<number, Kick>();
  private frame = 0;

  constructor(private now: () => number = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())) {}

  /** Call once per rendered frame before reading offsets. */
  beginFrame(): void {
    this.frame++;
    if (this.kicks.size > 64) for (const [id] of this.kicks) if (!this.live(id)) this.kicks.delete(id);
  }

  /** `from` is the direction the damage travels (attacker → victim, world coordinates). strength 0..1. */
  hit(victimId: number, fromX: number, fromY: number, strength = 1): void {
    const d = unit(fromX, fromY);
    this.set(victimId, { ms: IMPACT.victimMs, dx: d.x, dy: d.y, push: IMPACT.victimPush * strength, jitter: IMPACT.jitter * strength, flash: strength });
  }

  /** The shooter's recoil: pushed back against its aim (aim = the direction it fired in). */
  recoil(actorId: number, aimX: number, aimY: number): void {
    const d = unit(aimX, aimY);
    this.set(actorId, { ms: IMPACT.shooterMs, dx: -d.x, dy: -d.y, push: IMPACT.shooterRecoil, jitter: IMPACT.jitter * 0.4, flash: 0 }, true);
  }

  /** A sword swing: the attacker lunges along the swing. */
  lunge(actorId: number, aimX: number, aimY: number): void {
    const d = unit(aimX, aimY);
    this.set(actorId, { ms: IMPACT.shooterMs, dx: d.x, dy: d.y, push: IMPACT.swordLunge, jitter: IMPACT.jitter * 0.5, flash: 0 }, true);
  }

  private set(id: number, k: Omit<Kick, 't0' | 'f0'>, weak = false): void {
    const old = this.kicks.get(id);
    if (weak && old && this.live(id) && old.push > k.push) return; // a recoil never replaces a stronger hit reaction
    this.kicks.set(id, { ...k, t0: this.now(), f0: this.frame });
  }

  private live(id: number): boolean {
    const k = this.kicks.get(id);
    if (!k) return false;
    return this.now() - k.t0 < k.ms || this.frame - k.f0 < IMPACT.minFrames;
  }

  /** Screen-space displacement in pixels for this actor right now (zero when it has no active kick). */
  offset(id: number): Offset {
    const k = this.kicks.get(id);
    if (!k || !this.live(id)) return ZERO;
    const env = Math.max(0.3, 1 - (this.now() - k.t0) / k.ms);
    const jx = (hash01(id, this.frame * 2) * 2 - 1) * k.jitter * env;
    const jy = (hash01(id, this.frame * 2 + 1) * 2 - 1) * k.jitter * env;
    return { x: k.dx * k.push * env + jx, y: k.dy * k.push * env + jy };
  }

  /** 0..1 white flash on a hit actor's body. */
  flash(id: number): number {
    const k = this.kicks.get(id);
    if (!k || k.flash <= 0) return 0;
    const age = this.now() - k.t0;
    return age < IMPACT.flashMs || this.frame - k.f0 < IMPACT.minFrames ? k.flash * Math.max(0.35, 1 - age / IMPACT.flashMs) : 0;
  }

  get active(): number {
    let n = 0;
    for (const [id] of this.kicks) if (this.live(id)) n++;
    return n;
  }
}

export class ScreenShake {
  private t0 = -1e9;
  private mag = 0;
  private hurtAt = -1e9;
  private hurt = 0;
  private frame = 0;
  private f0 = -99;

  constructor(private now: () => number = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())) {}

  beginFrame(): void { this.frame++; }

  /** The player's Main was hurt: tremor proportional to the damage (0..1). */
  hurtMain(strength: number): void {
    const s = Math.max(0, Math.min(1, strength));
    this.mag = Math.max(this.currentMag(), IMPACT.shakeMax * (0.35 + 0.65 * s));
    this.t0 = this.now();
    this.f0 = this.frame;
    this.hurtAt = this.t0;
    this.hurt = Math.max(0.35, s);
  }

  private currentMag(): number {
    return this.now() - this.t0 < IMPACT.shakeMs ? this.mag * (1 - (this.now() - this.t0) / IMPACT.shakeMs) : 0;
  }

  offset(): Offset {
    const age = this.now() - this.t0;
    if (age >= IMPACT.shakeMs && this.frame - this.f0 >= IMPACT.minFrames) return ZERO;
    const env = Math.max(0.3, 1 - age / IMPACT.shakeMs);
    return { x: (hash01(7, this.frame * 2) * 2 - 1) * this.mag * env, y: (hash01(11, this.frame * 2 + 1) * 2 - 1) * this.mag * env };
  }

  /** 0..1 red edge pulse right after being hurt. */
  hurtPulse(): number {
    const age = this.now() - this.hurtAt;
    return age < IMPACT.hurtMs ? this.hurt * (1 - age / IMPACT.hurtMs) : 0;
  }
}

/** Heartbeat-style red vignette for a nearly dead Main: 0 above 20 HP, a slow pulse below 20, a fast and stronger one below 10. */
export function lowHpVignette(hp: number, frame: number): number {
  if (hp <= 0 || hp >= 20) return 0;
  const critical = hp < 10;
  const speed = critical ? 0.2 : 0.11;
  const base = critical ? 0.22 : 0.1;
  const amp = critical ? 0.16 : 0.07;
  return base + amp * (0.5 + 0.5 * Math.sin(frame * speed));
}
