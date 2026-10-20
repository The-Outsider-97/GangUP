# GangUP sound files

Drop the sound files here, run `npm run build` (it rebuilds `manifest.json` and copies the folder next to the game) and reload the page.
**A cue without a file simply stays silent** - nothing breaks, so you can add the sounds one at a time.

`npm run audio:check` prints which cues still have no file.

## Naming

* The file name is the cue id: `shoot_main.ogg`.
* Several variants of one cue: `shoot_main_1.ogg`, `shoot_main_2.ogg`, ... One is picked at random, never the same twice in a row. Good for gunshots and hits.
* Formats: `.ogg` (recommended), `.mp3`, `.wav`, `.m4a`, `.aac`, `.flac`.
* A file whose name matches no cue is listed by `audio:check` so typos are easy to spot.

## Tips

* Music (`music_menu`, `music_game`) loops: export it so that the end flows into the start. It fades in/out when the screen changes and gets quieter when the game is paused.
* Loops marked *loop* (the optional heartbeats) must also be seamless.
* Rapid cues (`shoot_main`, `shoot_ally`, `hit_landed` ...) should be short (under 300 ms); the game limits how often and how many play at once.
* Keep the loudness similar between files; the mixer (Master / Effects / Music, and **M** to mute) is in the menu and the pause screen and is remembered.
* Enemy gunfire, deaths and overloads are only heard while your team can see that enemy; damage you take is always heard. This keeps sound from leaking hidden information.
* While the page is open, `__gangupAudio.report()` in the browser console shows what loaded, what was played and which requested cues are still missing.

## Cues

`requested` = on your list. `extra` = suggested additions.

### Your Main

| Cue id | | Plays when | Mix |
|---|---|---|---|
| `shoot_main` | requested | You fire the rifle | sfx, min 35 ms apart |
| `hit_landed` | requested | Your rifle shot hits an enemy (also, quieter, when an ally soldier does) | sfx, min 45 ms apart |
| `got_shot` | requested | You are hit by a bullet | sfx, min 50 ms apart |
| `got_hit_melee` | requested | You are hit by a sword or by a collision | sfx, min 80 ms apart |
| `hit_shield_block` | extra | A bullet is stopped by a shield (yours or one you can see) | sfx, min 60 ms apart |
| `sword_swing` | extra | A sword swipe (yours, or one you can see, quieter) | sfx, min 80 ms apart |
| `sword_thrust` | extra | A focused thrust | sfx, min 80 ms apart |
| `sword_hit` | extra | Your sword connects | sfx, min 60 ms apart |
| `kill_confirm` | extra | Your Main scores a kill | sfx, min 120 ms apart |

### Battlefield

| Cue id | | Plays when | Mix |
|---|---|---|---|
| `shoot_ally` | extra | An allied soldier fires (rate-limited) | sfx, min 110 ms apart |
| `shoot_enemy` | extra | An enemy you can see fires (rate-limited) | sfx, min 110 ms apart |
| `ally_hurt` | extra | An allied soldier is hit | sfx, min 140 ms apart |
| `bullet_cover` | extra | A bullet hits cover | sfx, min 120 ms apart |
| `contact_bump` | extra | Two bodies collide | sfx, min 150 ms apart |
| `soldier_down_ally` | extra | An allied soldier falls | sfx, min 100 ms apart |
| `soldier_down_enemy` | extra | An enemy soldier you can see falls | sfx, min 100 ms apart |
| `main_down_enemy` | extra | The enemy Main falls | sfx |
| `main_down_own` | extra | Your Main falls | sfx |

### Weapon

| Cue id | | Plays when | Mix |
|---|---|---|---|
| `reload_start` | requested | You start reloading | sfx, min 200 ms apart |
| `reload_finish` | requested | The reload completes | sfx, min 200 ms apart |
| `empty_click` | extra | You pull the trigger on an empty magazine | sfx, min 280 ms apart |
| `low_ammo` | extra | Magazine nearly empty (2 rounds) | sfx, min 1500 ms apart |
| `weapon_switch` | extra | Rifle <-> sword | sfx, min 120 ms apart |
| `strain_warning` | requested | Sword strain is near the limit (75 %) | sfx, min 1500 ms apart |
| `overload` | requested | Your sword overloads and is disabled for 6 s | sfx, min 500 ms apart |
| `overload_enemy` | extra | A visible enemy Main overloads its sword | sfx, min 500 ms apart |
| `strain_recovered` | requested | The sword has cooled down and is usable again | sfx, min 500 ms apart |

### Health

| Cue id | | Plays when | Mix |
|---|---|---|---|
| `hp_low` | requested | Your Main drops below 20 HP | sfx, min 3000 ms apart |
| `hp_critical` | requested | Your Main drops below 10 HP | sfx, min 3000 ms apart |
| `heal` | extra | Your Main heals from a hit it landed | sfx, min 300 ms apart |
| `shield_down` | extra | Your Main loses its last shield point | sfx, min 1000 ms apart |
| `heartbeat` | extra | Loop while your Main is under 20 HP (optional) | sfx, loop |
| `heartbeat_fast` | extra | Loop while your Main is under 10 HP, replaces the slow one (optional) | sfx, loop |

### Match

| Cue id | | Plays when | Mix |
|---|---|---|---|
| `wave_arrival` | requested | Your reinforcement wave arrives | sfx, min 1000 ms apart |
| `supply_spawn` | extra | A supply pickup appears in the centre | sfx, min 1000 ms apart |
| `supply_taken` | requested | Your Main collects the supply | sfx, min 500 ms apart |
| `supply_taken_enemy` | extra | The enemy Main takes the supply | sfx, min 500 ms apart |
| `enemy_spotted` | requested | The first time your team sees an enemy in this match | sfx, min 5000 ms apart |
| `enemy_main_spotted` | extra | The first time your team sees the enemy Main in this match | sfx, min 5000 ms apart |
| `streak_start` | requested | Your kill streak activates | sfx, min 1000 ms apart |
| `streak_end` | extra | Your kill streak ends | sfx, min 1000 ms apart |
| `streak_enemy_start` | requested | The enemy kill streak activates | sfx, min 1000 ms apart |
| `streak_enemy_end` | extra | The enemy kill streak ends | sfx, min 1000 ms apart |
| `last_stand_start` | extra | Your team enters Last Stand | sfx, min 2000 ms apart |
| `last_stand_tick` | extra | Once per second during the last 10 s of your Last Stand | sfx, min 700 ms apart |
| `match_start` | extra | The match begins | sfx, min 1000 ms apart |

### Orders

| Cue id | | Plays when | Mix |
|---|---|---|---|
| `order_confirm` | extra | A squad order is accepted | ui, min 70 ms apart |
| `order_denied` | extra | An order is rejected | ui, min 150 ms apart |
| `squad_edit` | extra | A squad is created, changed or disbanded | ui, min 100 ms apart |
| `stance_switch` | extra | Defensive <-> Offensive | ui, min 150 ms apart |

### Flow

| Cue id | | Plays when | Mix |
|---|---|---|---|
| `win` | requested | You win | sfx, min 1000 ms apart |
| `lose` | requested | You lose | sfx, min 1000 ms apart |
| `draw` | extra | The match is a draw | sfx, min 1000 ms apart |
| `surrender` | requested | You surrender | sfx, min 1000 ms apart |
| `pause` | requested | The game is paused | ui, min 200 ms apart |
| `resume` | requested | The game resumes | ui, min 200 ms apart |
| `to_menu` | requested | You go back to the menu | ui, min 300 ms apart |
| `ui_click` | extra | Any menu button | ui, min 40 ms apart |

### Music

| Cue id | | Plays when | Mix |
|---|---|---|---|
| `music_menu` | requested | Home page background music (loops) | music, loop |
| `music_game` | requested | In-game background music (loops) | music, loop |
