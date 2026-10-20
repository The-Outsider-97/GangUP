import { CUES, MUSIC_CUE, cueOfFile, type Channel, type CueId, type MusicTrack } from './cues.js';

/**
 * AudioManager: plays the cues of the catalogue with a mixer (Master / Effects / Music), rate limits, random variants, music
 * crossfades, and a graceful "no file, no sound" policy. Browsers only allow audio after a user gesture, so everything requested
 * before that (the home-page music, for instance) is remembered and starts as soon as `unlock()` succeeds.
 *
 * The Web Audio part lives behind `AudioBackend`, so the logic is testable without a browser and the game runs silently where
 * there is no audio at all.
 */
export interface Voice {
  stop(fadeMs?: number): void;
}

export interface PlayParams {
  gain: number;
  pan: number;
  rate: number;
  loop: boolean;
  channel: Channel;
  fadeInMs: number;
}

export interface AudioBackend {
  readonly available: boolean;
  unlock(): Promise<boolean>;
  /** decoded sound, or null when the file is missing or cannot be decoded */
  load(url: string): Promise<unknown | null>;
  play(sound: unknown, p: PlayParams): Voice;
  /** final gain of a mixer channel (master, mute and slider already applied) */
  setChannelGain(ch: Channel, gain: number): void;
  now(): number;
  fetchJson(url: string): Promise<unknown | null>;
}

export interface PlayOptions {
  /** extra gain 0..1 (distance falloff) */
  volume?: number;
  /** -1 (left) .. 1 (right) */
  pan?: number;
  /** playback rate, 1 = original */
  rate?: number;
}

export interface AudioSettings {
  master: number;
  sfx: number;
  music: number;
  muted: boolean;
}

export const DEFAULT_SETTINGS: AudioSettings = { master: 0.8, sfx: 1, music: 0.6, muted: false };
const STORAGE_KEY = 'gangup.audio.v1';
const DUCK = 0.35; // music level while the game is paused

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

class NullVoice implements Voice {
  stop(): void { /* nothing is playing */ }
}

export class NullBackend implements AudioBackend {
  readonly available = false;
  async unlock(): Promise<boolean> { return false; }
  async load(): Promise<unknown | null> { return null; }
  play(): Voice { return new NullVoice(); }
  setChannelGain(): void { /* no mixer */ }
  now(): number { return Date.now(); }
  async fetchJson(): Promise<unknown | null> { return null; }
}

export class WebAudioBackend implements AudioBackend {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private groups = new Map<Channel, GainNode>();
  private pending = new Map<Channel, number>();
  readonly available: boolean;

  constructor() {
    const w = typeof window !== 'undefined' ? (window as unknown as { AudioContext?: unknown; webkitAudioContext?: unknown }) : undefined;
    this.available = !!(w && (w.AudioContext || w.webkitAudioContext));
  }

  private ensure(): AudioContext | null {
    if (!this.available) return null;
    if (this.ctx) return this.ctx;
    try {
      const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
      const Ctor = (w.AudioContext ?? w.webkitAudioContext) as typeof AudioContext;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      for (const ch of ['sfx', 'ui', 'music'] as Channel[]) {
        const g = this.ctx.createGain();
        g.gain.value = this.pending.get(ch) ?? 1;
        g.connect(this.master);
        this.groups.set(ch, g);
      }
    } catch {
      this.ctx = null;
    }
    return this.ctx;
  }

  async unlock(): Promise<boolean> {
    const ctx = this.ensure();
    if (!ctx) return false;
    try {
      if (ctx.state === 'suspended') await ctx.resume();
    } catch { /* needs another gesture */ }
    return ctx.state === 'running';
  }

  async load(url: string): Promise<unknown | null> {
    const ctx = this.ensure();
    if (!ctx) return null;
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      return await ctx.decodeAudioData(await r.arrayBuffer());
    } catch {
      return null;
    }
  }

  async fetchJson(url: string): Promise<unknown | null> {
    try {
      const r = await fetch(url, { cache: 'no-cache' });
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  }

  play(sound: unknown, p: PlayParams): Voice {
    const ctx = this.ensure();
    const group = this.groups.get(p.channel);
    if (!ctx || !group || ctx.state !== 'running') return new NullVoice();
    const src = ctx.createBufferSource();
    src.buffer = sound as AudioBuffer;
    src.loop = p.loop;
    src.playbackRate.value = p.rate;
    const gain = ctx.createGain();
    const t = ctx.currentTime;
    if (p.fadeInMs > 0) {
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(p.gain, t + p.fadeInMs / 1000);
    } else gain.gain.value = p.gain;
    let tail: AudioNode = src;
    src.connect(gain);
    tail = gain;
    if (p.pan !== 0 && typeof ctx.createStereoPanner === 'function') {
      const pan = ctx.createStereoPanner();
      pan.pan.value = Math.max(-1, Math.min(1, p.pan));
      tail.connect(pan);
      tail = pan;
    }
    tail.connect(group);
    src.start();
    let stopped = false;
    src.onended = () => { try { tail.disconnect(); } catch { /* already gone */ } };
    return {
      stop: (fadeMs = 0) => {
        if (stopped) return;
        stopped = true;
        try {
          if (fadeMs > 0) {
            const n = ctx.currentTime;
            gain.gain.cancelScheduledValues(n);
            gain.gain.setValueAtTime(gain.gain.value, n);
            gain.gain.linearRampToValueAtTime(0, n + fadeMs / 1000);
            src.stop(n + fadeMs / 1000 + 0.02);
          } else src.stop();
        } catch { /* already stopped */ }
      },
    };
  }

  setChannelGain(ch: Channel, gain: number): void {
    this.pending.set(ch, gain);
    const g = this.groups.get(ch);
    if (g && this.ctx) g.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.03);
  }

  now(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }
}

export interface AudioReport {
  available: boolean;
  unlocked: boolean;
  manifest: boolean;
  /** cue -> number of files loaded */
  loaded: Record<string, number>;
  missingCore: string[];
  played: Record<string, number>;
  skippedNoFile: Record<string, number>;
}

export class AudioManager {
  settings: AudioSettings;
  private sounds = new Map<CueId, unknown[]>();
  private lastPlay = new Map<CueId, number>();
  private lastVariant = new Map<CueId, number>();
  private active = new Map<CueId, Voice[]>();
  private loops = new Map<CueId, Voice>();
  private played: Record<string, number> = {};
  private noFile: Record<string, number> = {};
  private unlocked = false;
  private manifest: Record<string, string[]> | null = null;
  private loading: Promise<void> | null = null;
  private wantMusic: MusicTrack | null = null;
  private music: { track: MusicTrack; voice: Voice } | null = null;
  private ducked = false;
  private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null;

  constructor(private backend: AudioBackend = typeof window !== 'undefined' ? new WebAudioBackend() : new NullBackend(), private baseUrl = 'assets/audio/', storage?: Pick<Storage, 'getItem' | 'setItem'> | null) {
    this.storage = storage === undefined ? safeStorage() : storage;
    this.settings = this.readSettings();
    this.applyMixer();
  }

  // ------------------------------------------------------------------ settings
  private readSettings(): AudioSettings {
    try {
      const raw = this.storage?.getItem(STORAGE_KEY);
      if (raw) {
        const d = JSON.parse(raw) as Partial<AudioSettings>;
        return { master: clamp01(d.master ?? DEFAULT_SETTINGS.master), sfx: clamp01(d.sfx ?? DEFAULT_SETTINGS.sfx), music: clamp01(d.music ?? DEFAULT_SETTINGS.music), muted: !!d.muted };
      }
    } catch { /* storage unavailable or corrupt: defaults */ }
    return { ...DEFAULT_SETTINGS };
  }

  private applyMixer(): void {
    const m = this.settings.muted ? 0 : this.settings.master;
    this.backend.setChannelGain('sfx', m * this.settings.sfx);
    this.backend.setChannelGain('ui', m * this.settings.sfx);
    this.backend.setChannelGain('music', m * this.settings.music * (this.ducked ? DUCK : 1));
  }

  set(key: 'master' | 'sfx' | 'music', value: number): void {
    this.settings[key] = clamp01(value);
    this.persist();
  }

  setMuted(muted: boolean): void {
    this.settings.muted = muted;
    this.persist();
  }

  toggleMuted(): boolean {
    this.setMuted(!this.settings.muted);
    return this.settings.muted;
  }

  private persist(): void {
    this.applyMixer();
    try { this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.settings)); } catch { /* private mode */ }
  }

  // ------------------------------------------------------------------ loading and unlocking
  /** Call from the first user gesture (click / key). Safe to call many times. */
  async unlock(): Promise<void> {
    if (!this.backend.available) return;
    if (!this.unlocked) this.unlocked = await this.backend.unlock();
    if (!this.unlocked) return;
    await this.load();
    this.applyMusic();
  }

  /** Reads `manifest.json` (written by `npm run build` from the files in assets/audio) and decodes every listed file once. */
  load(): Promise<void> {
    this.loading ??= (async () => {
      const raw = await this.backend.fetchJson(this.baseUrl + 'manifest.json');
      if (!raw || typeof raw !== 'object') { this.manifest = null; return; }
      const mf: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (k in CUES && Array.isArray(v)) mf[k] = v.filter((f): f is string => typeof f === 'string' && cueOfFile(f) === k);
      }
      this.manifest = mf;
      await Promise.all(Object.entries(mf).map(async ([cue, files]) => {
        const loaded: unknown[] = [];
        for (const f of files) {
          const s = await this.backend.load(this.baseUrl + encodeURIComponent(f));
          if (s) loaded.push(s);
        }
        if (loaded.length) this.sounds.set(cue as CueId, loaded);
      }));
    })();
    return this.loading;
  }

  /** True when this cue has at least one decoded file. */
  has(id: CueId): boolean {
    return (this.sounds.get(id)?.length ?? 0) > 0;
  }

  // ------------------------------------------------------------------ one-shot sounds
  play(id: CueId, o: PlayOptions = {}): boolean {
    const spec = CUES[id];
    if (!this.unlocked || this.settings.muted) return false;
    const files = this.sounds.get(id);
    if (!files || !files.length) {
      this.noFile[id] = (this.noFile[id] ?? 0) + 1;
      return false;
    }
    const now = this.backend.now();
    if (spec.gap && now - (this.lastPlay.get(id) ?? -1e9) < spec.gap) return false;
    const voices = (this.active.get(id) ?? []);
    const maxVoices = (spec as { voices?: number }).voices ?? 8;
    if (voices.length >= maxVoices) { voices.shift()?.stop(30); } // oldest voice makes room
    this.lastPlay.set(id, now);
    const pick = this.pickVariant(id, files.length);
    const voice = this.backend.play(files[pick], {
      gain: clamp01(spec.vol * (o.volume ?? 1)), pan: o.pan ?? 0, rate: o.rate ?? 1, loop: !!spec.loop, channel: spec.ch, fadeInMs: 0,
    });
    voices.push(voice);
    this.active.set(id, voices);
    // voices that ended on their own are dropped lazily: keep the list bounded
    if (voices.length > 16) voices.splice(0, voices.length - 16);
    this.played[id] = (this.played[id] ?? 0) + 1;
    return true;
  }

  private pickVariant(id: CueId, n: number): number {
    if (n <= 1) return 0;
    let i = Math.floor(Math.random() * n);
    if (i === this.lastVariant.get(id)) i = (i + 1) % n; // never the same variant twice in a row
    this.lastVariant.set(id, i);
    return i;
  }

  // ------------------------------------------------------------------ loops (heartbeat ...)
  setLoop(id: CueId, on: boolean): void {
    const cur = this.loops.get(id);
    if (!on) {
      if (cur) { cur.stop(250); this.loops.delete(id); }
      return;
    }
    if (cur || !this.unlocked || this.settings.muted) return;
    const files = this.sounds.get(id);
    if (!files?.length) return;
    this.loops.set(id, this.backend.play(files[0], { gain: CUES[id].vol, pan: 0, rate: 1, loop: true, channel: CUES[id].ch, fadeInMs: 200 }));
    this.played[id] = (this.played[id] ?? 0) + 1;
  }

  // ------------------------------------------------------------------ music
  /** The track that should be playing (null = silence). Crossfades; starts later if the browser is still locked. */
  setMusic(track: MusicTrack | null): void {
    this.wantMusic = track;
    this.applyMusic();
  }

  private applyMusic(): void {
    if (this.music && this.music.track === this.wantMusic) return;
    if (!this.unlocked) return;
    if (this.music) { this.music.voice.stop(700); this.music = null; }
    const track = this.wantMusic;
    if (!track) return;
    const id = MUSIC_CUE[track];
    const files = this.sounds.get(id);
    if (!files?.length) return; // no file: stay silent (retried after the files finish loading)
    const voice = this.backend.play(files[0], { gain: CUES[id].vol, pan: 0, rate: 1, loop: true, channel: 'music', fadeInMs: 900 });
    this.music = { track, voice };
    this.played[id] = (this.played[id] ?? 0) + 1;
  }

  /** Lower the music while the game is paused. */
  duck(on: boolean): void {
    this.ducked = on;
    this.applyMixer();
  }

  stopAll(): void {
    for (const v of this.loops.values()) v.stop(100);
    this.loops.clear();
    for (const list of this.active.values()) for (const v of list) v.stop(50);
    this.active.clear();
    this.music?.voice.stop(300);
    this.music = null;
    this.wantMusic = null;
  }

  // ------------------------------------------------------------------ diagnostics
  report(): AudioReport {
    const loaded: Record<string, number> = {};
    for (const [k, v] of this.sounds) loaded[k] = v.length;
    const missingCore = (Object.keys(CUES) as CueId[]).filter((k) => CUES[k].core && !this.sounds.has(k));
    return { available: this.backend.available, unlocked: this.unlocked, manifest: this.manifest !== null, loaded, missingCore, played: { ...this.played }, skippedNoFile: { ...this.noFile } };
  }
}

function safeStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}
