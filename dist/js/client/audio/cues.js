const c = (group, core, ch, vol, desc, extra = {}) => ({ group, core, ch, vol, desc, ...extra });
export const CUES = {
    // ------------------------------------------------------------------ your weapons
    shoot_main: c('Your Main', true, 'sfx', 0.8, 'You fire the rifle', { gap: 35, voices: 6 }),
    hit_landed: c('Your Main', true, 'sfx', 0.7, 'Your rifle shot hits an enemy (also, quieter, when an ally soldier does)', { gap: 45, voices: 4 }),
    got_shot: c('Your Main', true, 'sfx', 0.9, 'You are hit by a bullet', { gap: 50, voices: 3 }),
    got_hit_melee: c('Your Main', true, 'sfx', 0.9, 'You are hit by a sword or by a collision', { gap: 80, voices: 2 }),
    hit_shield_block: c('Your Main', false, 'sfx', 0.7, 'A bullet is stopped by a shield (yours or one you can see)', { gap: 60, voices: 3 }),
    sword_swing: c('Your Main', false, 'sfx', 0.8, 'A sword swipe (yours, or one you can see, quieter)', { gap: 80, voices: 3 }),
    sword_thrust: c('Your Main', false, 'sfx', 0.8, 'A focused thrust', { gap: 80, voices: 2 }),
    sword_hit: c('Your Main', false, 'sfx', 0.9, 'Your sword connects', { gap: 60, voices: 3 }),
    kill_confirm: c('Your Main', false, 'sfx', 0.8, 'Your Main scores a kill', { gap: 120 }),
    // ------------------------------------------------------------------ the battlefield
    shoot_ally: c('Battlefield', false, 'sfx', 0.35, 'An allied soldier fires (rate-limited)', { gap: 110, voices: 4 }),
    shoot_enemy: c('Battlefield', false, 'sfx', 0.45, 'An enemy you can see fires (rate-limited)', { gap: 110, voices: 4 }),
    ally_hurt: c('Battlefield', false, 'sfx', 0.4, 'An allied soldier is hit', { gap: 140, voices: 3 }),
    bullet_cover: c('Battlefield', false, 'sfx', 0.4, 'A bullet hits cover', { gap: 120, voices: 3 }),
    contact_bump: c('Battlefield', false, 'sfx', 0.45, 'Two bodies collide', { gap: 150, voices: 2 }),
    soldier_down_ally: c('Battlefield', false, 'sfx', 0.5, 'An allied soldier falls', { gap: 100, voices: 3 }),
    soldier_down_enemy: c('Battlefield', false, 'sfx', 0.5, 'An enemy soldier you can see falls', { gap: 100, voices: 3 }),
    main_down_enemy: c('Battlefield', false, 'sfx', 1, 'The enemy Main falls'),
    main_down_own: c('Battlefield', false, 'sfx', 1, 'Your Main falls'),
    // ------------------------------------------------------------------ weapon handling
    reload_start: c('Weapon', true, 'sfx', 0.8, 'You start reloading', { gap: 200 }),
    reload_finish: c('Weapon', true, 'sfx', 0.8, 'The reload completes', { gap: 200 }),
    empty_click: c('Weapon', false, 'sfx', 0.7, 'You pull the trigger on an empty magazine', { gap: 280 }),
    low_ammo: c('Weapon', false, 'sfx', 0.7, 'Magazine nearly empty (2 rounds)', { gap: 1500 }),
    weapon_switch: c('Weapon', false, 'sfx', 0.7, 'Rifle <-> sword', { gap: 120 }),
    strain_warning: c('Weapon', true, 'sfx', 0.7, 'Sword strain is near the limit (75 %)', { gap: 1500 }),
    overload: c('Weapon', true, 'sfx', 0.9, 'Your sword overloads and is disabled for 6 s', { gap: 500 }),
    overload_enemy: c('Weapon', false, 'sfx', 0.5, 'A visible enemy Main overloads its sword', { gap: 500 }),
    strain_recovered: c('Weapon', true, 'sfx', 0.7, 'The sword has cooled down and is usable again', { gap: 500 }),
    // ------------------------------------------------------------------ health
    hp_low: c('Health', true, 'sfx', 0.9, 'Your Main drops below 20 HP', { gap: 3000 }),
    hp_critical: c('Health', true, 'sfx', 1, 'Your Main drops below 10 HP', { gap: 3000 }),
    heal: c('Health', false, 'sfx', 0.6, 'Your Main heals from a hit it landed', { gap: 300 }),
    shield_down: c('Health', false, 'sfx', 0.7, 'Your Main loses its last shield point', { gap: 1000 }),
    heartbeat: c('Health', false, 'sfx', 0.55, 'Loop while your Main is under 20 HP (optional)', { loop: true }),
    heartbeat_fast: c('Health', false, 'sfx', 0.65, 'Loop while your Main is under 10 HP, replaces the slow one (optional)', { loop: true }),
    // ------------------------------------------------------------------ the match
    wave_arrival: c('Match', true, 'sfx', 0.8, 'Your reinforcement wave arrives', { gap: 1000 }),
    supply_spawn: c('Match', false, 'sfx', 0.7, 'A supply pickup appears in the centre', { gap: 1000 }),
    supply_taken: c('Match', true, 'sfx', 0.8, 'Your Main collects the supply', { gap: 500 }),
    supply_taken_enemy: c('Match', false, 'sfx', 0.6, 'The enemy Main takes the supply', { gap: 500 }),
    enemy_spotted: c('Match', true, 'sfx', 0.8, 'The first time your team sees an enemy in this match', { gap: 5000 }),
    enemy_main_spotted: c('Match', false, 'sfx', 0.9, 'The first time your team sees the enemy Main in this match', { gap: 5000 }),
    streak_start: c('Match', true, 'sfx', 0.9, 'Your kill streak activates', { gap: 1000 }),
    streak_end: c('Match', false, 'sfx', 0.6, 'Your kill streak ends', { gap: 1000 }),
    streak_enemy_start: c('Match', true, 'sfx', 0.9, 'The enemy kill streak activates', { gap: 1000 }),
    streak_enemy_end: c('Match', false, 'sfx', 0.6, 'The enemy kill streak ends', { gap: 1000 }),
    last_stand_start: c('Match', false, 'sfx', 0.9, 'Your team enters Last Stand', { gap: 2000 }),
    last_stand_tick: c('Match', false, 'sfx', 0.6, 'Once per second during the last 10 s of your Last Stand', { gap: 700 }),
    match_start: c('Match', false, 'sfx', 0.8, 'The match begins', { gap: 1000 }),
    // ------------------------------------------------------------------ orders
    order_confirm: c('Orders', false, 'ui', 0.5, 'A squad order is accepted', { gap: 70 }),
    order_denied: c('Orders', false, 'ui', 0.6, 'An order is rejected', { gap: 150 }),
    squad_edit: c('Orders', false, 'ui', 0.5, 'A squad is created, changed or disbanded', { gap: 100 }),
    stance_switch: c('Orders', false, 'ui', 0.6, 'Defensive <-> Offensive', { gap: 150 }),
    // ------------------------------------------------------------------ flow and interface
    win: c('Flow', true, 'sfx', 1, 'You win', { gap: 1000 }),
    lose: c('Flow', true, 'sfx', 1, 'You lose', { gap: 1000 }),
    draw: c('Flow', false, 'sfx', 1, 'The match is a draw', { gap: 1000 }),
    surrender: c('Flow', true, 'sfx', 0.9, 'You surrender', { gap: 1000 }),
    pause: c('Flow', true, 'ui', 0.7, 'The game is paused', { gap: 200 }),
    resume: c('Flow', true, 'ui', 0.7, 'The game resumes', { gap: 200 }),
    to_menu: c('Flow', true, 'ui', 0.7, 'You go back to the menu', { gap: 300 }),
    ui_click: c('Flow', false, 'ui', 0.5, 'Any menu button', { gap: 40 }),
    // ------------------------------------------------------------------ music
    music_menu: c('Music', true, 'music', 0.7, 'Home page background music (loops)', { loop: true }),
    music_game: c('Music', true, 'music', 0.6, 'In-game background music (loops)', { loop: true }),
};
export const CUE_IDS = Object.keys(CUES);
export const MUSIC_CUE = { menu: 'music_menu', game: 'music_game' };
/** `shoot_main_2.ogg` -> { cue: 'shoot_main' }; null when the name is not a known cue. */
export function cueOfFile(file) {
    const m = /^([a-z0-9_]+?)(?:_\d+)?\.(ogg|mp3|wav|m4a|aac|flac)$/i.exec(file);
    if (!m)
        return null;
    const id = m[1].toLowerCase();
    return id in CUES ? id : null;
}
//# sourceMappingURL=cues.js.map