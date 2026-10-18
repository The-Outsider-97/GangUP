import { RIFLE, SQUAD, SWORD, VISION, deg, ticksToSec } from '../engine/constants.js';
import { nearestObstacle } from '../engine/geom.js';
/** Faction identity never relies on colour alone (15.4): Green = round outline, Red = diamond outline. */
const COL = {
    green: '#3ddc84',
    red: '#ff5d5d',
    greenDark: '#145a37',
    redDark: '#6b1f1f',
    floor: '#14181d',
    grid: '#1b2128',
    cover: '#4a5666',
    coverEdge: '#98a8bd',
    text: '#e6edf3',
    shield: '#5cc8ff',
    warn: '#ffb020',
};
const teamColor = (t) => (t === 0 ? COL.green : COL.red);
const teamDark = (t) => (t === 0 ? COL.greenDark : COL.redDark);
const MAX_FX = 400;
export class Renderer {
    canvas;
    m;
    team;
    ctx;
    fog = null;
    fogCtx = null;
    fx = [];
    scale = 10;
    ox = 0;
    oy = 0;
    cssW = 0;
    cssH = 0;
    dpr = 1;
    dragRect = null;
    hover = null;
    fogEnabled = true;
    constructor(canvas, m, team) {
        this.canvas = canvas;
        this.m = m;
        this.team = team;
        this.ctx = canvas.getContext('2d');
        this.fog = typeof document !== 'undefined' ? document.createElement('canvas') : null;
        this.fogCtx = this.fog ? this.fog.getContext('2d') : null;
        m.listeners.push((e) => this.onEvent(e));
        this.resize();
    }
    setFog(on) {
        this.fogEnabled = on;
    }
    // ------------------------------------------------------------------ geometry
    resize() {
        const dpr = Math.min(2, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
        const rect = this.canvas.getBoundingClientRect();
        this.cssW = Math.max(320, rect.width || this.canvas.width);
        this.cssH = Math.max(200, rect.height || this.canvas.height);
        this.dpr = dpr;
        this.canvas.width = Math.round(this.cssW * dpr);
        this.canvas.height = Math.round(this.cssH * dpr);
        if (this.fog) {
            this.fog.width = this.canvas.width;
            this.fog.height = this.canvas.height;
        }
        const pad = 14;
        const s = Math.min((this.cssW - pad * 2) / this.m.arena.width, (this.cssH - pad * 2) / this.m.arena.height);
        this.scale = s;
        this.ox = (this.cssW - this.m.arena.width * s) / 2;
        this.oy = (this.cssH - this.m.arena.height * s) / 2;
    }
    toWorld(px, py) {
        return { x: (px - this.ox) / this.scale, y: (py - this.oy) / this.scale };
    }
    sx(x) { return this.ox + x * this.scale; }
    sy(y) { return this.oy + y * this.scale; }
    // ------------------------------------------------------------------ feedback effects (visibility-safe)
    seen(id) {
        const a = this.m.actors.get(id);
        return !!a && (a.team === this.team || this.m.teams[this.team].teamVisible.has(id));
    }
    add(f) {
        this.fx.push(f);
        if (this.fx.length > MAX_FX)
            this.fx.splice(0, this.fx.length - MAX_FX);
    }
    /** Effects are only generated for things the player may know about; hidden-enemy fire never reveals its origin. */
    onEvent(e) {
        const t = this.m.tick;
        const A = (id) => this.m.actors.get(id);
        switch (e.type) {
            case 'shot': {
                const shooter = A(e.actor);
                if (!shooter)
                    return;
                const victim = e.victim !== undefined ? A(e.victim) : undefined;
                const shooterKnown = this.seen(e.actor);
                const victimMine = !!victim && victim.team === this.team;
                const color = e.result === 'shield' ? COL.shield : e.result === 'body' ? '#ffffff' : e.result === 'ally' ? COL.warn : '#7d8a99';
                if (shooterKnown) {
                    this.add({ kind: 'tracer', x0: e.x0, y0: e.y0, x1: e.x1, y1: e.y1, color, born: t, life: 8, width: shooter.kind === 'main' ? 2 : 1, dashed: e.result === 'miss' });
                }
                if (e.result === 'shield' && victim && (shooterKnown || victimMine)) {
                    this.add({ kind: 'arc', x: victim.x, y: victim.y, r: victim.radius + 0.5, a0: victim.theta + Math.PI - deg(60), a1: victim.theta + Math.PI + deg(60), color: COL.shield, born: t, life: 14, width: 3 });
                    this.add({ kind: 'text', x: victim.x, y: victim.y - 1.2, text: 'BLOCK', color: COL.shield, born: t, life: 24 });
                }
                else if (e.result === 'body' && victim && (shooterKnown || victimMine)) {
                    this.add({ kind: 'ring', x: e.x1, y: e.y1, r: 0.9, color: '#ff4d4d', born: t, life: 12, width: 2 });
                    if (victim.kind === 'main' || victimMine)
                        this.add({ kind: 'text', x: victim.x, y: victim.y - 1.2, text: `-${Math.round(e.dmg)}`, color: '#ff8080', born: t, life: 26 });
                }
                else if (e.result === 'ally' && shooterKnown) {
                    this.add({ kind: 'cross', x: e.x1, y: e.y1, color: COL.warn, born: t, life: 24 }); // friendly lane block
                }
                else if (e.result === 'miss' && shooterKnown && shooter.team === this.team && shooter.kind === 'main') {
                    this.add({ kind: 'text', x: shooter.x, y: shooter.y - 1.4, text: 'out of range', color: '#7d8a99', born: t, life: 22 });
                }
                break;
            }
            case 'sword': {
                const a = A(e.actor);
                if (!a || !this.seen(e.actor))
                    return;
                const thrust = e.kind === 'thrust';
                const spec = thrust ? SWORD.thrust : SWORD.swipe;
                this.add({ kind: 'sector', x: a.x, y: a.y, theta: a.theta, spread: spec.sector, reach: spec.reach, color: thrust ? '#ffd24d' : '#ffffff', born: t, life: 10 });
                break;
            }
            case 'overload': {
                const a = A(e.actor);
                if (a && this.seen(e.actor)) {
                    this.add({ kind: 'ring', x: a.x, y: a.y, r: 1.6, color: COL.warn, born: t, life: 40, width: 3 });
                    this.add({ kind: 'text', x: a.x, y: a.y - 1.6, text: 'OVERLOAD', color: COL.warn, born: t, life: 50 });
                }
                break;
            }
            case 'kill': {
                const v = A(e.victim);
                // only mark deaths the player could witness (own units, or enemies currently visible)
                if (v && (v.team === this.team || this.m.teams[this.team].teamVisible.has(v.id))) {
                    this.add({ kind: 'ring', x: v.x, y: v.y, r: 1.4, color: teamColor(v.team), born: t, life: 18, width: 2 });
                }
                break;
            }
            case 'streakStart': {
                const main = this.m.mainOf(e.team);
                if (this.seen(main.id)) {
                    this.add({ kind: 'ring', x: main.x, y: main.y, r: 3, color: '#ffe066', born: t, life: 50, width: 4 });
                    this.add({ kind: 'text', x: main.x, y: main.y - 2.2, text: 'STREAK!', color: '#ffe066', born: t, life: 70 });
                }
                break;
            }
            case 'heal': {
                const a = A(e.actor);
                if (a && a.team === this.team && a.kind === 'main')
                    this.add({ kind: 'text', x: a.x, y: a.y - 1.2, text: `+${Math.round(e.amount)}`, color: COL.green, born: t, life: 26 });
                break;
            }
            case 'contact': {
                const a = A(e.a), b = A(e.b);
                if (a && b && (this.seen(a.id) || this.seen(b.id)))
                    this.add({ kind: 'ring', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, r: 0.7, color: '#ffa94d', born: t, life: 10, width: 2 });
                break;
            }
            case 'pickupTaken': {
                const p = this.m.arena.supply;
                this.add({ kind: 'text', x: p.x, y: p.y - 1.5, text: 'SUPPLY', color: '#7ee0ff', born: t, life: 50 });
                break;
            }
            default:
                break;
        }
    }
    /** UI-level feedback (e.g. an invalid squad target) drawn near the cursor or a point. */
    flashAt(x, y, text, color = '#ff8080') {
        this.add({ kind: 'text', x, y, text, color, born: this.m.tick, life: 50 });
    }
    // ------------------------------------------------------------------ frame
    draw(ctl, paused = false) {
        const c = this.ctx;
        const m = this.m;
        c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        c.clearRect(0, 0, this.cssW, this.cssH);
        c.fillStyle = '#0b0e12';
        c.fillRect(0, 0, this.cssW, this.cssH);
        this.drawFloor(c);
        this.drawZones(c);
        this.drawSupply(c);
        this.drawCover(c);
        this.drawStale(c);
        this.drawSelectionTargets(c, ctl);
        this.drawActors(c, ctl);
        this.drawEffects(c);
        if (this.fogEnabled)
            this.drawFog(c);
        this.drawSelectionBox(c);
        if (paused) {
            c.fillStyle = 'rgba(0,0,0,0.45)';
            c.fillRect(0, 0, this.cssW, this.cssH);
        }
        void m;
    }
    drawFloor(c) {
        const a = this.m.arena;
        c.fillStyle = COL.floor;
        c.fillRect(this.sx(0), this.sy(0), a.width * this.scale, a.height * this.scale);
        c.strokeStyle = COL.grid;
        c.lineWidth = 1;
        c.beginPath();
        for (let x = 0; x <= a.width; x += 10) {
            c.moveTo(this.sx(x), this.sy(0));
            c.lineTo(this.sx(x), this.sy(a.height));
        }
        for (let y = 0; y <= a.height; y += 10) {
            c.moveTo(this.sx(0), this.sy(y));
            c.lineTo(this.sx(a.width), this.sy(y));
        }
        c.stroke();
        c.strokeStyle = '#2a323c';
        c.lineWidth = 2;
        c.strokeRect(this.sx(0), this.sy(0), a.width * this.scale, a.height * this.scale);
    }
    drawZones(c) {
        for (const t of [0, 1]) {
            const z = this.m.arena.zones[t];
            c.fillStyle = t === 0 ? 'rgba(61,220,132,0.07)' : 'rgba(255,93,93,0.07)';
            c.fillRect(this.sx(z.x0), this.sy(z.y0), (z.x1 - z.x0) * this.scale, (z.y1 - z.y0) * this.scale);
            c.setLineDash([6, 6]);
            c.strokeStyle = t === 0 ? 'rgba(61,220,132,0.35)' : 'rgba(255,93,93,0.35)';
            c.lineWidth = 1;
            c.strokeRect(this.sx(z.x0), this.sy(z.y0), (z.x1 - z.x0) * this.scale, (z.y1 - z.y0) * this.scale);
            c.setLineDash([]);
        }
    }
    drawSupply(c) {
        const p = this.m.arena.supply;
        c.strokeStyle = '#3b5566';
        c.lineWidth = 1;
        c.setLineDash([3, 4]);
        c.beginPath();
        c.arc(this.sx(p.x), this.sy(p.y), 1.2 * this.scale, 0, Math.PI * 2);
        c.stroke();
        c.setLineDash([]);
        if (this.m.pickup) {
            const pulse = 0.5 + 0.5 * Math.sin(this.m.tick / 8);
            c.fillStyle = `rgba(126,224,255,${0.35 + pulse * 0.4})`;
            c.beginPath();
            c.rect(this.sx(p.x) - 6, this.sy(p.y) - 6, 12, 12);
            c.fill();
            c.strokeStyle = '#7ee0ff';
            c.lineWidth = 2;
            c.strokeRect(this.sx(p.x) - 6, this.sy(p.y) - 6, 12, 12);
            c.fillStyle = '#7ee0ff';
            c.font = 'bold 10px system-ui, sans-serif';
            c.textAlign = 'center';
            c.fillText('+', this.sx(p.x), this.sy(p.y) + 3.5);
        }
    }
    drawCover(c) {
        for (const o of this.m.arena.obstacles) {
            c.fillStyle = COL.cover;
            c.fillRect(this.sx(o.x0), this.sy(o.y0), (o.x1 - o.x0) * this.scale, (o.y1 - o.y0) * this.scale);
            c.strokeStyle = COL.coverEdge;
            c.lineWidth = 1.5;
            c.strokeRect(this.sx(o.x0), this.sy(o.y0), (o.x1 - o.x0) * this.scale, (o.y1 - o.y0) * this.scale);
        }
    }
    /** Last-known markers: clearly marked, frozen, at most 3 s old; never tracks the real position (15.3). */
    drawStale(c) {
        const ts = this.m.teams[this.team];
        for (const lk of ts.lastKnown.values()) {
            if (ts.teamVisible.has(lk.id))
                continue;
            const age = this.m.tick - lk.observedAt;
            if (age > VISION.lastKnown)
                continue;
            const a = this.m.actors.get(lk.id);
            if (!a || !a.alive)
                continue;
            const alpha = 1 - age / VISION.lastKnown;
            c.globalAlpha = 0.25 + alpha * 0.6;
            c.setLineDash([3, 3]);
            c.strokeStyle = COL.red;
            c.lineWidth = 1.5;
            this.shapePath(c, 1, this.sx(lk.x), this.sy(lk.y), Math.max(5, (a.kind === 'main' ? 0.7 : 0.45) * this.scale));
            c.stroke();
            c.setLineDash([]);
            c.fillStyle = COL.red;
            c.font = 'bold 10px system-ui, sans-serif';
            c.textAlign = 'center';
            c.fillText('?', this.sx(lk.x), this.sy(lk.y) + 3.5);
            c.globalAlpha = 1;
        }
    }
    drawSelectionTargets(c, ctl) {
        if (!ctl || !ctl.selectedSquad)
            return;
        const sq = this.m.teams[this.team].squads[ctl.selectedSquad - 1];
        const mv = sq.move;
        if (mv.kind === 'Move') {
            c.strokeStyle = 'rgba(61,220,132,0.8)';
            c.lineWidth = 1.5;
            c.setLineDash([4, 3]);
            c.beginPath();
            c.arc(this.sx(mv.x), this.sy(mv.y), 0.9 * this.scale, 0, Math.PI * 2);
            c.stroke();
            c.setLineDash([]);
            c.fillStyle = '#3ddc84';
            c.font = 'bold 11px system-ui, sans-serif';
            c.textAlign = 'center';
            c.fillText(String(sq.slot), this.sx(mv.x), this.sy(mv.y) + 4);
        }
        if (sq.rally) {
            c.strokeStyle = 'rgba(255,224,102,0.8)';
            c.lineWidth = 1.5;
            c.beginPath();
            c.moveTo(this.sx(sq.rally.x), this.sy(sq.rally.y) - 7);
            c.lineTo(this.sx(sq.rally.x) + 7, this.sy(sq.rally.y));
            c.lineTo(this.sx(sq.rally.x), this.sy(sq.rally.y) + 7);
            c.lineTo(this.sx(sq.rally.x) - 7, this.sy(sq.rally.y));
            c.closePath();
            c.stroke();
        }
        if (sq.target.kind === 'unit') {
            const t = this.m.actors.get(sq.target.id);
            if (t && t.alive && this.m.teams[this.team].teamVisible.has(t.id)) {
                c.strokeStyle = '#ffe066';
                c.lineWidth = 2;
                c.beginPath();
                c.arc(this.sx(t.x), this.sy(t.y), Math.max(8, t.radius * this.scale + 5), 0, Math.PI * 2);
                c.stroke();
            }
        }
    }
    shapePath(c, team, x, y, r) {
        c.beginPath();
        if (team === 0)
            c.arc(x, y, r, 0, Math.PI * 2);
        else {
            c.moveTo(x, y - r * 1.2);
            c.lineTo(x + r * 1.2, y);
            c.lineTo(x, y + r * 1.2);
            c.lineTo(x - r * 1.2, y);
            c.closePath();
        }
    }
    drawActors(c, ctl) {
        const ts = this.m.teams[this.team];
        const list = [];
        for (const a of this.m.live) {
            if (!a.alive)
                continue;
            if (a.team !== this.team && !ts.teamVisible.has(a.id))
                continue; // hidden enemies are never rendered
            list.push(a);
        }
        list.sort((p, q) => (p.kind === q.kind ? p.id - q.id : p.kind === 'main' ? 1 : -1)); // Mains on top
        const selSquad = ctl?.selectedSquad ?? 0;
        for (const a of list) {
            const x = this.sx(a.x), y = this.sy(a.y);
            const isMain = a.kind === 'main';
            const r = Math.max(isMain ? 8 : 5, a.radius * this.scale);
            // rear shield arc (120° behind facing) — thickness shows remaining shield
            if (a.shield > 0) {
                c.strokeStyle = COL.shield;
                c.globalAlpha = 0.35 + 0.65 * (a.shield / a.shieldMax);
                c.lineWidth = isMain ? 3 : 2;
                c.beginPath();
                c.arc(x, y, r + 3, a.theta + Math.PI - deg(60), a.theta + Math.PI + deg(60));
                c.stroke();
                c.globalAlpha = 1;
            }
            // body
            this.shapePath(c, a.team, x, y, r);
            c.fillStyle = teamDark(a.team);
            c.fill();
            c.strokeStyle = teamColor(a.team);
            c.lineWidth = isMain ? 3 : 2;
            c.stroke();
            if (isMain) {
                this.shapePath(c, a.team, x, y, r + 4);
                c.lineWidth = 1;
                c.stroke();
            }
            // facing line
            c.strokeStyle = '#ffffff';
            c.lineWidth = isMain ? 2 : 1.5;
            c.beginPath();
            c.moveTo(x, y);
            c.lineTo(x + Math.cos(a.theta) * (r + (isMain ? 7 : 4)), y + Math.sin(a.theta) * (r + (isMain ? 7 : 4)));
            c.stroke();
            if (isMain && a.mode === 'sword') {
                c.strokeStyle = '#ffd24d';
                c.lineWidth = 1.5;
                c.beginPath();
                c.arc(x, y, r + 7, a.theta - 0.5, a.theta + 0.5);
                c.stroke();
            }
            // squad glyph + selection rings for own units
            if (a.team === this.team && a.kind === 'soldier') {
                if (a.squadSlot) {
                    c.fillStyle = a.squadSlot === selSquad ? '#ffffff' : COL.green;
                    c.font = `bold ${a.squadSlot === selSquad ? 11 : 9}px system-ui, sans-serif`;
                    c.textAlign = 'center';
                    c.fillText(String(a.squadSlot), x, y + r + 10);
                }
                const squadSel = a.squadSlot !== 0 && a.squadSlot === selSquad;
                const unitSel = ctl?.selection.has(a.id);
                if (squadSel || unitSel) {
                    c.strokeStyle = unitSel ? '#ffe066' : '#ffffff';
                    c.lineWidth = 1.5;
                    c.setLineDash(unitSel ? [] : [2, 2]);
                    c.beginPath();
                    c.arc(x, y, r + 5, 0, Math.PI * 2);
                    c.stroke();
                    c.setLineDash([]);
                    if (squadSel && a.id === this.m.teams[this.team].squads[selSquad - 1].leader) {
                        c.fillStyle = '#ffe066';
                        c.fillRect(x - 2, y - r - 9, 4, 4); // leader marker
                    }
                }
            }
            // health bar: own units always; enemies only while visible (exact HP only while currently visible)
            const bw = isMain ? 34 : 18;
            const bx = x - bw / 2, by = y - r - (isMain ? 14 : 9);
            c.fillStyle = 'rgba(0,0,0,0.6)';
            c.fillRect(bx - 1, by - 1, bw + 2, 5);
            const f = Math.max(0, a.hp / a.hpMax);
            c.fillStyle = f > 0.5 ? '#4ade80' : f > 0.25 ? '#facc15' : '#f87171';
            c.fillRect(bx, by, bw * f, 3);
            if (a.shield > 0) {
                c.fillStyle = COL.shield;
                c.fillRect(bx, by + 3, bw * (a.shield / a.shieldMax), 1.5);
            }
            if (isMain) {
                c.fillStyle = COL.text;
                c.font = 'bold 10px system-ui, sans-serif';
                c.textAlign = 'center';
                c.fillText(a.team === this.team ? 'YOU' : 'ENEMY MAIN', x, y + r + 14);
            }
        }
    }
    drawEffects(c) {
        const t = this.m.tick;
        this.fx = this.fx.filter((f) => t - f.born <= f.life);
        for (const f of this.fx) {
            const k = (t - f.born) / f.life;
            c.globalAlpha = Math.max(0, 1 - k);
            switch (f.kind) {
                case 'tracer':
                    c.strokeStyle = f.color;
                    c.lineWidth = f.width;
                    c.setLineDash(f.dashed ? [4, 4] : []);
                    c.beginPath();
                    c.moveTo(this.sx(f.x0), this.sy(f.y0));
                    c.lineTo(this.sx(f.x1), this.sy(f.y1));
                    c.stroke();
                    c.setLineDash([]);
                    break;
                case 'ring':
                    c.strokeStyle = f.color;
                    c.lineWidth = f.width;
                    c.beginPath();
                    c.arc(this.sx(f.x), this.sy(f.y), (f.r + k * 0.8) * this.scale, 0, Math.PI * 2);
                    c.stroke();
                    break;
                case 'arc':
                    c.strokeStyle = f.color;
                    c.lineWidth = f.width;
                    c.beginPath();
                    c.arc(this.sx(f.x), this.sy(f.y), (f.r + k * 0.4) * this.scale, f.a0, f.a1);
                    c.stroke();
                    break;
                case 'text':
                    c.fillStyle = f.color;
                    c.font = 'bold 11px system-ui, sans-serif';
                    c.textAlign = 'center';
                    c.fillText(f.text, this.sx(f.x), this.sy(f.y) - k * 18);
                    break;
                case 'cross': {
                    const x = this.sx(f.x), y = this.sy(f.y);
                    c.strokeStyle = f.color;
                    c.lineWidth = 2;
                    c.beginPath();
                    c.moveTo(x - 5, y - 5);
                    c.lineTo(x + 5, y + 5);
                    c.moveTo(x + 5, y - 5);
                    c.lineTo(x - 5, y + 5);
                    c.stroke();
                    break;
                }
                case 'sector':
                    c.fillStyle = f.color;
                    c.globalAlpha = Math.max(0, 0.45 * (1 - k));
                    c.beginPath();
                    c.moveTo(this.sx(f.x), this.sy(f.y));
                    c.arc(this.sx(f.x), this.sy(f.y), f.reach * this.scale, f.theta - f.spread / 2, f.theta + f.spread / 2);
                    c.closePath();
                    c.fill();
                    break;
            }
            c.globalAlpha = 1;
        }
    }
    /** Dark overlay with the team's real field of view cut out (range 24 m, 220°, blocked by cover). */
    drawFog(c) {
        if (!this.fog || !this.fogCtx)
            return;
        const f = this.fogCtx;
        f.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        f.globalCompositeOperation = 'source-over';
        f.clearRect(0, 0, this.cssW, this.cssH);
        f.fillStyle = 'rgba(4,6,9,0.5)';
        f.fillRect(this.sx(0), this.sy(0), this.m.arena.width * this.scale, this.m.arena.height * this.scale);
        f.globalCompositeOperation = 'destination-out';
        f.fillStyle = 'rgba(0,0,0,1)';
        const obs = this.m.arena.obstacles;
        const rays = 40;
        for (const a of this.m.live) {
            if (!a.alive || a.team !== this.team)
                continue;
            f.beginPath();
            f.moveTo(this.sx(a.x), this.sy(a.y));
            const half = VISION.fov / 2;
            for (let i = 0; i <= rays; i++) {
                const ang = a.theta - half + (VISION.fov * i) / rays;
                const dx = Math.cos(ang), dy = Math.sin(ang);
                const t = nearestObstacle(obs, a.x, a.y, dx, dy, VISION.range);
                const d = t === null ? VISION.range : Math.min(t, VISION.range);
                f.lineTo(this.sx(a.x + dx * d), this.sy(a.y + dy * d));
            }
            f.closePath();
            f.fill();
            // close-range awareness disc so units never sit in the dark
            f.beginPath();
            f.arc(this.sx(a.x), this.sy(a.y), 1.5 * this.scale, 0, Math.PI * 2);
            f.fill();
        }
        f.globalCompositeOperation = 'source-over';
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.drawImage(this.fog, 0, 0);
        c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }
    drawSelectionBox(c) {
        if (!this.dragRect)
            return;
        const r = this.dragRect;
        c.strokeStyle = '#ffe066';
        c.fillStyle = 'rgba(255,224,102,0.10)';
        c.lineWidth = 1;
        c.setLineDash([4, 3]);
        const x = this.sx(Math.min(r.x0, r.x1)), y = this.sy(Math.min(r.y0, r.y1));
        const w = Math.abs(r.x1 - r.x0) * this.scale, h = Math.abs(r.y1 - r.y0) * this.scale;
        c.fillRect(x, y, w, h);
        c.strokeRect(x, y, w, h);
        c.setLineDash([]);
    }
}
export const RENDER_CONSTANTS = { rifleRange: RIFLE.range, squadMax: SQUAD.maxMembers, sec: ticksToSec };
//# sourceMappingURL=renderer.js.map