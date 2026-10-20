import test from 'node:test';
import assert from 'node:assert/strict';
import { CUES, CUE_IDS, MUSIC_CUE, cueOfFile, type CueId } from '../src/client/audio/cues.js';
import { GameAudio } from '../src/client/audio/gameAudio.js';
import { AudioManager, NullBackend, type AudioBackend, type PlayParams, type Voice } from '../src/client/audio/manager.js';
import { fresh, put, stepN } from './helpers.js';

/** A backend that records everything and "decodes" files into their own names. */
class RecBackend implements AudioBackend {
  available = true;
  clock = 0;
  plays: { cue: string; file: string; p: PlayParams }[] = [];
  stops: { cue: string; fade: number | undefined }[] = [];
  gains: Record<string, number> = {};
  unlockOk = true;
  constructor(public manifest: Record<string, string[]> | null) {}
  async unlock() { return this.unlockOk; }
  async fetchJson() { return this.manifest; }
  async load(url: string) { return decodeURIComponent(url.split('/').pop()!); }
  play(sound: unknown, p: PlayParams): Voice {
    const file = sound as string;
    const cue = cueOfFile(file)!;
    this.plays.push({ cue, file, p });
    return { stop: (fade?: number) => { this.stops.push({ cue, fade }); } };
  }
  setChannelGain(ch: string, g: number) { this.gains[ch] = g; }
  now() { return this.clock; }
  cues() { return this.plays.map((x) => x.cue); }
}

const allFiles = (): Record<string, string[]> => Object.fromEntries(CUE_IDS.map((id) => [id, [`${id}.ogg`]]));
const memStore = () => { const d = new Map<string, string>(); return { getItem: (k: string) => d.get(k) ?? null, setItem: (k: string, v: string) => void d.set(k, v) }; };

async function ready(manifest: Record<string, string[]> | null = allFiles()) {
  const be = new RecBackend(manifest);
  const audio = new AudioManager(be, 'assets/audio/', memStore());
  await audio.unlock();
  return { be, audio };
}

test('catalogue: every cue is well-formed, the requested ones are all there, file names map back to cues', () => {
  assert.ok(CUE_IDS.length >= 55);
  for (const id of CUE_IDS) {
    const c = CUES[id];
    assert.ok(c.vol > 0 && c.vol <= 1, id);
    assert.ok(c.desc.length > 3 && c.group.length > 0, id);
    assert.equal(cueOfFile(`${id}.ogg`), id);
    assert.equal(cueOfFile(`${id}_3.mp3`), id);
  }
  const requested: CueId[] = ['shoot_main', 'hit_landed', 'got_shot', 'got_hit_melee', 'wave_arrival', 'strain_recovered', 'reload_start', 'reload_finish', 'hp_low', 'hp_critical', 'pause', 'resume', 'surrender', 'to_menu', 'music_menu', 'music_game', 'enemy_spotted', 'supply_taken', 'streak_start', 'streak_enemy_start', 'win', 'lose'];
  for (const id of requested) assert.ok(CUES[id].core, `${id} is a requested cue`);
  assert.ok(CUES.music_menu.loop && CUES.music_game.loop);
  assert.equal(MUSIC_CUE.menu, 'music_menu');
  assert.equal(cueOfFile('notacue.ogg'), null);
  assert.equal(cueOfFile('shoot_main.txt'), null);
  assert.equal(cueOfFile('README.md'), null);
});

test('manager: silent before the browser unlocks audio, plays afterwards, never throws without files', async () => {
  const be = new RecBackend(allFiles());
  const audio = new AudioManager(be, 'x/', memStore());
  assert.equal(audio.play('shoot_main'), false);
  await audio.unlock();
  assert.equal(audio.play('shoot_main'), true);
  assert.deepEqual(be.cues(), ['shoot_main']);

  const none = await ready({});
  assert.equal(none.audio.play('shoot_main'), false);
  assert.equal(none.audio.report().skippedNoFile.shoot_main, 1);
  const noManifest = await ready(null);
  assert.equal(noManifest.audio.play('win'), false);
  assert.equal(noManifest.audio.report().manifest, false);
  const nul = new AudioManager(new NullBackend(), 'x/', memStore());
  await nul.unlock();
  assert.equal(nul.play('win'), false);
  nul.setMusic('menu');
  nul.setLoop('heartbeat', true);
  nul.duck(true);
  nul.stopAll();
});

test('manager: rate limits, voice cap, random variants that never repeat', async () => {
  const { be, audio } = await ready({ ...allFiles(), shoot_main: ['shoot_main_1.ogg', 'shoot_main_2.ogg', 'shoot_main_3.ogg'] });
  const gap = CUES.shoot_main.gap!;
  assert.equal(audio.play('shoot_main'), true);
  be.clock += gap - 1;
  assert.equal(audio.play('shoot_main'), false, 'too soon');
  be.clock += 2;
  for (let i = 0; i < 40; i++) { assert.equal(audio.play('shoot_main'), true); be.clock += gap + 1; }
  const files = be.plays.filter((p) => p.cue === 'shoot_main').map((p) => p.file);
  assert.ok(new Set(files).size === 3, 'all variants are used');
  for (let i = 1; i < files.length; i++) assert.notEqual(files[i], files[i - 1]);
  // positional parameters pass through and are clamped
  audio.play('shoot_enemy', { pan: -0.5, volume: 0.5 });
  const p = be.plays.at(-1)!.p;
  assert.equal(p.pan, -0.5);
  assert.ok(Math.abs(p.gain - CUES.shoot_enemy.vol * 0.5) < 1e-9);
});

test('manager: mixer, mute, persistence and ducking', async () => {
  const store = memStore();
  const be = new RecBackend(allFiles());
  const a = new AudioManager(be, 'x/', store);
  await a.unlock();
  assert.ok(a.settings.master > 0 && !a.settings.muted);
  a.set('master', 0.5); a.set('music', 0.4); a.set('sfx', 0.8);
  assert.ok(Math.abs(be.gains.sfx - 0.4) < 1e-9 && Math.abs(be.gains.ui - 0.4) < 1e-9 && Math.abs(be.gains.music - 0.2) < 1e-9);
  a.duck(true);
  assert.ok(be.gains.music < 0.2);
  a.duck(false);
  a.set('master', 7); // clamped
  assert.equal(a.settings.master, 1);
  assert.equal(a.toggleMuted(), true);
  assert.equal(be.gains.sfx, 0);
  assert.equal(a.play('win'), false, 'muted');
  a.setMuted(false);
  // a fresh manager restores the saved settings
  const b = new AudioManager(new RecBackend(null), 'x/', store);
  assert.deepEqual(b.settings, a.settings);
  // corrupt storage falls back to the defaults
  const bad = new AudioManager(new RecBackend(null), 'x/', { getItem: () => '{nope', setItem: () => { throw new Error('quota'); } });
  assert.ok(bad.settings.master > 0);
  bad.set('sfx', 0.3); // a throwing store must not break anything
});

test('manager: music waits for the unlock, crossfades between tracks and stops on request; loops start and stop', async () => {
  const be = new RecBackend(allFiles());
  be.unlockOk = false;
  const audio = new AudioManager(be, 'x/', memStore());
  audio.setMusic('menu');
  await audio.unlock();
  assert.deepEqual(be.cues(), [], 'still locked');
  be.unlockOk = true;
  await audio.unlock();
  assert.deepEqual(be.cues(), ['music_menu']);
  assert.ok(be.plays[0].p.loop && be.plays[0].p.channel === 'music' && be.plays[0].p.fadeInMs > 0);
  audio.setMusic('menu');
  assert.equal(be.plays.length, 1, 'same track: nothing restarts');
  audio.setMusic('game');
  assert.deepEqual(be.cues(), ['music_menu', 'music_game']);
  assert.ok(be.stops.some((s) => s.cue === 'music_menu' && (s.fade ?? 0) > 0), 'the old track fades out');
  audio.setMusic(null);
  assert.ok(be.stops.some((s) => s.cue === 'music_game'));
  audio.setLoop('heartbeat', true);
  audio.setLoop('heartbeat', true);
  assert.equal(be.cues().filter((c) => c === 'heartbeat').length, 1);
  audio.setLoop('heartbeat', false);
  assert.ok(be.stops.some((s) => s.cue === 'heartbeat'));
});

// ------------------------------------------------------------------------------------------------ game events -> cues
async function match(seed = 90) {
  const { be, audio } = await ready();
  const m = fresh(seed, 0);
  const ga = new GameAudio(m, 0, audio);
  const heard = () => be.cues();
  const reset = () => { be.plays.length = 0; be.clock += 5000; };
  return { m, ga, be, audio, heard, reset };
}

test('game audio: my shots, hits landed, bullets taken and melee hits', async () => {
  const { m, ga, heard, reset } = await match();
  const me = m.mainOf(0), foe = m.mainOf(1);
  ga.update();
  reset();
  m.emit('shot', { actor: me.id, x0: me.x, y0: me.y, x1: foe.x, y1: foe.y, result: 'body', victim: foe.id, dmg: 9 });
  assert.deepEqual(heard(), ['shoot_main', 'hit_landed']);
  reset();
  m.emit('shot', { actor: foe.id, x0: foe.x, y0: foe.y, x1: me.x, y1: me.y, result: 'body', victim: me.id, dmg: 9 });
  assert.ok(heard().includes('got_shot'));
  reset();
  m.emit('shot', { actor: foe.id, x0: foe.x, y0: foe.y, x1: me.x, y1: me.y, result: 'shield', victim: me.id, dmg: 9 });
  assert.ok(heard().includes('hit_shield_block') && !heard().includes('got_shot'));
  reset();
  m.emit('sword', { actor: foe.id, kind: 'swipe', hits: [me.id] });
  assert.ok(heard().includes('got_hit_melee'));
  reset();
  me.mode = 'sword';
  m.emit('sword', { actor: me.id, kind: 'thrust', hits: [foe.id] });
  assert.deepEqual(heard(), ['sword_thrust', 'sword_hit']);
  reset();
  m.emit('contact', { a: me.id, b: foe.id, aShield: false, bShield: false });
  assert.ok(heard().includes('got_hit_melee'));
});

test('game audio: enemies are only heard while the team can see them (no hidden-information leak)', async () => {
  const { m, ga, heard, reset } = await match(91);
  const me = m.mainOf(0), foe = m.mainOf(1);
  const enemySoldier = m.soldiers(1)[0];
  ga.update();
  reset();
  m.teams[0].teamVisible.clear();
  m.emit('shot', { actor: enemySoldier.id, x0: 80, y0: 30, x1: 70, y1: 30, result: 'miss' });
  m.emit('kill', { victim: enemySoldier.id, victimKind: 'soldier', team: 1, killer: -1 });
  m.emit('overload', { actor: foe.id });
  assert.deepEqual(heard(), [], 'nothing from out of sight');
  m.teams[0].teamVisible.add(enemySoldier.id);
  m.teams[0].teamVisible.add(foe.id);
  m.emit('shot', { actor: enemySoldier.id, x0: 80, y0: 30, x1: 70, y1: 30, result: 'miss' });
  m.emit('kill', { victim: enemySoldier.id, victimKind: 'soldier', team: 1, killer: me.id });
  m.emit('overload', { actor: foe.id });
  assert.deepEqual(heard(), ['shoot_enemy', 'soldier_down_enemy', 'kill_confirm', 'overload_enemy']);
});

test('game audio: waves, supplies, streaks, stance, orders, heal, reload and the match end', async () => {
  const { m, ga, heard, reset } = await match(92);
  const me = m.mainOf(0);
  ga.update();
  reset();
  m.emit('wave', { team: 1, spawned: 5 });
  assert.deepEqual(heard(), [], 'the enemy wave is not announced');
  m.emit('wave', { team: 0, spawned: 5 });
  m.emit('wave', { team: 0, spawned: 0 });
  assert.deepEqual(heard(), ['wave_arrival'], 'only a wave that actually spawned soldiers');
  reset();
  m.emit('pickupSpawn', {});
  m.emit('pickupTaken', { actor: me.id, team: 0, gain: 10 });
  m.emit('pickupTaken', { actor: 3, team: 1, gain: 10 });
  m.emit('streakStart', { team: 0 }); m.emit('streakStart', { team: 1 });
  m.emit('streakEnd', { team: 0 }); m.emit('streakEnd', { team: 1 });
  m.emit('stance', { team: 0, stance: 'offensive' }); m.emit('stance', { team: 1, stance: 'offensive' });
  m.emit('heal', { actor: me.id, amount: 3 });
  m.emit('reloaded', { actor: me.id });
  assert.deepEqual(heard(), ['supply_spawn', 'supply_taken', 'supply_taken_enemy', 'streak_start', 'streak_enemy_start', 'streak_end', 'streak_enemy_end', 'stance_switch', 'heal', 'reload_finish']);
  // orders
  reset();
  m.commandListeners.forEach((f) => f({ source: 'human', team: 0, cmd: { t: 'SquadMove', slot: 1, x: 5, y: 5 }, issuedAt: 0 }, { ok: true }));
  m.commandListeners.forEach((f) => f({ source: 'human', team: 0, cmd: { t: 'CreateSquad', slot: 1, members: [] }, issuedAt: 0 }, { ok: true }));
  m.commandListeners.forEach((f) => f({ source: 'human', team: 0, cmd: { t: 'SquadHold', slot: 1 }, issuedAt: 0 }, { ok: false, reason: 'x' }));
  m.commandListeners.forEach((f) => f({ source: 'baseline', team: 1, cmd: { t: 'SquadHold', slot: 1 }, issuedAt: 0 }, { ok: false, reason: 'x' }));
  assert.deepEqual(heard(), ['order_confirm', 'squad_edit', 'order_denied']);
});

test('game audio: the end of the match - win, lose, draw, and surrender without a second "lose"', async () => {
  for (const [winner, surrendered, expect] of [[0, false, 'win'], [1, false, 'lose'], [null, false, 'draw'], [1, true, null]] as const) {
    const { m, ga, audio, be, heard, reset } = await match(93);
    audio.setMusic('game');
    ga.update();
    reset();
    m.teams[0].surrendered = surrendered;
    m.emit('end', { winner, reason: 'test' });
    assert.deepEqual(heard(), expect ? [expect] : []);
    assert.ok(be.stops.some((s) => s.cue === 'music_game'), 'game music stops');
  }
  const { ga, heard, reset } = await match(94);
  ga.update(); reset();
  ga.surrender();
  assert.deepEqual(heard(), ['surrender']);
});

test('game audio: pause, resume, ducking and quiet transitions', async () => {
  const { ga, be, heard, reset } = await match(95);
  ga.update(); reset();
  ga.setPaused(true);
  assert.deepEqual(heard(), ['pause']);
  assert.ok(be.gains.music < 0.6 * 0.8, 'music is ducked');
  ga.setPaused(true); // no repeat
  assert.deepEqual(heard(), ['pause']);
  reset();
  ga.setPaused(false);
  assert.deepEqual(heard(), ['resume']);
  reset();
  ga.setPaused(true, true);
  ga.setPaused(false, true);
  assert.deepEqual(heard(), [], 'quiet transitions (surrender) play no pause / resume cue');
});

test('game audio: low HP warnings fire once per crossing, heartbeats follow the health, sword strain warns and recovers', async () => {
  const { m, ga, be, heard, reset } = await match(96);
  const me = m.mainOf(0);
  ga.update(); reset();
  me.hp = 19; ga.update();
  assert.deepEqual(heard().filter((c) => c === 'hp_low' || c === 'hp_critical'), ['hp_low']);
  assert.ok(be.cues().includes('heartbeat'));
  me.hp = 18; ga.update(); me.hp = 17; ga.update();
  assert.equal(heard().filter((c) => c === 'hp_low').length, 1, 'once');
  me.hp = 9; be.clock += 5000; ga.update();
  assert.ok(heard().includes('hp_critical'));
  assert.ok(heard().includes('heartbeat_fast'));
  assert.ok(be.stops.some((s) => s.cue === 'heartbeat'), 'the slow heartbeat is replaced');
  // healed above the margin: armed again
  me.hp = 40; ga.update(); be.clock += 5000;
  me.hp = 15; ga.update();
  assert.equal(heard().filter((c) => c === 'hp_low').length, 2);
  // sword strain
  reset();
  me.hp = 100; ga.update();
  me.strain = 80; ga.update();
  assert.ok(heard().includes('strain_warning'));
  reset();
  me.strain = 90; ga.update();
  assert.ok(!heard().includes('strain_warning'), 'one warning per rise');
  me.overloadEnd = 500; ga.update();
  me.strain = 40; me.overloadEnd = -1; ga.update();
  assert.ok(heard().includes('strain_recovered'));
});

test('game audio: reload, low ammo, empty clicks, weapon switch, shield break', async () => {
  const { m, ga, heard, reset } = await match(97);
  const me = m.mainOf(0);
  ga.update(); reset();
  me.reloadEnd = m.tick + 100; ga.update();
  assert.deepEqual(heard(), ['reload_start']);
  reset();
  me.reloadEnd = -1; me.mag = 2; ga.update();
  assert.ok(heard().includes('low_ammo'));
  reset();
  me.mag = 0; me.wantFire = true; ga.update();
  assert.ok(heard().includes('empty_click'));
  reset();
  me.wantFire = false; me.mode = 'sword'; ga.update();
  assert.ok(heard().includes('weapon_switch'));
  reset();
  me.shield = 0; ga.update();
  assert.ok(heard().includes('shield_down'));
});

test('game audio: the first enemy and the first sight of the enemy Main are announced once; Last Stand counts down', async () => {
  const { m, ga, heard, reset } = await match(98);
  const foe = m.mainOf(1);
  const soldier = m.soldiers(1)[0];
  ga.update(); reset();
  m.teams[0].teamVisible.add(soldier.id); ga.update();
  assert.deepEqual(heard(), ['enemy_spotted']);
  m.teams[0].teamVisible.delete(soldier.id); m.teams[0].teamVisible.add(soldier.id); ga.update();
  assert.equal(heard().filter((c) => c === 'enemy_spotted').length, 1, 'only the first time');
  m.teams[0].teamVisible.add(foe.id); ga.update();
  assert.ok(heard().includes('enemy_main_spotted'));
  ga.update();
  assert.equal(heard().filter((c) => c === 'enemy_main_spotted').length, 1);
  reset();
  m.tick = 3000;
  m.teams[0].collapseStart = 3000 - 60 * 21; // 9 s left
  ga.update();
  assert.ok(heard().includes('last_stand_start'));
  reset();
  m.tick += 60;
  ga.update();
  assert.deepEqual(heard(), ['last_stand_tick']);
});

test('game audio: a real match produces sounds without errors and nothing after dispose', async () => {
  const { m, ga, be } = await match(99);
  for (let i = 0; i < 60; i++) { stepN(m, 30); be.clock += 600; ga.update(); }
  const n = be.plays.length;
  ga.dispose();
  put(m.mainOf(0), 20, 20);
  m.emit('wave', { team: 0, spawned: 3 });
  ga.update();
  assert.equal(be.plays.length, n);
});
