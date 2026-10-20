import type { AIDirector } from '../ai/director.js';
import { STREAK } from '../engine/constants.js';
import { formatWaveArithmetic, type HudModel } from './hudModel.js';

/** Conflict-free map, GDD 15.1 (shown in the menu and the pause screen). */
export const KEY_HELP: [string, string][] = [
  ['W / S / A / D', 'Forward / backward / rotate left / rotate right'],
  ['Left click (hold)', 'Rifle fire, or Wide Swipe with the sword'],
  ['Shift + left click', 'Focused Thrust (sword equipped)'],
  ['Tab / R', 'Switch rifle ↔ sword / reload rifle'],
  ['Q / E', 'Defensive / Offensive global stance'],
  ['1 – 9', 'Select numbered squad'],
  ['Ctrl (⌘) + click / drag', 'Select soldier / several soldiers'],
  ['Shift + 1 – 9', 'Create or replace that squad from the selection'],
  ['Right click terrain', 'Squad selected: move to point (Shift = set rally point)'],
  ['Right click enemy', 'Squad selected, enemy currently visible: set target'],
  ['F, then right click ally', 'Follow that ally'],
  ['L, then right click member', 'Set squad leader'],
  ['Z / X / C / V', 'Doctrine: Defend / Press / Harass / Disengage'],
  ['H / G', 'Hold position / cycle Compact → Line → Spread'],
  ['Esc / Space', 'Cancel targeting or open menu / pause'],
  ['M', 'Mute / unmute all sound'],
];

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error('missing element #' + id);
  return e as T;
}
const f1 = (n: number) => n.toFixed(1);

export class Hud {
  private last = '';
  private e = {
    bHp: el('b-hp'), tHp: el('t-hp'), bSh: el('b-sh'), tSh: el('t-sh'), bonus: el('tag-bonus'), dead: el('tag-dead'),
    mode: el('t-mode'), ammo: el('t-ammo'), bStrain: el('b-strain'), tStrain: el('t-strain'), reload: el('tag-reload'), overload: el('tag-overload'),
    stDef: el('st-def'), stOff: el('st-off'), soldiers: el('t-soldiers'), seen: el('t-seen'),
    wave: el('t-wave'), waveBase: el('t-wavebase'), waveLog: el('t-wavelog'), supply: el('t-supply'),
    pips: el('pips'), streak: el('t-streak'), estreak: el('t-estreak'),
    phase: el('t-phase'), time: el('t-time'), enemy: el('t-enemy'), slai: el('t-slai'),
    last: el('laststand'), squads: el('squads'), hint: el('mode-hint'), toasts: el('toasts'),
  };
  private cards: HTMLElement[] = [];

  constructor() {
    for (let i = 1; i <= 9; i++) {
      const d = document.createElement('div');
      d.className = 'card empty';
      d.dataset.slot = String(i);
      this.e.squads.appendChild(d);
      this.cards.push(d);
    }
    for (let i = 0; i < STREAK.kills; i++) this.e.pips.appendChild(document.createElement('b'));
  }

  update(h: HudModel, selectedSquad: number, mode: string, director: AIDirector | null, opponent: string): void {
    const e = this.e;
    const m = h.main;
    e.bHp.style.width = `${Math.max(0, (100 * m.hp) / m.hpMax)}%`;
    e.tHp.textContent = `HP ${Math.ceil(m.hp)} / ${m.hpMax}`;
    e.bHp.style.background = m.hp / m.hpMax > 0.4 ? '#3ddc84' : m.hp / m.hpMax > 0.1 ? '#facc15' : '#ff5d5d';
    e.bSh.style.width = `${Math.max(0, (100 * m.shield) / m.shieldMax)}%`;
    e.tSh.textContent = `Shield ${Math.ceil(m.shield)} / ${m.shieldMax}`;
    e.bonus.classList.toggle('hidden', !m.shieldBonus);
    e.dead.classList.toggle('hidden', m.alive);

    e.mode.textContent = m.mode === 'rifle' ? 'RIFLE' : 'SWORD';
    e.ammo.innerHTML = `<small>${m.mag} / ${m.reserve}</small>`;
    e.bStrain.style.width = `${(100 * m.strain) / m.strainMax}%`;
    e.tStrain.textContent = `Strain ${Math.round(m.strain)}`;
    e.reload.classList.toggle('hidden', !m.reloading);
    e.overload.classList.toggle('hidden', m.overloadLeft <= 0);
    e.overload.textContent = `OVERLOAD ${f1(m.overloadLeft)}s`;

    e.stDef.classList.toggle('on', h.stance === 'defensive');
    e.stOff.classList.toggle('on', h.stance === 'offensive');
    e.soldiers.textContent = String(h.soldiers);
    e.seen.textContent = `· ${h.enemySoldiersVisible} enemy soldiers in view`;

    e.wave.textContent = `Wave in ${f1(h.nextWave)}s`;
    e.waveBase.textContent = ` · base ${h.nextWaveBase}`;
    e.waveLog.textContent = h.lastWave.length ? `Last: ${formatWaveArithmetic(h.lastWave[0])}` : 'No wave yet (first at 20 s)';
    e.supply.textContent = h.pickupOnMap ? 'Supply pickup is on the map' : `Next supply in ${f1(h.supplyIn)}s`;

    const s = h.streak;
    e.pips.classList.toggle('active', s.active);
    [...e.pips.children].forEach((c, i) => c.classList.toggle('on', i < s.kills));
    e.streak.textContent = s.active
      ? `ACTIVE ${f1(s.activeLeft)}s: +5 shield, +1 wave`
      : s.cooldownLeft > 0
        ? `Cooldown ${f1(s.cooldownLeft)}s`
        : s.kills > 0
          ? `${s.kills}/${s.need} kills · window ${f1(s.windowLeft)}s`
          : `${s.need} kills in 30 s starts a streak`;
    e.estreak.textContent = s.enemyActive ? `Enemy streak ${f1(s.enemyActiveLeft)}s: −1 to your waves` : '';

    e.phase.textContent = `${h.phase} phase`;
    e.time.textContent = `${Math.floor(h.time / 60)}:${String(Math.floor(h.time % 60)).padStart(2, '0')}`;
    e.enemy.textContent = h.enemyMain ? `Enemy Main in view: HP ${Math.ceil(h.enemyMain.hp)} · shield ${Math.ceil(h.enemyMain.shield)}` : 'Enemy Main not in view';
    if (director) {
      const st = director.stats;
      e.slai.textContent = st.degraded ? `${opponent}: fallback (offline)` : `${opponent}: ${st.lastPolicy} · ${st.avgLatencyMs.toFixed(1)} ms`;
      e.slai.style.color = st.degraded ? '#ffb020' : '';
    } else e.slai.textContent = mode === 'spectate' ? 'Spectating' : '';

    const ls = h.lastStand;
    const txt = ls.own !== null ? `LAST STAND ${f1(ls.own)}s` : ls.enemy !== null ? `ENEMY LAST STAND ${f1(ls.enemy)}s` : '';
    e.last.classList.toggle('hidden', !txt);
    e.last.classList.toggle('good', ls.own === null && ls.enemy !== null);
    if (txt) e.last.textContent = txt;

    for (let i = 0; i < 9; i++) this.card(this.cards[i], h.squads[i], selectedSquad === i + 1);
  }

  private card(d: HTMLElement, c: HudModel['squads'][number], sel: boolean): void {
    const html = c.size
      ? `<div class="hd"><span class="no">${c.slot}</span><span>${c.size} <small>${c.status}</small>${c.activity === 'engaged' ? '<span class="badge eng">ENGAGED</span>' : ''}${c.activity === 'retreating' ? '<span class="badge ret">RETREAT</span>' : ''}${c.blocked ? '<span class="badge">BLOCKED</span>' : ''}</span></div>` +
        `<div class="hp"><i style="width:${c.hpPct}%"></i></div>` +
        `<div class="ln"><b>${c.doctrine}</b> · ${c.formation}</div>` +
        `<div class="ln">${c.objective}</div>` +
        `<div class="ln">target: ${c.target}</div>`
      : `<div class="hd"><span class="no">${c.slot}</span><span class="ln">empty</span></div><div class="ln">Ctrl-select, then Shift+${c.slot}</div>`;
    const key = html + sel;
    if (d.dataset.k !== key) {
      d.dataset.k = key;
      d.innerHTML = html;
      d.className = `card ${c.size ? c.status : 'empty'}${sel ? ' sel' : ''}`;
    }
  }

  hint(text: string | null): void {
    this.e.hint.classList.toggle('hidden', !text);
    if (text) this.e.hint.textContent = text;
  }

  toast(text: string, kind: 'info' | 'warn' | 'bad' | 'good' | 'gold' = 'info'): void {
    const t = document.createElement('div');
    t.className = `toast ${kind === 'info' ? '' : kind}`;
    t.textContent = text;
    this.e.toasts.appendChild(t);
    while (this.e.toasts.children.length > 6) this.e.toasts.firstChild?.remove();
    setTimeout(() => t.remove(), 5600);
  }

  reset(): void {
    this.last = '';
    this.e.toasts.innerHTML = '';
    for (const c of this.cards) delete c.dataset.k;
  }
}

export function fillKeyTables(): void {
  for (const id of ['keys-menu', 'keys-pause']) {
    const t = document.getElementById(id);
    if (!t) continue;
    t.innerHTML = KEY_HELP.map(([k, d]) => `<tr><td><kbd>${k}</kbd></td><td>${d}</td></tr>`).join('');
  }
}
