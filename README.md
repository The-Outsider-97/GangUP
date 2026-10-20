# GangUP

A top-down, real-time hybrid of tactical action and squad strategy, implemented from **GangUP Game Design Document v0.3**.
Two factions, **Green (you)** and **Red (SLAI)**, each fight with one **Main** (rifle + sword, directional rear shield) and up to
**50 soldiers**, reinforced in waves by Main health. Capture the fight by controlling your Main directly and ordering up to nine
squads.

| Layer | Language | What it does |
|---|---|---|
| Simulation engine | **TypeScript** | Authoritative 60 Hz fixed-step rules: movement, hitscan rifle, sword, shields, vision, waves, streaks, Last Stand |
| Client | **TypeScript** (Canvas 2D + DOM) | Renderer, HUD, controls, menus, pause / surrender / result screens |
| **SLAI** (intelligence) | **Python 3** | Decision service over the **real SLAI agents** (`<SLAI>/src/agents`: Perception, Planning, Collaborative, Learning, Knowledge, Evaluation, Safety, Observability) around a trainable tactical policy; also hosts the built game. A stdlib-only `--agents lite` mode exists for machines without the SLAI checkout |

The engine never waits for SLAI. If the Python service is slow, offline or returns garbage, a deterministic scripted policy takes over
for that decision (GDD 12.3, R10.3) and SLAI is re-probed automatically.

## Run it

GangUP lives in `<SLAI>/applications/GangUP`. With the pre-built `dist/`, run from that folder with the Python environment of the SLAI repo
(it has the dependencies the real agents need):

```powershell
cd G:\GAIA\AI\SLAI\applications\GangUP
& G:\GAIA\AI\SLAI\venv\Scripts\python.exe -m slai.bridge        # 1) diagnose: loads the 8 real agents, runs probe decisions, prints what each did
& G:\GAIA\AI\SLAI\venv\Scripts\python.exe -m slai.server        # 2) serve the game AND the SLAI API on http://127.0.0.1:8765
```

Open <http://127.0.0.1:8765>, pick an opponent and difficulty, press **Start match**. The menu shows `real SLAI agents 8/8`.

```bash
python3 -m slai.server --agents lite       # stdlib-only built-in agents (no SLAI checkout, no torch): used by CI and offline demos
python3 -m slai.server --strict-agents     # refuse to start unless all eight real agents load
python3 -m slai.server --only collaborative,observability   # load just these real agents (the rest use the built-in fallback)
python3 -m slai.server --budget safety=400 --safety-enforce  # per-call time cap (ms); let a SafetyAgent 'block' verdict hold fire (default: recorded only)
```

The SLAI checkout is found automatically (walking up from `slai/bridge`), or via `--slai-root` / `$SLAI_ROOT`.

Start-up takes about a minute: the agents load, then warm up (Perception, Safety ...). Three bugs in the SLAI checkout that break the Perception and Planning agents
on every call are repaired in memory at load time (nothing on disk is touched; see `docs/SLAI.md`). Server and diagnostics print what was repaired.

To rebuild the client (needs TypeScript: `npm i` or a global `tsc`):

```bash
npm run build                     # tsc -p tsconfig.build.json && node tools/build-static.mjs  → dist/
npm run play                      # build + start the server
```

Menu options: **SLAI (Python service)**, **Scripted baseline** (built-in policy, no Python needed, only the static files), or **Spectate**
(baseline vs SLAI). Difficulty changes only SLAI's planning rate and reaction delay (easy 0.5 Hz / 1.1 s, normal 1 Hz / 0.4 s,
hard 2 Hz / 0.15 s); it never changes damage, accuracy, vision, health or spawning (GDD 13.4).

## Controls (GDD 15.1)

| Input | Action |
|---|---|
| W / S / A / D | Forward / backward / rotate left / rotate right (the Main fires along its facing) |
| Left click (hold to repeat) | Rifle fire, or Wide Swipe when the sword is equipped |
| Shift + left click | Focused Thrust (sword equipped only) |
| Tab / R | Switch rifle ↔ sword / reload |
| Q / E | Defensive / Offensive stance |
| 1–9 | Select squad |
| Ctrl (⌘) + click / drag | Select soldier(s); normal left click never selects |
| Shift + 1–9 | Create or replace that squad from the selection |
| Right click terrain / visible enemy | Squad move / set target preference (**Shift + right click** = set rally point) |
| F, right click ally · L, right click member | Follow ally · set squad leader |
| Z X C V · H · G | Defend / Press / Harass / Disengage · Hold · cycle Compact → Line → Spread |
| Esc / Space | Cancel targeting or open menu / pause |
| M | Mute / unmute all sound (volume sliders: menu and pause screen) |

HUD (GDD 15.2): Main HP/shield and streak shield bonus, weapon/magazine/reserve, sword strain and overload, stance, soldier count,
reinforcement countdown and the **wave arithmetic** line (`Base 5 + streak 1 = 6; capacity ok; received 6`), kill-streak progress / 30 s window /
40 s duration / 90 s cooldown, Last Stand timer, and nine squad cards (roster, health, doctrine, formation, objective, target,
engaged / retreating / blocked badges). Enemies are drawn only while the allied team can currently see them; an enemy lost behind cover
leaves a dashed `?` marker at its *last seen* position for at most 3 s. Green uses round outlines, Red diamond outlines; squads carry numbers
and selection rings, so colour is never the only cue (GDD 15.4).

## Effects and sound

**Hit feedback** (`src/client/effects.ts`, drawn by `renderer.ts`; visual only, never part of the simulation or the replay): whoever is hit is knocked back
a few pixels and vibrates for about 70 ms (never fewer than two rendered frames) and flashes white; the shooter recoils against its aim, a swordsman lunges along the swing.
Further effects: muzzle flashes, impact sparks (red for bodies, blue for shields, grey for cover), death bursts (larger for a Main), supply and wave pulses, reload
and streak rings, a camera tremor and a red screen-edge pulse when *your* Main is hurt, and a heartbeat vignette below 20 HP (stronger below 10). Every number is in `IMPACT`.

**Sound** (`src/client/audio/`): the code is complete, the sound files are yours to add. `cues.ts` lists the 60 cues (the ones you asked for are marked *requested*), `gameAudio.ts`
maps engine events and the state of your Main to them, `manager.ts` is the mixer (Master / Effects / Music, mute, rate limits, random variants, music crossfade, unlock
after the first click). Put `shoot_main.ogg` (or `shoot_main_1.ogg`, `_2` ... for variants) into `assets/audio/`, run `npm run build`, reload. A cue without a file is silent and
harmless. `npm run audio:check` shows what is still missing, `assets/audio/README.md` lists every cue with the moment it plays. Enemy sounds respect the fog of war.

## Where the GDD lives in the code

| GDD | Code |
|---|---|
| 3, 4 attributes, speed `F=V×M`, `B=F×0.7` | `src/engine/constants.ts`, `movement.ts` |
| 5 rifle (falloff, spread, ally/cover blocking), sword (swipe, thrust, strain, overload) | `combat.ts` |
| 6 vision (24 m, 220°, nine-point LoS, 3 s memory, shared view) | `visibility.ts` |
| 7 rear shield, contact damage, healing caps | `combat.ts`, `collision.ts` |
| 8, 9 waves, supply pickup, kill streak | `economy.ts` |
| 10 squads, doctrines, formations, bodyguards | `squads.ts`, `soldierAI.ts`, `locomotion.ts` |
| 11 Last Stand, terminal rules, draws | `match.ts` (`evaluateTerminal`) |
| 12, 13 SLAI protocol, agents, policy, difficulty | `src/ai/*`, `slai/*` (see `docs/SLAI.md`) |
| 15 controls and HUD | `src/client/*` |
| 17 fixed step, tick order, seeded RNG streams, determinism | `match.ts`, `rng.ts` |
| Appendix Official Ruleset | `constants.ts` + `tests/engine.test.ts` |

## Verification

```bash
npm run typecheck        # strict TypeScript
npm test                 # 56 tests: engine rules & boundaries, determinism, 50v50 stress, AI fuzzing, director fallbacks, episode/finish reporting, client logic, hit effects, sound cues
npm run test:py          # 100 tests: schema, safety, policy, orchestrator, HTTP server, trainer, episode-idempotent learning, stance hysteresis, real-agent bridge (some run the genuine Collaborative/Observability agents when a SLAI checkout is present)
npm run audio:check      # which sound cues still have no file in assets/audio
npm run headless -- --matches 10 --mode slai --url http://127.0.0.1:8765   # SLAI vs scripted baseline
```

Measured here: a 50 v 50 fight costs ≈ 1.8 ms per 60 Hz tick (budget 16.7 ms); the SLAI service answers in ≈ 0.4 ms locally (≈ 10 ms
including browser round trip). The client was also driven in headless Chromium (movement, firing, drag-select, squad creation, orders, pause,
surrender, live SLAI decisions, spectate).

## Training SLAI

```bash
npm run headless -- --matches 30 --seed 100 --difficulty hard --log data/selfplay_a.jsonl   # self-play observations
python3 -m slai.train --data data/selfplay_a.jsonl --out slai/data/weights.json
```

See `docs/SLAI.md` for what is learned, what is not, and the honest evaluation.

## Known limitations

* The shipped policy is **imitation of the scripted objectives, outcome-weighted**. Over 40 paired SLAI-vs-baseline matches it is at parity (20 wins, 18 losses, 2 timeouts), not stronger. The learning loop is real and
  the architecture supports improvement (reinforcement or search against the baseline is the obvious next step), but no superhuman claim is made.
* The GDD marks several constants as unvalidated; they are implemented exactly as written. Observations from play-testing: Main-vs-Main duels resolve very quickly, and one side
  can be snowballed by an early Main kill. These are tuning questions, not engine bugs.
* Balance (scripted vs scripted, 30 matches, seeds 700–729, 7-minute cap): Green 11, Red 14, and 5 matches undecided at the cap (average decided length ≈ 3 min). Stalemates can therefore happen;
  the GDD defines no match time limit, so none was added.
* Remapping keys (GDD 15.1 "SHOULD") is not implemented, and no sound files are shipped (the sound system is ready, see *Effects and sound*). The prototype uses one mirrored arena.
