# Haxball Adversarial Training Rooms

A 24/7 Haxball training server hosting **adversarial bots** that play against humans. Supports multiple modes (1v1 queue, free-for-all, multi-court free play) with auto-restart, AFK handling, and a queue system.

## Modes

- **`1v1`** — Queue-based 1v1 against a bot. New players wait in spectator until their turn.
- **`all`** — Everyone joins blue team, plays together against bots (red).
- **`squares`** — Multi-court free play. Map has 3 separate courts with their own balls; each court has its own bot, players are auto-assigned to courts as they join.

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
