const FORMATIONS = ['Compact', 'Line', 'Spread'];
const DOCTRINE_KEYS = { KeyZ: 'Defend', KeyX: 'Press', KeyC: 'Harass', KeyV: 'Disengage' };
/**
 * Translates player input into engine commands following the conflict-free map of GDD 15.1.
 * Pure logic: no DOM access, so it is driven identically by the browser layer and by tests.
 *
 *   W/S/A/D      move / rotate           Left click        rifle fire or Wide Swipe (held = repeat)
 *   Shift+click  Focused Thrust (sword)  Tab / R           switch mode / reload
 *   Q / E        Defensive / Offensive   1–9               select squad
 *   Shift+1–9    create/replace squad from the selection
 *   Ctrl(or Cmd)+click / drag   select soldier units
 *   Right click  terrain: move · visible enemy: target · (Shift+right = set rally point)
 *   F + right    follow ally             L + right         set leader (ally in the selected squad)
 *   Z X C V      Defend Press Harass Disengage             H hold · G cycle formation
 *   Esc          cancel targeting (else open menu)         Space pause
 */
export class HumanController {
    m;
    team;
    notify;
    selection = new Set();
    selectedSquad = 0;
    targetMode = 'none';
    held = { w: false, a: false, s: false, d: false };
    fireHeld = 'none';
    constructor(m, team, notify = () => { }) {
        this.m = m;
        this.team = team;
        this.notify = notify;
    }
    // ------------------------------------------------------------------ helpers
    send(cmd) {
        this.m.submit({ source: 'human', team: this.team, cmd, issuedAt: this.m.tick });
    }
    get main() {
        return this.m.mainOf(this.team);
    }
    /** An actor the player may interact with at a point: allies always, enemies only while currently visible (15.3). */
    actorAt(x, y, slack = 0.6) {
        let best = null;
        let bd = Infinity;
        const vis = this.m.teams[this.team].teamVisible;
        for (const a of this.m.live) {
            if (!a.alive)
                continue;
            if (a.team !== this.team && !vis.has(a.id))
                continue;
            const d = Math.hypot(a.x - x, a.y - y);
            if (d <= a.radius + slack && d < bd) {
                bd = d;
                best = a;
            }
        }
        return best;
    }
    // ------------------------------------------------------------------ held-key movement
    applyControls() {
        const throttle = (this.held.w ? 1 : 0) - (this.held.s ? 1 : 0);
        const turn = (this.held.d ? 1 : 0) - (this.held.a ? 1 : 0); // +1 = clockwise on screen (y-down)
        this.m.setControls(this.team, throttle, turn);
    }
    // ------------------------------------------------------------------ keyboard
    /** Returns true when the key was consumed (caller should preventDefault). `code` is KeyboardEvent.code. */
    keyDown(code, mods, repeat = false) {
        if (code === 'KeyW' || code === 'KeyA' || code === 'KeyS' || code === 'KeyD') {
            const k = code.slice(3).toLowerCase();
            if (!this.held[k]) {
                this.held[k] = true;
                this.applyControls();
            }
            return true;
        }
        if (repeat)
            return code === 'Tab';
        switch (code) {
            case 'Tab':
                this.m.mainAction(this.team, 'switch');
                return true;
            case 'KeyR':
                this.m.mainAction(this.team, 'reload');
                return true;
            case 'KeyQ':
                this.send({ t: 'Stance', stance: 'defensive' });
                return true;
            case 'KeyE':
                this.send({ t: 'Stance', stance: 'offensive' });
                return true;
            case 'KeyF':
                if (!this.requireSquad())
                    return true;
                this.targetMode = this.targetMode === 'follow' ? 'none' : 'follow';
                this.notify(this.targetMode === 'follow' ? 'Follow: right-click an ally' : 'Targeting cancelled', 'info');
                return true;
            case 'KeyL':
                if (!this.requireSquad())
                    return true;
                this.targetMode = this.targetMode === 'leader' ? 'none' : 'leader';
                this.notify(this.targetMode === 'leader' ? 'Leader: right-click a squad member' : 'Targeting cancelled', 'info');
                return true;
            case 'KeyH':
                if (this.requireSquad())
                    this.send({ t: 'SquadHold', slot: this.selectedSquad });
                return true;
            case 'KeyG':
                if (this.requireSquad()) {
                    const cur = this.m.teams[this.team].squads[this.selectedSquad - 1].formation;
                    this.send({ t: 'SquadFormation', slot: this.selectedSquad, formation: FORMATIONS[(FORMATIONS.indexOf(cur) + 1) % FORMATIONS.length] });
                }
                return true;
            default:
                break;
        }
        if (DOCTRINE_KEYS[code]) {
            if (this.requireSquad())
                this.send({ t: 'SquadDoctrine', slot: this.selectedSquad, doctrine: DOCTRINE_KEYS[code] });
            return true;
        }
        const digit = /^Digit([1-9])$/.exec(code);
        if (digit) {
            const slot = Number(digit[1]);
            if (mods.shift)
                this.assignSquad(slot);
            else {
                this.selectedSquad = slot;
                this.selection.clear();
                this.targetMode = 'none';
            }
            return true;
        }
        return false;
    }
    keyUp(code) {
        if (code === 'KeyW' || code === 'KeyA' || code === 'KeyS' || code === 'KeyD') {
            this.held[code.slice(3).toLowerCase()] = false;
            this.applyControls();
        }
    }
    /** Esc cancels targeting mode (GDD 15.1). Returns false when there was nothing to cancel, so the UI opens the menu instead. */
    cancel() {
        if (this.targetMode !== 'none') {
            this.targetMode = 'none';
            this.notify('Targeting cancelled', 'info');
            return true;
        }
        return false;
    }
    /** Release every held input (window blur, pause, match end). */
    releaseAll() {
        this.held = { w: false, a: false, s: false, d: false };
        this.fireHeld = 'none';
        this.applyControls();
    }
    requireSquad() {
        if (!this.selectedSquad) {
            this.notify('Select a squad first (keys 1–9)', 'warn');
            return false;
        }
        return true;
    }
    assignSquad(slot) {
        const ids = [...this.selection].filter((id) => {
            const a = this.m.actors.get(id);
            return a && a.alive && a.team === this.team && a.kind === 'soldier';
        });
        if (!ids.length) {
            this.notify('Shift+number needs selected soldiers (Ctrl+click or Ctrl+drag)', 'warn');
            return;
        }
        if (ids.length > 10) {
            this.notify('A squad holds at most 10 soldiers', 'bad');
            return;
        }
        this.send({ t: 'CreateSquad', slot, members: ids });
        this.selectedSquad = slot;
        this.selection.clear();
    }
    // ------------------------------------------------------------------ mouse
    /** `world` is in metres. button: 0 left, 2 right. */
    mouseDown(wx, wy, button, mods) {
        if (button === 0) {
            if (mods.ctrl) {
                const a = this.actorAt(wx, wy, 0.8);
                if (!mods.shift)
                    this.selection.clear();
                if (a && a.team === this.team && a.kind === 'soldier') {
                    if (this.selection.has(a.id) && mods.shift)
                        this.selection.delete(a.id);
                    else
                        this.selection.add(a.id);
                    this.selectedSquad = 0;
                }
                return;
            }
            // normal combat click: never selects (15.1)
            const sword = this.main.mode === 'sword';
            if (sword && mods.shift) {
                this.fireHeld = 'thrust';
                this.m.mainAction(this.team, 'thrust');
            }
            else {
                this.fireHeld = 'primary';
                this.m.mainAction(this.team, sword ? 'swipe' : 'fire');
            }
            return;
        }
        if (button === 2)
            this.rightClick(wx, wy, mods);
    }
    mouseUp(button) {
        if (button === 0)
            this.fireHeld = 'none';
    }
    /** Ctrl+drag: select every own living soldier whose centre is inside the rectangle (metres). */
    dragSelect(x0, y0, x1, y1, additive) {
        const lx = Math.min(x0, x1), hx = Math.max(x0, x1), ly = Math.min(y0, y1), hy = Math.max(y0, y1);
        if (!additive)
            this.selection.clear();
        for (const a of this.m.live) {
            if (a.alive && a.team === this.team && a.kind === 'soldier' && a.x >= lx && a.x <= hx && a.y >= ly && a.y <= hy)
                this.selection.add(a.id);
        }
        if (this.selection.size)
            this.selectedSquad = 0;
    }
    /** Called once per simulation tick: held primary button repeats the attack at the weapon's own cadence. */
    onTick() {
        if (this.fireHeld === 'none' || !this.main.alive)
            return;
        const sword = this.main.mode === 'sword';
        if (this.fireHeld === 'thrust') {
            if (sword)
                this.m.mainAction(this.team, 'thrust');
        }
        else
            this.m.mainAction(this.team, sword ? 'swipe' : 'fire');
    }
    rightClick(wx, wy, mods) {
        if (!this.requireSquad())
            return;
        const slot = this.selectedSquad;
        const sq = this.m.teams[this.team].squads[slot - 1];
        if (!sq.members.length) {
            this.notify(`Squad ${slot} is empty`, 'warn');
            this.targetMode = 'none';
            return;
        }
        const hit = this.actorAt(wx, wy);
        if (this.targetMode === 'follow') {
            if (hit && hit.team === this.team && !sq.members.includes(hit.id)) {
                this.send({ t: 'SquadFollow', slot, targetId: hit.id });
                this.targetMode = 'none';
            }
            else
                this.notify('Follow needs an allied unit outside the squad', 'bad');
            return;
        }
        if (this.targetMode === 'leader') {
            if (hit && hit.team === this.team && sq.members.includes(hit.id)) {
                this.send({ t: 'SquadLeader', slot, soldierId: hit.id });
                this.targetMode = 'none';
            }
            else
                this.notify('Leader must be a living member of the selected squad', 'bad');
            return;
        }
        if (hit && hit.team !== this.team) {
            this.send({ t: 'SquadTarget', slot, kind: 'unit', id: hit.id });
            return;
        }
        if (hit)
            return; // right-click on an ally without a targeting mode does nothing
        if (mods.shift)
            this.send({ t: 'SquadRally', slot, x: wx, y: wy });
        else
            this.send({ t: 'SquadMove', slot, x: wx, y: wy });
    }
}
//# sourceMappingURL=controller.js.map