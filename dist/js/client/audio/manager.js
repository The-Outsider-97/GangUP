import { CUES, MUSIC_CUE, cueOfFile } from './cues.js';
export const DEFAULT_SETTINGS = { master: 0.8, sfx: 1, music: 0.6, muted: false };
const STORAGE_KEY = 'gangup.audio.v1';
const DUCK = 0.35; // music level while the game is paused
const clamp01 = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
class NullVoice {
    stop() { }
}
export class NullBackend {
    available = false;
    async unlock() { return false; }
    async load() { return null; }
    play() { return new NullVoice(); }
    setChannelGain() { }
    now() { return Date.now(); }
    async fetchJson() { return null; }
}
export class WebAudioBackend {
    ctx = null;
    master = null;
    groups = new Map();
    pending = new Map();
    available;
    constructor() {
        const w = typeof window !== 'undefined' ? window : undefined;
        this.available = !!(w && (w.AudioContext || w.webkitAudioContext));
    }
    ensure() {
        if (!this.available)
            return null;
        if (this.ctx)
            return this.ctx;
        try {
            const w = window;
            const Ctor = (w.AudioContext ?? w.webkitAudioContext);
            this.ctx = new Ctor();
            this.master = this.ctx.createGain();
            this.master.connect(this.ctx.destination);
            for (const ch of ['sfx', 'ui', 'music']) {
                const g = this.ctx.createGain();
                g.gain.value = this.pending.get(ch) ?? 1;
                g.connect(this.master);
                this.groups.set(ch, g);
            }
        }
        catch {
            this.ctx = null;
        }
        return this.ctx;
    }
    async unlock() {
        const ctx = this.ensure();
        if (!ctx)
            return false;
        try {
            if (ctx.state === 'suspended')
                await ctx.resume();
        }
        catch { /* needs another gesture */ }
        return ctx.state === 'running';
    }
    async load(url) {
        const ctx = this.ensure();
        if (!ctx)
            return null;
        try {
            const r = await fetch(url);
            if (!r.ok)
                return null;
            return await ctx.decodeAudioData(await r.arrayBuffer());
        }
        catch {
            return null;
        }
    }
    async fetchJson(url) {
        try {
            const r = await fetch(url, { cache: 'no-cache' });
            return r.ok ? await r.json() : null;
        }
        catch {
            return null;
        }
    }
    play(sound, p) {
        const ctx = this.ensure();
        const group = this.groups.get(p.channel);
        if (!ctx || !group || ctx.state !== 'running')
            return new NullVoice();
        const src = ctx.createBufferSource();
        src.buffer = sound;
        src.loop = p.loop;
        src.playbackRate.value = p.rate;
        const gain = ctx.createGain();
        const t = ctx.currentTime;
        if (p.fadeInMs > 0) {
            gain.gain.setValueAtTime(0, t);
            gain.gain.linearRampToValueAtTime(p.gain, t + p.fadeInMs / 1000);
        }
        else
            gain.gain.value = p.gain;
        let tail = src;
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
        src.onended = () => { try {
            tail.disconnect();
        }
        catch { /* already gone */ } };
        return {
            stop: (fadeMs = 0) => {
                if (stopped)
                    return;
                stopped = true;
                try {
                    if (fadeMs > 0) {
                        const n = ctx.currentTime;
                        gain.gain.cancelScheduledValues(n);
                        gain.gain.setValueAtTime(gain.gain.value, n);
                        gain.gain.linearRampToValueAtTime(0, n + fadeMs / 1000);
                        src.stop(n + fadeMs / 1000 + 0.02);
                    }
                    else
                        src.stop();
                }
                catch { /* already stopped */ }
            },
        };
    }
    setChannelGain(ch, gain) {
        this.pending.set(ch, gain);
        const g = this.groups.get(ch);
        if (g && this.ctx)
            g.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.03);
    }
    now() {
        return typeof performance !== 'undefined' ? performance.now() : Date.now();
    }
}
export class AudioManager {
    backend;
    baseUrl;
    settings;
    sounds = new Map();
    lastPlay = new Map();
    lastVariant = new Map();
    active = new Map();
    loops = new Map();
    played = {};
    noFile = {};
    unlocked = false;
    manifest = null;
    loading = null;
    wantMusic = null;
    music = null;
    ducked = false;
    storage;
    constructor(backend = typeof window !== 'undefined' ? new WebAudioBackend() : new NullBackend(), baseUrl = 'assets/audio/', storage) {
        this.backend = backend;
        this.baseUrl = baseUrl;
        this.storage = storage === undefined ? safeStorage() : storage;
        this.settings = this.readSettings();
        this.applyMixer();
    }
    // ------------------------------------------------------------------ settings
    readSettings() {
        try {
            const raw = this.storage?.getItem(STORAGE_KEY);
            if (raw) {
                const d = JSON.parse(raw);
                return { master: clamp01(d.master ?? DEFAULT_SETTINGS.master), sfx: clamp01(d.sfx ?? DEFAULT_SETTINGS.sfx), music: clamp01(d.music ?? DEFAULT_SETTINGS.music), muted: !!d.muted };
            }
        }
        catch { /* storage unavailable or corrupt: defaults */ }
        return { ...DEFAULT_SETTINGS };
    }
    applyMixer() {
        const m = this.settings.muted ? 0 : this.settings.master;
        this.backend.setChannelGain('sfx', m * this.settings.sfx);
        this.backend.setChannelGain('ui', m * this.settings.sfx);
        this.backend.setChannelGain('music', m * this.settings.music * (this.ducked ? DUCK : 1));
    }
    set(key, value) {
        this.settings[key] = clamp01(value);
        this.persist();
    }
    setMuted(muted) {
        this.settings.muted = muted;
        this.persist();
    }
    toggleMuted() {
        this.setMuted(!this.settings.muted);
        return this.settings.muted;
    }
    persist() {
        this.applyMixer();
        try {
            this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.settings));
        }
        catch { /* private mode */ }
    }
    // ------------------------------------------------------------------ loading and unlocking
    /** Call from the first user gesture (click / key). Safe to call many times. */
    async unlock() {
        if (!this.backend.available)
            return;
        if (!this.unlocked)
            this.unlocked = await this.backend.unlock();
        if (!this.unlocked)
            return;
        await this.load();
        this.applyMusic();
    }
    /** Reads `manifest.json` (written by `npm run build` from the files in assets/audio) and decodes every listed file once. */
    load() {
        this.loading ??= (async () => {
            const raw = await this.backend.fetchJson(this.baseUrl + 'manifest.json');
            if (!raw || typeof raw !== 'object') {
                this.manifest = null;
                return;
            }
            const mf = {};
            for (const [k, v] of Object.entries(raw)) {
                if (k in CUES && Array.isArray(v))
                    mf[k] = v.filter((f) => typeof f === 'string' && cueOfFile(f) === k);
            }
            this.manifest = mf;
            await Promise.all(Object.entries(mf).map(async ([cue, files]) => {
                const loaded = [];
                for (const f of files) {
                    const s = await this.backend.load(this.baseUrl + encodeURIComponent(f));
                    if (s)
                        loaded.push(s);
                }
                if (loaded.length)
                    this.sounds.set(cue, loaded);
            }));
        })();
        return this.loading;
    }
    /** True when this cue has at least one decoded file. */
    has(id) {
        return (this.sounds.get(id)?.length ?? 0) > 0;
    }
    // ------------------------------------------------------------------ one-shot sounds
    play(id, o = {}) {
        const spec = CUES[id];
        if (!this.unlocked || this.settings.muted)
            return false;
        const files = this.sounds.get(id);
        if (!files || !files.length) {
            this.noFile[id] = (this.noFile[id] ?? 0) + 1;
            return false;
        }
        const now = this.backend.now();
        if (spec.gap && now - (this.lastPlay.get(id) ?? -1e9) < spec.gap)
            return false;
        const voices = (this.active.get(id) ?? []);
        const maxVoices = spec.voices ?? 8;
        if (voices.length >= maxVoices) {
            voices.shift()?.stop(30);
        } // oldest voice makes room
        this.lastPlay.set(id, now);
        const pick = this.pickVariant(id, files.length);
        const voice = this.backend.play(files[pick], {
            gain: clamp01(spec.vol * (o.volume ?? 1)), pan: o.pan ?? 0, rate: o.rate ?? 1, loop: !!spec.loop, channel: spec.ch, fadeInMs: 0,
        });
        voices.push(voice);
        this.active.set(id, voices);
        // voices that ended on their own are dropped lazily: keep the list bounded
        if (voices.length > 16)
            voices.splice(0, voices.length - 16);
        this.played[id] = (this.played[id] ?? 0) + 1;
        return true;
    }
    pickVariant(id, n) {
        if (n <= 1)
            return 0;
        let i = Math.floor(Math.random() * n);
        if (i === this.lastVariant.get(id))
            i = (i + 1) % n; // never the same variant twice in a row
        this.lastVariant.set(id, i);
        return i;
    }
    // ------------------------------------------------------------------ loops (heartbeat ...)
    setLoop(id, on) {
        const cur = this.loops.get(id);
        if (!on) {
            if (cur) {
                cur.stop(250);
                this.loops.delete(id);
            }
            return;
        }
        if (cur || !this.unlocked || this.settings.muted)
            return;
        const files = this.sounds.get(id);
        if (!files?.length)
            return;
        this.loops.set(id, this.backend.play(files[0], { gain: CUES[id].vol, pan: 0, rate: 1, loop: true, channel: CUES[id].ch, fadeInMs: 200 }));
        this.played[id] = (this.played[id] ?? 0) + 1;
    }
    // ------------------------------------------------------------------ music
    /** The track that should be playing (null = silence). Crossfades; starts later if the browser is still locked. */
    setMusic(track) {
        this.wantMusic = track;
        this.applyMusic();
    }
    applyMusic() {
        if (this.music && this.music.track === this.wantMusic)
            return;
        if (!this.unlocked)
            return;
        if (this.music) {
            this.music.voice.stop(700);
            this.music = null;
        }
        const track = this.wantMusic;
        if (!track)
            return;
        const id = MUSIC_CUE[track];
        const files = this.sounds.get(id);
        if (!files?.length)
            return; // no file: stay silent (retried after the files finish loading)
        const voice = this.backend.play(files[0], { gain: CUES[id].vol, pan: 0, rate: 1, loop: true, channel: 'music', fadeInMs: 900 });
        this.music = { track, voice };
        this.played[id] = (this.played[id] ?? 0) + 1;
    }
    /** Lower the music while the game is paused. */
    duck(on) {
        this.ducked = on;
        this.applyMixer();
    }
    stopAll() {
        for (const v of this.loops.values())
            v.stop(100);
        this.loops.clear();
        for (const list of this.active.values())
            for (const v of list)
                v.stop(50);
        this.active.clear();
        this.music?.voice.stop(300);
        this.music = null;
        this.wantMusic = null;
    }
    // ------------------------------------------------------------------ diagnostics
    report() {
        const loaded = {};
        for (const [k, v] of this.sounds)
            loaded[k] = v.length;
        const missingCore = Object.keys(CUES).filter((k) => CUES[k].core && !this.sounds.has(k));
        return { available: this.backend.available, unlocked: this.unlocked, manifest: this.manifest !== null, loaded, missingCore, played: { ...this.played }, skippedNoFile: { ...this.noFile } };
    }
}
function safeStorage() {
    try {
        return typeof localStorage !== 'undefined' ? localStorage : null;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=manager.js.map