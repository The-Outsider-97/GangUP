const d2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
/**
 * Deterministic scripted tactical policy — the documented fallback used whenever SLAI is unavailable, late, or
 * malformed (GDD 12.3, 13.5, R10.3). It sees exactly what SLAI sees (an Observation) and nothing more.
 *
 * Priorities, highest first:
 *   P1 Protect Main      — Main HP < 35 % with a threat inside 18 m, or heavily outnumbered nearby: Defensive stance, squads fall back to the Main, Main retreats.
 *   P2 Organise          — group unassigned soldiers into squads 1 (Press), 2 (Harass), 3 (Defend).
 *   P3 Fix and Press     — if the enemy is visible: squad 1 presses the best visible target, squad 2 harasses a flank.
 *   P4 Investigate       — if only stale last-known records exist: send squad 1 to the frozen position (never auto-track).
 *   P5 Contest Supply    — otherwise squad 2 contests the supply point, Main resupplies when low on ammunition.
 *   P6 Advance           — otherwise squad 1 advances to the centre lane.
 *   Low-ammo squads Disengage to their reinforcement zone to refill.
 */
export function scriptedPolicy(obs) {
    const out = [];
    const base = { generation: obs.generation, issuedAt: obs.tick, expiresAt: obs.tick + 300 };
    const mk = (a) => { out.push({ ...base, ...a }); };
    const me = obs.own.main;
    if (!me.alive)
        return out;
    const dir = obs.team === 0 ? 1 : -1;
    const vis = obs.enemies.visible;
    const lk = obs.enemies.lastKnown;
    const zone = obs.terrain.zone;
    const zoneCentre = { x: (zone.x0 + zone.x1) / 2, y: (zone.y0 + zone.y1) / 2 };
    const ownN = obs.own.soldierCount;
    const hpFrac = me.hp / 100;
    const threatsNearMain = vis.filter((e) => d2(e, me) <= 14).length;
    const threatsClose = vis.filter((e) => d2(e, me) <= 18).length;
    // A wounded Main only recovers by dealing damage, so low HP alone is not "danger": it is danger when a threat is close.
    const danger = (hpFrac < 0.35 && threatsClose > 0) || (threatsNearMain >= 3 && threatsNearMain > ownN * 1.3);
    // focus enemy: enemy Main within reach, else the visible enemy closest to our Main
    const enemyMain = vis.find((e) => e.kind === 'main');
    const nearest = vis.length ? vis.reduce((p, q) => (d2(p, me) <= d2(q, me) ? p : q)) : null;
    const focus = enemyMain && d2(enemyMain, me) <= 20 ? enemyMain : nearest;
    const lkNearest = lk.length ? lk.reduce((p, q) => (d2(p, me) <= d2(q, me) ? p : q)) : null;
    // ---- P1/P2: stance
    const stance = danger || ownN < 5 ? 'defensive' : 'offensive';
    if (stance !== obs.own.stance)
        mk({ command: 'SetStance', stance });
    // ---- P2: organise squads
    const pool = obs.own.soldiers.filter((s) => s.squad === 0 && !s.guard).map((s) => s.id);
    let actions = 0;
    for (const slot of [1, 2, 3]) {
        if (pool.length < 2 || actions >= 2)
            break;
        const sq = obs.squads[slot - 1];
        if (sq.members.length >= 10)
            continue;
        const want = Math.min(10 - sq.members.length, slot === 1 ? 6 : 5, pool.length);
        if (sq.members.length >= 4 && pool.length < 3)
            continue;
        const take = pool.splice(0, want);
        mk({ command: 'CreateSquad', squad: slot, members: [...sq.members, ...take].slice(0, 10) });
        actions++;
    }
    // ---- squad orders
    const ordered = (slot, doctrine, formation, dest, target) => {
        const sq = obs.squads[slot - 1];
        if (!sq.members.length && !out.some((a) => a.command === 'CreateSquad' && a.squad === slot))
            return;
        if (sq.doctrine !== doctrine)
            mk({ command: 'SetDoctrine', squad: slot, doctrine });
        if (sq.formation !== formation)
            mk({ command: 'SetFormation', squad: slot, formation });
        if (dest) {
            const dx = clamp(dest.x, 2, obs.terrain.width - 2);
            const dy = clamp(dest.y, 2, obs.terrain.height - 2);
            if (!(sq.move.kind === 'Move' && d2(sq.move, { x: dx, y: dy }) < 3))
                mk({ command: 'MoveSquad', squad: slot, destination: { x: dx, y: dy } });
        }
        if (target !== undefined) {
            const wantId = target && target.id !== undefined ? target.id : -1;
            if (target === null) {
                if (sq.target.kind !== 'none')
                    mk({ command: 'SetTarget', squad: slot, target: { kind: 'none' } });
            }
            else if (sq.target.id !== wantId)
                mk({ command: 'SetTarget', squad: slot, target });
        }
    };
    const lowAmmo = (slot) => { const s = obs.squads[slot - 1]; return s.members.length > 0 && s.avgAmmo < 3; };
    const pressDest = () => {
        if (focus) {
            const dx = me.x - focus.x;
            const dy = me.y - focus.y;
            const len = Math.hypot(dx, dy) || 1;
            return { x: focus.x + (dx / len) * 6, y: focus.y + (dy / len) * 6 };
        }
        if (lkNearest)
            return { x: lkNearest.x, y: lkNearest.y };
        return { x: obs.terrain.width / 2 - dir * 12, y: obs.terrain.height / 2 };
    };
    for (let slot = 1; slot <= 9; slot++) {
        if (lowAmmo(slot)) {
            mk({ command: 'SetRally', squad: slot, destination: zoneCentre });
            if (obs.squads[slot - 1].doctrine !== 'Disengage')
                mk({ command: 'SetDoctrine', squad: slot, doctrine: 'Disengage' });
            continue;
        }
        if (danger) {
            ordered(slot, 'Defend', 'Compact', { x: me.x + dir * 3, y: me.y }, null);
            continue;
        }
        if (slot === 1) {
            ordered(1, 'Press', 'Line', pressDest(), focus ? { id: focus.id, kind: 'unit' } : null);
        }
        else if (slot === 2) {
            if (focus) {
                const side = focus.y < obs.terrain.height / 2 ? 1 : -1;
                ordered(2, 'Harass', 'Spread', { x: focus.x - dir * 2, y: clamp(focus.y + side * 12, 8, obs.terrain.height - 8) }, null);
            }
            else if (obs.resources.pickup && !lkNearest) {
                ordered(2, 'Defend', 'Compact', obs.resources.pickup, null);
            }
            else {
                ordered(2, 'Harass', 'Spread', { x: obs.terrain.width / 2 - dir * 10, y: me.y < obs.terrain.height / 2 ? 50 : 10 }, null);
            }
        }
        else {
            ordered(slot, 'Defend', 'Compact', { x: me.x + dir * 5, y: me.y + ((slot % 2) * 2 - 1) * 4 }, null);
        }
    }
    // ---- Main goal
    const goal = (g, dest, targetId = -1) => mk({ command: 'MainGoal', actor: me.id, goal: g, destination: dest, target: targetId >= 0 ? { id: targetId } : undefined, expiresAt: obs.tick + 240 });
    const visibleSoldiers = vis.filter((e) => e.kind === 'soldier').length;
    const duelOk = !!enemyMain && me.hp >= enemyMain.hp - 10 && ownN >= visibleSoldiers && hpFrac >= 0.4;
    const soldierTarget = vis.filter((e) => e.kind === 'soldier' && d2(e, me) <= 16).sort((p, q) => d2(p, me) - d2(q, me))[0];
    // the Main commands from behind the line: never beyond the centre line unless pushing a won fight
    const frontX = (x) => (dir === 1 ? Math.min(x, obs.terrain.width / 2 - 4) : Math.max(x, obs.terrain.width / 2 + 4));
    if (danger) {
        goal('Retreat', { x: clamp(me.x - dir * 10, zone.x0 + 1, zone.x1 - 1), y: clamp(me.y, 10, obs.terrain.height - 10) });
    }
    else if (enemyMain && (d2(enemyMain, me) <= 12 || (d2(enemyMain, me) <= 18 && duelOk && me.hp > enemyMain.hp + 10))) {
        goal('Engage', { x: enemyMain.x, y: enemyMain.y }, enemyMain.id);
    }
    else if (soldierTarget) {
        goal('Engage', { x: soldierTarget.x, y: soldierTarget.y }, soldierTarget.id); // pick off soldiers to heal
    }
    else if (focus && d2(focus, me) <= 16 && (focus.kind !== 'main' || duelOk)) {
        goal('Engage', { x: focus.x, y: focus.y }, focus.id);
    }
    else if (obs.resources.pickup && me.ammo < 25 && d2(obs.resources.pickup, me) < 40) {
        goal('Resupply', obs.resources.pickup);
    }
    else {
        const s1 = obs.squads[0];
        if (s1.centroid && s1.members.length)
            goal('MoveTo', { x: frontX(s1.centroid.x - dir * 8), y: s1.centroid.y });
        else
            goal('HoldNear', { x: zoneCentre.x + dir * 8, y: obs.terrain.height / 2 });
    }
    return out.slice(0, obs.budget.maxActions);
}
//# sourceMappingURL=scripted.js.map