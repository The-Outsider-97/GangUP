import { AIDirector, recordControllers } from '../ai/director.js';
import { newEpisodeId } from '../ai/episode.js';
import { AudioManager } from './audio/manager.js';
import { GameAudio } from './audio/gameAudio.js';
import { DT } from '../engine/constants.js';
import { Match } from '../engine/match.js';
import { HumanController } from './controller.js';
import { Hud, fillKeyTables } from './hud.js';
import { buildHudModel, formatWaveArithmetic } from './hudModel.js';
import { Renderer } from './renderer.js';
const HUMAN = 0; // Green
const AI_TEAM = 1; // Red = SLAI
const REASONS = {
    'hidden-target': 'Target is not currently visible',
    unreachable: 'No walkable route to that point',
    'squad-full': 'A squad holds at most 10 soldiers',
    'bad-member': 'Only your living soldiers can join a squad',
    'follow-cycle': 'That follow order would create a loop',
    'main-defeated': 'Your Main is defeated: no new orders',
    'empty-squad': 'That squad has no members',
    'bad-slot': 'Invalid squad number',
};
const $ = (id) => {
    const e = document.getElementById(id);
    if (!e)
        throw new Error('missing #' + id);
    return e;
};
/** One running match: engine + AI directors + input + renderer, advanced by a fixed 60 Hz accumulator. */
/** One mixer for the whole page (menu music continues across screens; settings are remembered). */
export const audio = new AudioManager();
export class Game {
    opts;
    hud;
    canvas;
    onEnd;
    onMenu;
    m;
    ctl;
    renderer;
    directors = [];
    sound;
    paused = false;
    acc = 0;
    lastFrame = 0;
    raf = 0;
    hudClock = 0;
    ended = false;
    disposers = [];
    drag = null;
    constructor(opts, hud, canvas, onEnd, onMenu) {
        this.opts = opts;
        this.hud = hud;
        this.canvas = canvas;
        this.onEnd = onEnd;
        this.onMenu = onMenu;
        const spectate = opts.mode === 'spectate';
        this.m = new Match({ seed: opts.seed, humanTeam: spectate ? null : HUMAN, episodeId: newEpisodeId() });
        this.renderer = new Renderer(canvas, this.m, HUMAN);
        this.renderer.setFog(opts.fog && !spectate);
        this.ctl = spectate ? null : new HumanController(this.m, HUMAN, (msg, kind) => this.hud.toast(msg, kind === 'bad' ? 'bad' : kind === 'warn' ? 'warn' : 'info'));
        const mk = (team, mode) => {
            const d = new AIDirector(team, { difficulty: opts.difficulty, mode, baseUrl: opts.url.replace(/\/$/, ''), deadlineMs: 400 });
            d.attach(this.m);
            this.directors.push(d);
        };
        if (spectate) {
            mk(0, 'baseline');
            mk(1, 'slai');
        }
        else
            mk(AI_TEAM, opts.mode === 'slai' ? 'slai' : 'baseline');
        this.sound = new GameAudio(this.m, HUMAN, audio);
        audio.setMusic('game');
        this.m.commandListeners.push((env, res) => {
            if (env.source !== 'human' || res.ok)
                return;
            this.hud.toast(REASONS[res.reason ?? ''] ?? `Order rejected: ${res.reason}`, 'bad');
        });
        this.m.listeners.push((e) => this.onEvent(e));
        this.bind();
        this.hud.reset();
        this.lastFrame = performance.now();
        this.raf = requestAnimationFrame((t) => this.frame(t));
    }
    // ------------------------------------------------------------------ events → toasts
    onEvent(e) {
        const m = this.m;
        switch (e.type) {
            case 'wave': {
                if (e.team !== HUMAN)
                    break;
                const line = { time: e.tick / 60, base: e.base, ownBonus: e.ownBonus, enemyPenalty: e.enemyPenalty, capacityRoom: e.capacityRoom, spawned: e.spawned, note: e.note };
                this.hud.toast(`Wave: ${formatWaveArithmetic(line)}`, e.spawned > 0 ? 'good' : 'warn');
                break;
            }
            case 'streakStart':
                this.hud.toast(e.team === HUMAN ? 'Kill streak! +5 shield and +1 per wave for 40 s' : 'Enemy kill streak: your next waves lose 1 soldier', e.team === HUMAN ? 'gold' : 'bad');
                break;
            case 'streakEnd':
                this.hud.toast(e.team === HUMAN ? 'Your streak ended: 90 s cooldown' : 'Enemy streak ended', 'info');
                break;
            case 'pickupSpawn':
                this.hud.toast('Supply pickup spawned at the centre', 'info');
                break;
            case 'pickupTaken':
                this.hud.toast(e.team === HUMAN ? `Supply collected: +${Math.round(e.gain)} HP` : 'The enemy Main took the supply', e.team === HUMAN ? 'good' : 'warn');
                break;
            case 'overload':
                if (e.actor === m.teams[HUMAN].mainId)
                    this.hud.toast('Sword overload: sword disabled for 6 s', 'bad');
                break;
            case 'kill':
                if (e.victimKind === 'main')
                    this.hud.toast(e.team === HUMAN ? 'Your Main has fallen' : 'Enemy Main down', e.team === HUMAN ? 'bad' : 'good');
                break;
            case 'stance':
                if (e.team === HUMAN)
                    this.hud.toast(`Stance: ${e.stance}`, 'info');
                break;
            default: break;
        }
    }
    // ------------------------------------------------------------------ input binding
    bind() {
        const on = (t, k, f) => { t.addEventListener(k, f); this.disposers.push(() => t.removeEventListener(k, f)); };
        const onC = (k, f) => { this.canvas.addEventListener(k, f); this.disposers.push(() => this.canvas.removeEventListener(k, f)); };
        const pos = (e) => { const r = this.canvas.getBoundingClientRect(); const px = e.clientX - r.left, py = e.clientY - r.top; return { px, py, ...this.renderer.toWorld(px, py) }; };
        on(window, 'keydown', (e) => {
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement)
                return;
            if (e.code === 'Space') {
                e.preventDefault();
                if (!e.repeat)
                    this.setPaused(!this.paused);
                return;
            }
            if (e.code === 'Escape') {
                e.preventDefault();
                if (this.paused)
                    this.setPaused(false);
                else if (!this.ctl?.cancel())
                    this.setPaused(true);
                return;
            }
            if (this.paused || !this.ctl || this.ended)
                return;
            if (this.ctl.keyDown(e.code, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey }, e.repeat))
                e.preventDefault();
        });
        on(window, 'keyup', (e) => this.ctl?.keyUp(e.code));
        on(window, 'blur', () => { this.ctl?.releaseAll(); if (!this.ended)
            this.setPaused(true); });
        on(window, 'resize', () => this.renderer.resize());
        onC('contextmenu', (e) => e.preventDefault());
        onC('mousedown', (e) => {
            if (this.paused || !this.ctl || this.ended)
                return;
            this.canvas.focus();
            const p = pos(e);
            const mods = { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
            if (e.button === 0 && mods.ctrl) {
                this.drag = { px: p.px, py: p.py, wx: p.x, wy: p.y, moved: false, additive: e.shiftKey };
                return;
            }
            this.ctl.mouseDown(p.x, p.y, e.button, mods);
        });
        onC('mousemove', (e) => {
            const p = pos(e);
            this.renderer.hover = { x: p.x, y: p.y };
            if (this.drag) {
                if (Math.hypot(p.px - this.drag.px, p.py - this.drag.py) > 5)
                    this.drag.moved = true;
                this.renderer.dragRect = this.drag.moved ? { x0: this.drag.wx, y0: this.drag.wy, x1: p.x, y1: p.y } : null;
            }
        });
        on(window, 'mouseup', (e) => {
            if (this.drag && this.ctl && e.button === 0) {
                const p = pos(e);
                if (this.drag.moved)
                    this.ctl.dragSelect(this.drag.wx, this.drag.wy, p.x, p.y, this.drag.additive);
                else
                    this.ctl.mouseDown(this.drag.wx, this.drag.wy, 0, { shift: this.drag.additive, ctrl: true });
                this.drag = null;
                this.renderer.dragRect = null;
                return;
            }
            this.ctl?.mouseUp(e.button);
        });
    }
    setPaused(p, quiet = false) {
        if (this.ended)
            return;
        if (!quiet)
            this.sound.setPaused(p);
        this.paused = p;
        if (p)
            this.ctl?.releaseAll();
        $('pause').classList.toggle('hidden', !p);
        this.lastFrame = performance.now();
    }
    surrender() {
        if (!this.ctl)
            return;
        this.sound.surrender();
        this.m.submit({ source: 'human', team: HUMAN, cmd: { t: 'Surrender' }, issuedAt: this.m.tick });
        this.sound.setPaused(false, true);
        this.setPaused(false, true);
    }
    // ------------------------------------------------------------------ loop
    frame(now) {
        this.raf = requestAnimationFrame((t) => this.frame(t));
        const dt = Math.min(250, now - this.lastFrame);
        this.lastFrame = now;
        if (!this.paused && !this.m.result.over) {
            this.acc += dt / 1000;
            let steps = 0;
            while (this.acc >= DT && steps < 8 && !this.m.result.over) {
                this.ctl?.onTick();
                for (const d of this.directors)
                    d.poll(this.m);
                this.m.step();
                this.acc -= DT;
                steps++;
            }
            if (steps === 8)
                this.acc = 0; // never spiral: drop the backlog instead of fast-forwarding
        }
        this.sound.update();
        this.renderer.draw(this.ctl, this.paused);
        this.hudClock += dt;
        if (this.hudClock > 90) {
            this.hudClock = 0;
            const dir = this.directors.find((d) => d.team === AI_TEAM) ?? null;
            this.hud.update(buildHudModel(this.m, HUMAN), this.ctl?.selectedSquad ?? 0, this.opts.mode, dir, this.opts.mode === 'baseline' ? 'Baseline' : 'SLAI');
            this.hud.hint(this.ctl?.targetMode === 'follow' ? 'FOLLOW: right-click an ally (Esc cancels)' : this.ctl?.targetMode === 'leader' ? 'LEADER: right-click a squad member (Esc cancels)' : null);
        }
        if (this.m.result.over && !this.ended) {
            this.ended = true;
            this.ctl?.releaseAll();
            setTimeout(() => this.onEnd(this), 900); // let the final blow be seen
        }
    }
    dispose() {
        cancelAnimationFrame(this.raf);
        this.sound.dispose();
        for (const d of this.disposers)
            d();
        this.disposers = [];
        this.ctl?.releaseAll();
    }
    quit() { this.dispose(); this.onMenu(); }
}
// ====================================================================== app shell
const hudEls = () => new Hud();
let hud = null;
let game = null;
function readOptions() {
    const seedRaw = $('m-seed').value.trim();
    return {
        mode: $('m-mode').value,
        difficulty: $('m-diff').value,
        url: $('m-url').value.trim() || location.origin,
        seed: seedRaw === '' ? Math.floor(Math.random() * 1e9) : Math.max(0, Math.floor(Number(seedRaw)) || 0),
        fog: $('m-fog').checked,
    };
}
async function checkService() {
    const box = $('slai-status');
    const url = $('m-url').value.trim() || location.origin;
    box.className = 'status';
    box.textContent = 'Checking SLAI service…';
    try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 1500);
        const r = await fetch(url.replace(/\/$/, '') + '/v1/health', { signal: ctl.signal });
        clearTimeout(t);
        const j = await r.json();
        const ag = j.agents;
        const partial = ag?.mode === 'real' && (ag.ready ?? 0) < (ag.total ?? 0);
        box.className = partial ? 'status' : 'status ok';
        const agents = !ag ? '' : ag.mode === 'real' ? ` · real SLAI agents ${ag.ready}/${ag.total}${partial ? ` (missing: ${(ag.missing ?? []).join(', ')})` : ''}` : ' · built-in agents (lite)';
        box.textContent = `SLAI online${agents} · policy ${j.policy} · ${j.trained ? 'trained weights' : 'scripted objectives (untrained)'}`;
    }
    catch {
        box.className = 'status bad';
        box.textContent = 'SLAI service not reachable: Red will use the built-in scripted baseline. Start it with: python3 -m slai.server';
    }
}
function startMatch(opts) {
    game?.dispose();
    const canvas = $('stage');
    $('menu').classList.add('hidden');
    $('result').classList.add('hidden');
    $('pause').classList.add('hidden');
    $('app').classList.remove('hidden');
    hud ??= hudEls();
    game = new Game(opts, hud, canvas, showResult, showMenu);
    window.__gangup = { game }; // handle for automated tests
    canvas.focus();
}
function showMenu() {
    game?.dispose();
    game = null;
    audio.play('to_menu');
    audio.setMusic('menu');
    $('app').classList.add('hidden');
    $('pause').classList.add('hidden');
    $('result').classList.add('hidden');
    $('menu').classList.remove('hidden');
    void checkService();
}
function showResult(g) {
    const m = g.m;
    const r = m.result;
    const spectate = g.opts.mode === 'spectate';
    const won = r.winner === HUMAN;
    $('r-title').textContent = r.winner === null ? 'Draw' : spectate ? (r.winner === 0 ? 'Baseline (Green) wins' : 'SLAI (Red) wins') : won ? 'Victory' : 'Defeat';
    $('r-title').style.color = r.winner === null ? '' : won || (spectate && r.winner === 1) ? '#3ddc84' : '#ff5d5d';
    $('r-reason').textContent = `${r.reason} · ${Math.floor(r.tick / 3600)}:${String(Math.floor((r.tick / 60) % 60)).padStart(2, '0')}`;
    const rows = [['', 'Green', 'Red']];
    const mains = [m.mainOf(0), m.mainOf(1)];
    rows.push(['Main HP at end', Math.max(0, Math.ceil(mains[0].hp)), Math.max(0, Math.ceil(mains[1].hp))]);
    rows.push(['Soldiers alive', m.soldiers(0).length, m.soldiers(1).length]);
    rows.push(['Soldiers spawned', m.teams[0].soldiersSpawned, m.teams[1].soldiersSpawned]);
    rows.push(['Main kills', mains[0].stats.kills, mains[1].stats.kills]);
    rows.push(['Kill streaks', m.teams[0].streak.activations, m.teams[1].streak.activations]);
    const dir = g.directors.find((d) => d.team === AI_TEAM);
    if (dir && g.opts.mode !== 'baseline')
        rows.push(['SLAI decisions / fallback', dir.stats.decisions, dir.stats.fallbackDecisions]);
    $('r-stats').innerHTML = rows.map((r2, i) => `<tr>${r2.map((c, j) => (i === 0 || j === 0 ? `<td><b>${c}</b></td>` : `<td>${c}</td>`)).join('')}</tr>`).join('');
    $('result').classList.remove('hidden');
    // stamp the controllers into the replay and report the outcome so SLAI can adapt (once per episode; only if SLAI actually played)
    recordControllers(m, g.directors);
    for (const d of g.directors)
        void d.finish(m);
}
/** Sound settings: every [data-audio] control (menu and pause screen) edits the same mixer. */
function bindAudioControls() {
    const els = [...document.querySelectorAll('[data-audio]')];
    const sync = () => {
        for (const e of els) {
            const k = e.dataset.audio;
            if (k === 'mute')
                e.checked = audio.settings.muted;
            else
                e.value = String(Math.round(audio.settings[k] * 100));
        }
    };
    for (const e of els) {
        e.addEventListener('input', () => {
            const k = e.dataset.audio;
            if (k === 'mute')
                audio.setMuted(e.checked);
            else
                audio.set(k, Number(e.value) / 100);
            sync();
        });
    }
    sync();
    window.addEventListener('keydown', (e) => {
        if (e.code !== 'KeyM' || e.repeat || e.ctrlKey || e.metaKey || e.altKey)
            return;
        if (e.target instanceof HTMLInputElement && e.target.type !== 'range' && e.target.type !== 'checkbox')
            return;
        if (e.target instanceof HTMLSelectElement)
            return;
        audio.toggleMuted();
        sync();
    });
}
/** Browsers start audio only after a user gesture: unlock on the first click / key press, then start the menu music. */
function armAudio() {
    const events = ['pointerdown', 'keydown'];
    const attempt = () => {
        void audio.unlock().then(() => {
            if (!audio.report().unlocked)
                return;
            for (const ev of events)
                window.removeEventListener(ev, attempt, true);
        });
    };
    for (const ev of events)
        window.addEventListener(ev, attempt, true);
    document.addEventListener('click', (e) => {
        const b = e.target?.closest?.('button');
        if (b && !b.hasAttribute('data-nosound'))
            audio.play('ui_click');
    });
    void audio.load(); // decoding needs no user gesture, so the files are ready when the first click unlocks playback
    audio.setMusic('menu');
    window.__gangupAudio = { audio, report: () => audio.report() }; // console: __gangupAudio.report()
}
function init() {
    fillKeyTables();
    bindAudioControls();
    armAudio();
    $('m-url').value = location.protocol.startsWith('http') ? location.origin : 'http://127.0.0.1:8765';
    $('m-url').addEventListener('change', () => void checkService());
    $('m-start').addEventListener('click', () => startMatch(readOptions()));
    $('p-resume').addEventListener('click', () => game?.setPaused(false));
    $('p-surrender').addEventListener('click', () => game?.surrender());
    $('p-quit').addEventListener('click', () => game?.quit());
    $('r-again').addEventListener('click', () => { if (game)
        startMatch({ ...game.opts }); });
    $('r-new').addEventListener('click', showMenu);
    $('r-replay').addEventListener('click', () => {
        if (!game)
            return;
        const blob = new Blob([JSON.stringify(game.m.replay)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `gangup-replay-${game.m.seed}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    void checkService();
}
if (typeof document !== 'undefined') {
    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', init);
    else
        init();
}
//# sourceMappingURL=main.js.map