# Haxball Adversarial Training Rooms

A 24/7 Haxball training server hosting **adversarial bots** that play against humans. Supports multiple modes (1v1 queue, free-for-all, multi-court free play) with auto-restart, AFK handling, and a queue system.

## Modes

- **`1v1`** — Queue-based 1v1 against a bot. New players wait in spectator until their turn.
- **`all`** — Everyone joins blue team, plays together against bots (red).
- **`squares`** — Multi-court free play. Map has 3 separate courts with their own balls; each court has its own bot, players are auto-assigned to courts as they join.
- **`1v1pro`** — 1v1 with the cs7632-style behaviour-tree bot (rule-based "pro").
- **`1v1probot`** — 1v1 with the user-designed decision-tree bot (`treeBotDecision.js`).
- **`1v1nn`** — 1v1 against a neural-net policy. Loads weights from `NN_WEIGHTS_PATH` (HaxAI SP_V16 baseline or our trained checkpoints).
- **`classic`** — Single-bot 1v1 on the default Haxball stadium.

## Bot decision profiles

Set with `DECISION_PROFILE` in the env file:

| Profile | Description | Files |
|---|---|---|
| `simple` | Default chase-and-kick (decision.js) | `injected/decision.js` |
| `pro` | cs7632-derived behaviour tree (state machine + action atoms) | `injected/proDecision.js` |
| `probot` | User's decision-tree rule bot (positional + open-shot + wall bypass) | `injected/treeBotDecision.js` |
| `nn` | NN inference from `NN_WEIGHTS_PATH` JSON (13-dim obs → MLP → MultiDiscrete[3,3,2]) | `injected/nnDecision.js` |

## External bot (joining other rooms)

`src/external-bot/joinExternal.js` — uses `node-haxball` (reverse-engineered Haxball client) to join an *existing* room as a player and play with our NN weights:

```bash
node src/external-bot/joinExternal.js <ROOM_ID>
```

## Tech stack

- **Node.js + Puppeteer** — Each Haxball player (host + bots) is a real headless Chrome instance.
- **Two-process architecture** — A *host* runs `HBInit` and decides bot intents; *bot processes* are real clients that join the room and execute key inputs.
- **WebSocket IPC** — Host streams bot control packets (move axes, kick) to bot processes over a local WebSocket.
- **Browser-injected JS** — `state`, `perception`, `decision`, and `main` modules are concatenated and injected into the headless host page; they run inside the Haxball room context.
- **Lifecycle epoch** — Match transitions bump an epoch counter; pending `setTimeout` callbacks check the epoch and bail out if state has changed since they were scheduled (prevents stale auto-restart races).
- **Cloudflare-resilient join flow** — Bot join detects Haxball's iframe, fills the nickname input, clicks the OK button, and retries with backoff if blocked.
- **PM2-friendly** — Orchestrator forks host + bot processes with auto-restart and exponential backoff.

## Architecture

```
┌─────────────────┐
│  Orchestrator   │  forks host + bot processes
└────────┬────────┘
         │
    ┌────┴────────────────────────────┐
    │                                  │
┌───▼──────────────┐         ┌────────▼─────────┐
│ Host (Puppeteer) │         │ Bots (Puppeteer) │
│                  │  ◄────► │                  │
│  HBInit room     │   WS    │  Real clients    │
│  AI ticks        │         │  Press keys      │
└──────────────────┘         └──────────────────┘
```

The host injects browser-side modules into the headless page:

- `state.js` — Mutable match state (mode, scores, queue, AFK list, courts)
- `perception.js` — Reads ball/disc/player positions from the room
- `decision.js` — Bot AI: chase ball, kick when in control
- `commands.js` — Chat command parser (`!afk`, `!kick`, `!players`, etc.)
- `main.js` — Wires up `HBInit` callbacks, runs the match lifecycle, drives the AI tick

## Setup

```bash
npm install
cp .env.example .env
# fill HAXBALL_TOKEN, ADMIN_NICKNAMES, etc.
node src/index.js
```

For multi-room setups, pass an env file:

```bash
node src/index.js --env .env.3squares
```

## Running 24/7 with PM2

```bash
pm2 start src/index.js --name "3squares" -- --env .env.3squares
pm2 save
pm2 startup   # auto-start on reboot
```

PM2 restarts crashed processes; the orchestrator restarts crashed bots; bot processes retry the room join on Cloudflare blocks.

## Chat commands

- `!afk` — toggle AFK status (frees court / queue slot)
- `!status` — current match state, score, queue size
- `!players` — list players with IDs *(admin)*
- `!kick <id|name>` / `!ban <id|name>` *(admin)*
- `!start` / `!stop` / `!reset` *(admin)*

## Configuration

Key environment variables:

| Var | Description |
|-----|-------------|
| `HAXBALL_TOKEN` | Headless token from `haxball.com/headlesstoken` (24h expiry) |
| `STADIUM_PATH` | Path to `.hbs` stadium file |
| `MATCH_MODE` | `1v1`, `all`, or `squares` |
| `BOT_COUNT` / `BOT_NAMES` | Number and names of bots |
| `ADMIN_NICKNAMES` | Comma-separated list of admin nicks |
| `PUPPETEER_HEADLESS` | `true` for VPS, `false` for local debugging |
| `PUPPETEER_EXECUTABLE_PATH` | Chrome path on VPS (e.g. `/usr/bin/google-chrome`) |
| `DECISION_PROFILE` | `simple` / `pro` / `probot` / `nn` |
| `NN_WEIGHTS_PATH` | Path to weights JSON for `nn` profile (default: HaxAI SP_V16) |

## NN training pipeline (`hb_train/`)

Python sub-project for training NN bots. Built on **HaxballGym + ursinaxball** (Haxball physics) and **Stable-Baselines3 PPO**. Self-contained — own venv, own requirements.

```
hb_train/
├── requirements.txt
├── src/
│   ├── env/
│   │   ├── components.py    # ObsBuilder, ActionParser, RewardFunction(s), StateSetter, GoalScored, custom-stadium loader
│   │   ├── opponents.py     # HaxaiOpponent, BatBotOpponent, ProBotOpponent, MixedOpponent
│   │   └── wrapper.py       # HaxballSelfPlayEnv (Gymnasium) + per-opponent factories
│   ├── league.py            # LeagueOpponent + LeagueCheckpointCallback (self-play)
│   ├── train.py             # PPO training entry; flags: --opponent, --reward, --stadium, --kickoff-script, --live-render
│   ├── eval.py              # Head-to-head N-game eval; agent specs accept "batbot" | "probot" | weights.json
│   ├── watch.py             # Live ursinaxball renderer for any model vs any opponent
│   ├── export_weights.py    # SB3 .zip → HaxAI-format JSON (drop-in for nnDecision.js)
│   └── init_from_weights.py # Warm-start a fresh PPO from a HaxAI-format JSON
```

Quick start:

```bash
cd hb_train
python3.10 -m venv .venv
.venv/bin/pip install -r requirements.txt

# Train PPO (warm-start from SP_V16, league self-play)
.venv/bin/python -m src.train \
  --total-timesteps 10000000 \
  --n-envs 4 --vec-mode dummy \
  --init-from-weights ../models/sp_v16_haxai.json \
  --opponent league \
  --reward baseline \
  --stadium classic \
  --name v12_league

# Export to JSON & deploy
.venv/bin/python -m src.export_weights checkpoints/v12_league/final.zip ../models/v12_league.json
# Then: NN_WEIGHTS_PATH=./models/v12_league.json + node src/index.js --env .env.1v1nn
```

## Pro bot — work-in-progress roadmap

The current NN bots (SP_V16 baseline + our PPO attempts) plateau at "decent vs rule bots, weak vs humans". Multiple PPO runs hit reward-hacking dead-ends (single-tactic kickoff exploit, phantom kicks, hover farming) — short-horizon RL with prescriptive shaping is fundamentally limited. The proven path is **behavioural cloning from human replays + RL fine-tune** (AlphaStar / OpenAI Five recipe).

We have **358 human 1v1 replay files** in `haxball replays 2/` — classic + futsal mix, 5–60 min games. Ready for the project below.

### Faz A — Data engineering (1.5–2 weeks)

- Parse `.hbr2` replays via `node-haxball`'s Replay module
- Filter to clean 1v1 segments — drop pauses, substitutions, non-1v1 frames
- Categorise by stadium (classic / futsal-classic / futsal-big / luxora-like)
- Extract `(observation, action)` pairs in our 25–30 dim format
- Output: `data/train.npz`, `data/val.npz` (~5–10 M samples)

### Faz B — Architecture upgrade (1 week)

- New **`Obs25`** builder — adds: ball trajectory (3-frame delta), opp velocity history, score diff, time-left, nearest-wall distance, can_kick history
- Network: **256×256 MLP + optional LSTM-64** (~150 K params, vs SP_V16's ~20 K)
- Same MultiDiscrete[3,3,2] action — browser-deployable
- Updated `nnDecision.js` JS inference

### Faz C — Behavioural cloning (1 week + 2–3 days training)

- Supervised cross-entropy on `(obs, action)` pairs — 50–100 epochs
- ~6–12 h cloud GPU or ~2–3 days CPU
- Validation: 10 % hold-out
- Output: `bc_v1.json` — bot that **plays like humans**, no exploits, varied tactics

### Faz D — RL fine-tune from BC (1–2 weeks + 1–3 days training)

- Init PPO from BC weights — policy already encodes "good play"
- Reward: **only** goal/conceded (±10) + small time penalty. **No prescriptive shaping** (BC handles this)
- League opponent: BC + RL self-snapshots + anchor bots
- 5–20 M steps, ~12–24 h GPU or 3–7 days CPU
- Output: `rl_v1.json` — BC + RL, target: solid-human level

### Faz E — Iteration (continuous)

- Human evaluation rounds → identify weak spots
- Targeted curriculum / data augmentation / reward tweaks
- 3–4 cycles → pro-near level

### Compute budget

- Faz A–B: CPU sufficient
- Faz C–D: cloud GPU recommended (~$15–25 total on Vast.ai / RunPod)

### Lessons from earlier attempts (recorded for future-us)

- **Reward shaping is brittle**. Every constraint (anti-spam, anti-own-goal, anti-hover, multi-touch bonus) created a new exploit niche. The bot finds whatever loophole the reward function allows.
- **Homogeneous self-play league** locks in the agent's first-found exploit. Pool needs external diversity (different priors, different opponents) to push the agent toward general play.
- **HaxballGym + ursinaxball** is faithful for `classic.hbs` but breaks on futsal-style geometries (curved corners, sparse-wall stadiums) — ball escapes through walls. Train on `classic`, deploy elsewhere accepts a small domain gap.
- **HaxballGym Match auto-flips `action[0]` for blue.** Don't double-flip in the parser (silent bug — half a day lost).
- **HaxballGym `GoalScoredCondition`** has a typo (`self.red_score = current_state.blue_score`) — write a fixed `GoalScored` and use that instead.
- **Action `[2,1,0]` (POV-forward) for blue** lands as -1 in absolute coords *only after* the parser flip — verify physics every time you touch the parser.
