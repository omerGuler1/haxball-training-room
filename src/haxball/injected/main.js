// Browser-only: wires up HBInit callbacks, manages 1v1 match lifecycle, runs adversarial AI.

/* global HBInit */

(function boot() {
  const cfg = window.__HB_CONFIG__;
  if (!cfg) throw new Error("Missing __HB_CONFIG__");

  const room = HBInit({
    roomName: cfg.room.name,
    maxPlayers: cfg.room.maxPlayers,
    public: cfg.room.public,
    password: cfg.room.password || null,
    token: cfg.room.token,
    geo: cfg.room.geo || undefined,
    noPlayer: cfg.room.noPlayer,
  });

  window.__HB_ROOM__ = room;

  const state = window.__HB_STATE__;
  const { createRateLimiter } = window.__HB_UTIL__;
  const { isBotPlayer, getBall, getDisc, getPlayersWithDisc, estimateBallVel } = window.__HB_PERCEPTION__;
  const { adversarialIntent, moveIntentToAxes } = window.__HB_DECISION__;
  const { getMem } = window.__HB_BOTMEM_API__;
  const { handleChatCommand, broadcast } = window.__HB_COMMANDS__;

  const canLogTick = createRateLimiter(2000);
  const botTeam = cfg.training?.botTeamId === 2 ? 2 : 1;
  const traineeTeam = cfg.training?.traineeTeamId === 1 ? 1 : 2;

  // ── Helpers ──────────────────────────────────────────────

  const isAllMode = state.matchMode === "all";
  const isSquaresMode = state.matchMode === "squares";

  function ensureTeams() {
    const players = room.getPlayerList().filter((p) => p.id !== 0);
    for (const p of players) {
      if (isBotPlayer(p)) {
        if (p.team !== botTeam) room.setPlayerTeam(p.id, botTeam);
      } else if (state.afkIds.includes(p.id)) {
        if (p.team !== 0) room.setPlayerTeam(p.id, 0);
      } else if (isAllMode || isSquaresMode) {
        // All/squares mode: every non-AFK human plays
        if (p.team !== traineeTeam) room.setPlayerTeam(p.id, traineeTeam);
      } else if (state.activeHumanId && p.id === state.activeHumanId) {
        if (p.team !== traineeTeam) room.setPlayerTeam(p.id, traineeTeam);
      } else {
        // 1v1: queued humans go to spectator
        if (p.team !== 0) room.setPlayerTeam(p.id, 0);
      }
    }
  }

  // ── Squares mode helpers ────────────────────────────────

  // Stadium default ball props (3squares.hbs disc[0..2]) — playerPhysics.kickStrength=7.0
  const COURT_DEFAULT_DISC = { radius: 6.4, bCoef: 0.5, invMass: 1, color: 0xFFFF00 };
  // prof.hbs ball + invMass corrected for 3squares kickStrength.
  // Original prof: kickStr=6.3 × invMass=1.5 = 9.45; 3squares kickStr=7.0
  //   → match by invMass = 9.45/7.0 = 1.35
  const PROF_BALL_DISC = { radius: 8, bCoef: 0.4, invMass: 1.35, color: 0xFF7F00 };
  // valn v2 ball + invMass corrected for 3squares kickStrength.
  // Original valn: kickStr=4.3 × invMass=1.5 = 6.45; 3squares kickStr=7.0
  //   → match by invMass = 6.45/7.0 = 0.92
  const VALN_BALL_DISC = { radius: 5.8, bCoef: 0.443, invMass: 0.92, color: 0xBEBEBE };
  const BALL_MODE_CYCLE = ["default", "prof", "valn"];
  const BALL_BIGGER_STEP = 1.0;
  const BALL_BIGGER_MAX_USES = 5;
  const BALL_SPEED_STEP = 0.15;    // invMass delta per step (signed)
  const BALL_SPEED_MAX = 5;        // |speedCount| upper bound

  function applyCourtBallProps(court) {
    if (!court) return;
    const mode = court.ballMode || "default";
    let props;
    if (mode === "prof") {
      props = { ...PROF_BALL_DISC };
    } else if (mode === "valn") {
      props = { ...VALN_BALL_DISC };
    } else {
      const bigUses = Math.max(0, Math.min(BALL_BIGGER_MAX_USES, court.biggerCount || 0));
      const spd = Math.max(-BALL_SPEED_MAX, Math.min(BALL_SPEED_MAX, court.speedCount || 0));
      props = {
        ...COURT_DEFAULT_DISC,
        radius: COURT_DEFAULT_DISC.radius + bigUses * BALL_BIGGER_STEP,
        invMass: COURT_DEFAULT_DISC.invMass + spd * BALL_SPEED_STEP,
      };
    }
    try { room.setDiscProperties(court.discIndex, props); } catch {}
  }

  function resetCourtBall(court) {
    if (!court) return;
    court.biggerCount = 0;
    court.speedCount = 0;
    court.ballMode = "default";
    applyCourtBallProps(court);
  }

  function adjustCourtBigger(court, delta) {
    if (!court) return false;
    const cur = court.biggerCount || 0;
    const next = cur + delta;
    if (next < 0 || next > BALL_BIGGER_MAX_USES) return false;
    court.ballMode = "default";
    court.biggerCount = next;
    applyCourtBallProps(court);
    return true;
  }

  function adjustCourtSpeed(court, delta) {
    if (!court) return false;
    const cur = court.speedCount || 0;
    const next = cur + delta;
    if (next > BALL_SPEED_MAX || next < -BALL_SPEED_MAX) return false;
    court.ballMode = "default";
    court.speedCount = next;
    applyCourtBallProps(court);
    return true;
  }

  // Cycle ball mode: default → prof → valn → default. Returns new mode.
  function cycleCourtBall(court) {
    if (!court) return "default";
    const cur = court.ballMode || "default";
    const idx = BALL_MODE_CYCLE.indexOf(cur);
    const next = BALL_MODE_CYCLE[(idx + 1) % BALL_MODE_CYCLE.length];
    court.ballMode = next;
    if (next !== "default") {
      court.biggerCount = 0;
      court.speedCount = 0;
    }
    applyCourtBallProps(court);
    return next;
  }

  function getCourtByBotName(botName) {
    if (!state.courts) return null;
    const names = cfg.bots?.names || [];
    const idx = names.indexOf(botName);
    return idx >= 0 && idx < state.courts.length ? state.courts[idx] : null;
  }

  function getCourtByHumanId(humanId) {
    if (!state.courts) return null;
    return state.courts.find((c) => c.humanId === humanId) || null;
  }

  function assignHumanToCourt(humanId) {
    if (!state.courts || !state.courtJoinOrder) return null;
    for (const ci of state.courtJoinOrder) {
      if (!state.courts[ci].humanId) {
        state.courts[ci].humanId = humanId;
        state.courts[ci].counterTicks = 0;
        state.courts[ci].lastAnnouncedSec = 0;
        return state.courts[ci];
      }
    }
    return null; // all courts full
  }

  function unassignHuman(humanId) {
    if (!state.courts) return;
    const court = state.courts.find((c) => c.humanId === humanId);
    if (court) {
      court.humanId = null;
      court.counterTicks = 0;
      court.lastAnnouncedSec = 0;
      resetCourtBall(court);
    }
  }

  function unassignBot(botId) {
    if (!state.courts) return;
    const court = state.courts.find((c) => c.botId === botId);
    if (court) court.botId = null;
  }

  function teleportToCourts() {
    if (!state.courts) return;
    for (const court of state.courts) {
      if (court.botId) {
        try { room.setPlayerDiscProperties(court.botId, { x: court.botSpawnX, y: 0 }); } catch {}
      }
      if (court.humanId) {
        try { room.setPlayerDiscProperties(court.humanId, { x: court.humanSpawnX, y: 0 }); } catch {}
      }
    }
  }

  function squaresHasHumans() {
    if (!state.courts) return false;
    return state.courts.some((c) => c.humanId != null);
  }

  function squaresHasBots() {
    if (!state.courts) return false;
    return state.courts.some((c) => c.botId != null);
  }

  function squaresStartGameIfReady() {
    if (room.getScores() != null) return; // already running
    if (!squaresHasHumans() || !squaresHasBots()) return;
    ensureTeams();
    setTimeout(() => {
      try { room.startGame(); } catch {}
    }, 300);
  }

  function squaresAiTick() {
    if (state.pausedBot || !state.courts) return;
    const scores = room.getScores();
    if (!scores) return;
    const players = getPlayersWithDisc(room);

    // Self-heal: a court mapping can go stale if onPlayerLeave didn't fire (rare,
    // e.g. after watchdog restart races). Drop ids that no longer exist in the room.
    for (const court of state.courts) {
      if (court.botId != null && !players.some((x) => x.p.id === court.botId)) {
        court.botId = null;
      }
      if (court.humanId != null && !players.some((x) => x.p.id === court.humanId)) {
        court.humanId = null;
        court.counterTicks = 0;
        court.lastAnnouncedSec = 0;
        court.lastSignifBall = null;
      }
    }

    for (const court of state.courts) {
      if (!court.botId || !court.humanId) {
        // No human in this court — send idle (0,0) to bot so it stops
        if (court.botId) {
          const bp = players.find((x) => x.p.id === court.botId);
          if (bp) postBotControl(bp.p.name, { moveX: 0, moveY: 0, kick: false, kickPower: 0 });
        }
        continue;
      }

      const ball = getDisc(room, court.discIndex);
      court.ballVel = estimateBallVel(court.lastBall, ball);
      court.lastBall = ball;

      const botPlayer = players.find((x) => x.p.id === court.botId);
      if (!botPlayer?.disc || !ball) continue;

      // ── Counter: bot topa değerse sıfırla ──────────
      // Dynamic threshold — !bigger ball radius'unu değiştirebiliyor (6.4 → 11.4).
      // Sabit eşik kullanırsak büyük topta bot'a değse bile algılanmaz.
      const dx = botPlayer.disc.x - ball.x;
      const dy = botPlayer.disc.y - ball.y;
      const distSq = dx * dx + dy * dy;
      const botR  = botPlayer.disc.radius ?? 15;
      const ballR = ball.radius ?? 6.4;
      const touchDist = botR + ballR + 1;   // +1 small margin
      if (distSq < touchDist * touchDist) {
        const elapsedSec = Math.floor(court.counterTicks / 60);
        if (elapsedSec >= 10) {
          room.sendAnnouncement("Sifirlandi! Bot topa dokundu. Suren: " + elapsedSec + " sn", court.humanId, 0xff8866, "small", 1);
        }
        const holder = room.getPlayer(court.humanId);
        // Check for new global record
        if (holder && elapsedSec > (state.record?.seconds ?? 0)) {
          state.record = { name: holder.name, seconds: elapsedSec };
          broadcast(room, "Yeni rekor: " + elapsedSec + " sn - " + holder.name);
          window.__HB_BRIDGE__?.post("record.update", { playerName: holder.name, seconds: elapsedSec });
        }
        // Personal record (any player by nick) — DB upsert keeps only the best per name.
        if (holder && elapsedSec >= 5) {
          window.__HB_BRIDGE__?.post("record.updatePersonal", { playerName: holder.name, seconds: elapsedSec });
        }
        court.counterTicks = 0;
        court.lastAnnouncedSec = 0;
        court.stationaryTicks = 0;
        court.stationaryWarned = false;
        court.lastSignifBall = null;
      } else {
        // Position-based wedge detection: track the last position where the ball
        // moved meaningfully. Brief kick pulses (5-15 units) don't reset the
        // reference, but a real rally (40+ units) does. This defeats the
        // "tap kick every 5s to keep counter alive" cheat.
        const SIGNIF_MOVE = 40;         // units needed to count as real movement
        const WEDGE_WARN_TICKS = 3 * 60; // 3 seconds without real movement = wedged
        if (!court.lastSignifBall) {
          court.lastSignifBall = { x: ball.x, y: ball.y, tick: state.tick };
        }
        const sdx = ball.x - court.lastSignifBall.x;
        const sdy = ball.y - court.lastSignifBall.y;
        const movedFromRef = Math.sqrt(sdx * sdx + sdy * sdy);
        if (movedFromRef >= SIGNIF_MOVE) {
          court.lastSignifBall = { x: ball.x, y: ball.y, tick: state.tick };
        }
        const wedgedTicks = state.tick - court.lastSignifBall.tick;
        const wedged = wedgedTicks >= WEDGE_WARN_TICKS;

        if (wedged) {
          court.stationaryTicks = wedgedTicks; // for diagnostics / !status
          if (!court.stationaryWarned) {
            room.sendAnnouncement("Kosede bekleme cakkal, sayac durdu haberin olsun", court.humanId, 0xff8866, "small", 1);
            court.stationaryWarned = true;
          }
        } else {
          court.stationaryTicks = 0;
          court.stationaryWarned = false;
          court.counterTicks++;
          const currentSec = Math.floor(court.counterTicks / 60);
          if (currentSec > 0 && currentSec % 10 === 0 && currentSec !== court.lastAnnouncedSec) {
            room.sendAnnouncement("Sure: " + currentSec + " sn", court.humanId, 0x66ff66, "small", 1);
            court.lastAnnouncedSec = currentSec;
          }
        }
      }

      const mem = getMem(botPlayer.p.name);
      const intent = adversarialIntent(ball, court.ballVel, botPlayer.disc, mem?.lastKickTick ?? -999999, state.tick);
      if (intent.kick && mem) mem.lastKickTick = state.tick;

      const axes = moveIntentToAxes(botPlayer.disc, intent.targetPos);
      postBotControl(botPlayer.p.name, {
        moveX: axes.ax,
        moveY: axes.ay,
        kick: intent.kick,
        kickPower: intent.kickPower,
      });
    }
  }

  function resetCourtCounter(court) {
    if (!court) return;
    court.counterTicks = 0;
    court.lastAnnouncedSec = 0;
  }

  function countOnTeam(teamId) {
    return room.getPlayerList().filter((p) => p.id !== 0 && p.team === teamId).length;
  }

  function botsOnBotTeamCount() {
    return room
      .getPlayerList()
      .filter((p) => p.id !== 0 && isBotPlayer(p) && p.team === botTeam).length;
  }

  // ── Auto-start ──────────────────────────────────────────

  function attemptAutoStartMatch() {
    if (!cfg.training?.autoStart) return;
    if (state.matchState !== "STARTING") return;
    // If a previous game's scores linger, force-stop first
    if (room.getScores() != null) {
      try { room.stopGame(); } catch {}
      return; // retry on next poll cycle after stopGame clears scores
    }

    ensureTeams();
    if (botsOnBotTeamCount() < 1) return;
    if (countOnTeam(botTeam) < 1 || countOnTeam(traineeTeam) < 1) return;

    if (!isAllMode) {
      if (!state.activeHumanId) return;
      const human = room.getPlayer(state.activeHumanId);
      if (!human || human.team !== traineeTeam) return;
    }

    try {
      room.startGame();
    } catch (e) {
      window.__HB_BRIDGE__?.post("room.startGameError", { message: String(e?.message || e) });
    }
  }

  function scheduleAutoStartRetries() {
    if (!cfg.training?.autoStart) return;
    const delays = [150, 400, 900, 1800, 3500];
    for (const ms of delays) {
      setTimeout(() => attemptAutoStartMatch(), ms);
    }
  }

  // ── Stadium ─────────────────────────────────────────────

  function applyStadium() {
    const stadium = cfg.stadium?.jsonString;
    if (!stadium) return;
    try {
      room.setCustomStadium(stadium);
      broadcast(room, "Stadium loaded.");
    } catch (e) {
      broadcast(room, "Stadium load failed: " + (e?.message || e));
    }
  }

  // ── Bot control ─────────────────────────────────────────

  // Dedupe control packets — bot keys are sticky on the input side, so we only
  // need to send when the intent actually changes. A heartbeat refresh every
  // ~250ms guarantees recovery from a dropped packet. Cuts host→bot traffic
  // from 60/sec to <10/sec for the typical "bot keeps moving in one direction"
  // case, freeing the bot Chromium event loop and dropping observed bot ping.
  const lastIntent = new Map(); // botName -> { moveX, moveY, kick, sentAt }
  function postBotControl(botName, intent) {
    const prev = lastIntent.get(botName);
    const now = Date.now();
    const changed = !prev
      || prev.moveX !== intent.moveX
      || prev.moveY !== intent.moveY
      || prev.kick !== intent.kick;
    // Always send when intent changes, when kick fires (needs power), or as heartbeat.
    if (!changed && !intent.kick && prev && now - prev.sentAt < 250) return;
    lastIntent.set(botName, { moveX: intent.moveX, moveY: intent.moveY, kick: intent.kick, sentAt: now });
    window.__HB_BRIDGE__?.post("bot.control", {
      botName,
      tick: state.tick,
      ...intent,
    });
  }

  // ── Match lifecycle helpers ─────────────────────────────

  // Epoch counter — incremented on every state transition.
  // Pending timeouts capture the epoch and bail out if it changed.
  let lifecycleEpoch = 0;

  function emitRoomStatus() {
    const activeP = state.activeHumanId ? room.getPlayer(state.activeHumanId) : null;
    window.__HB_BRIDGE__?.post("room.statusUpdate", {
      matchState: state.matchState,
      matchMode: state.matchMode,
      playerCount: state.humanIds.length,
      scoreRed: state.matchScore?.red ?? 0,
      scoreBlue: state.matchScore?.blue ?? 0,
      activePlayer: activeP?.name || null,
      queueSize: state.queuedHumanIds.length,
    });
  }

  let startingEnteredAt = 0;
  function transitionTo(newState) {
    if (newState === "STARTING" && state.matchState !== "STARTING") {
      startingEnteredAt = Date.now();
    }
    // Leaving STARTING from any path: cancel the poll timer so it can't outlive the state.
    if (newState !== "STARTING" && startingPollTimer) {
      clearInterval(startingPollTimer);
      startingPollTimer = null;
    }
    state.matchState = newState;
    lifecycleEpoch++;
    emitRoomStatus();
  }

  /** Schedule a callback that auto-cancels if a state transition happened since scheduling. */
  function scheduleGuarded(fn, delayMs) {
    const epoch = lifecycleEpoch;
    setTimeout(() => {
      if (lifecycleEpoch !== epoch) return; // stale — state changed since we scheduled
      fn();
    }, delayMs);
  }

  let startingPollTimer = null;

  function stopGame() {
    try { room.stopGame(); } catch {}
  }

  function startNewMatch() {
    // Validate the active human still exists in the room and isn't AFK
    if (state.activeHumanId) {
      const p = room.getPlayer(state.activeHumanId);
      if (!p || state.afkIds.includes(state.activeHumanId)) {
        state.activeHumanId = null;
      }
    }
    if (!state.activeHumanId) {
      // No valid active human — try promoting from queue
      promoteNextHuman();
      return;
    }
    transitionTo("STARTING");
    ensureTeams();
    scheduleAutoStartRetries();
    // Keep polling while in STARTING (onGameTick doesn't fire without a running game)
    clearInterval(startingPollTimer);
    startingPollTimer = setInterval(() => {
      if (state.matchState !== "STARTING") {
        clearInterval(startingPollTimer);
        startingPollTimer = null;
        return;
      }
      // Timeout: if stuck in STARTING for >15s, recover
      if (Date.now() - startingEnteredAt > 15000) {
        clearInterval(startingPollTimer);
        startingPollTimer = null;
        // Re-validate active human and try again, or promote next
        if (state.activeHumanId) {
          const p = room.getPlayer(state.activeHumanId);
          if (!p || state.afkIds.includes(state.activeHumanId)) {
            state.activeHumanId = null;
          }
        }
        if (state.activeHumanId) {
          // Try once more from scratch
          transitionTo("WAITING");
          setTimeout(() => startNewMatch(), 100);
        } else {
          transitionTo("WAITING");
          promoteNextHuman();
        }
        return;
      }
      attemptAutoStartMatch();
    }, 500);
  }

  function promoteNextHuman() {
    // Skip AFK players and players who already left
    while (state.queuedHumanIds.length > 0) {
      const nextId = state.queuedHumanIds[0];
      if (state.afkIds.includes(nextId) || !room.getPlayer(nextId)) {
        state.queuedHumanIds.shift();
        continue;
      }
      break;
    }
    if (state.queuedHumanIds.length > 0) {
      state.activeHumanId = state.queuedHumanIds.shift();
      const p = room.getPlayer(state.activeHumanId);
      if (p) {
        broadcast(room, p.name + " is up next!");
      }
      // Notify remaining queue
      for (let i = 0; i < state.queuedHumanIds.length; i++) {
        const qp = room.getPlayer(state.queuedHumanIds[i]);
        if (qp) room.sendAnnouncement("You are #" + (i + 1) + " in queue.", qp.id, 0xdddddd, "small", 1);
      }
      startNewMatch();
      return;
    }
    // No queue — but check if any non-AFK human in humanIds we missed
    const fallback = state.humanIds.find((id) => !state.afkIds.includes(id) && room.getPlayer(id));
    if (fallback) {
      state.activeHumanId = fallback;
      const p = room.getPlayer(fallback);
      if (p) broadcast(room, p.name + " is up next!");
      startNewMatch();
      return;
    }
    state.activeHumanId = null;
    transitionTo("WAITING");
    broadcast(room, "Waiting for players...");
  }

  // ── AI tick ─────────────────────────────────────────────

  const decisionProfile = cfg.bots?.decisionProfile || "simple";
  const isProProfile    = decisionProfile === "pro";
  const isNnProfile     = decisionProfile === "nn";
  const isProBotProfile = decisionProfile === "probot";

  function aiTickPro() {
    const proApi = window.__HB_PRO_DECISION__;
    if (!proApi) return;
    const scores = room.getScores();
    if (!scores) return;

    const ball = getBall(room);
    state.ballVel = estimateBallVel(state.lastBall, ball);
    state.lastBall = ball;

    const players = getPlayersWithDisc(room);
    const botPlayer = players.find((x) => x.isBot && x.p.team === botTeam);
    if (!botPlayer?.disc || !ball) return;

    // Opponent in 1v1 = the active human (or any non-bot trainee)
    const oppPlayer = players.find((x) => !x.isBot && x.disc && x.p.team === traineeTeam);
    const opponent = oppPlayer?.disc || null;

    const intent = proApi.proIntent(
      { ball, ballVel: state.ballVel, bot: botPlayer.disc, opponent, botTeam },
      state.tick
    );

    postBotControl(botPlayer.p.name, {
      moveX: intent.ax,
      moveY: intent.ay,
      kick: intent.kick,
      kickPower: intent.kickPower,
    });

    if (state.debug && canLogTick()) {
      window.__HB_BRIDGE__?.post("debug.tick", {
        tick: state.tick,
        matchState: state.matchState,
        bot: botPlayer.p.name,
        proState: intent.debugState,
        ax: intent.ax, ay: intent.ay, kick: intent.kick,
      });
    }
  }

  function aiTickNN() {
    const nnApi = window.__HB_NN_DECISION__;
    if (!nnApi) return;
    const scores = room.getScores();
    if (!scores) return;

    const ball = getBall(room);
    state.ballVel = estimateBallVel(state.lastBall, ball);
    state.lastBall = ball;
    if (!ball) return;

    const players = getPlayersWithDisc(room);
    const botPlayer = players.find((x) => x.isBot && x.p.team === botTeam);
    if (!botPlayer?.disc) return;

    const oppPlayer = players.find((x) => !x.isBot && x.disc && x.p.team === traineeTeam);
    if (!oppPlayer?.disc) {
      // No opponent yet — idle
      postBotControl(botPlayer.p.name, { moveX: 0, moveY: 0, kick: false, kickPower: 0 });
      return;
    }

    // Velocities: prefer Haxball-provided xspeed/yspeed; fall back to estimateBallVel for ball.
    const botVel = { x: botPlayer.disc.xspeed || 0, y: botPlayer.disc.yspeed || 0 };
    const oppVel = { x: oppPlayer.disc.xspeed || 0, y: oppPlayer.disc.yspeed || 0 };
    const ballVel = (typeof ball.xspeed === "number")
      ? { x: ball.xspeed, y: ball.yspeed }
      : state.ballVel;

    const intent = nnApi.nnIntent(
      {
        ball, ballVel,
        bot: botPlayer.disc, botVel,
        opponent: oppPlayer.disc, oppVel,
        botTeam,
      },
      state.tick
    );

    postBotControl(botPlayer.p.name, {
      moveX: intent.ax,
      moveY: intent.ay,
      kick: intent.kick,
      kickPower: intent.kickPower,
    });

    if (state.debug && canLogTick()) {
      window.__HB_BRIDGE__?.post("debug.tick", {
        tick: state.tick,
        matchState: state.matchState,
        bot: botPlayer.p.name,
        nnState: intent.debugState,
        ax: intent.ax, ay: intent.ay, kick: intent.kick,
      });
    }
  }

  function aiTickProBot() {
    const treeApi = window.__HB_TREEBOT_DECISION__;
    if (!treeApi) return;
    const scores = room.getScores();
    if (!scores) return;

    const ball = getBall(room);
    state.ballVel = estimateBallVel(state.lastBall, ball);
    state.lastBall = ball;
    if (!ball) return;

    const players = getPlayersWithDisc(room);
    const botPlayer = players.find((x) => x.isBot && x.p.team === botTeam);
    if (!botPlayer?.disc) return;

    const oppPlayer = players.find((x) => !x.isBot && x.disc && x.p.team === traineeTeam);
    if (!oppPlayer?.disc) {
      postBotControl(botPlayer.p.name, { moveX: 0, moveY: 0, kick: false, kickPower: 0 });
      return;
    }

    const intent = treeApi.treeBotIntent(
      {
        ball,
        ballVel: state.ballVel,
        bot: botPlayer.disc,
        opponent: oppPlayer.disc,
        botTeam,
      },
      state.tick
    );

    postBotControl(botPlayer.p.name, {
      moveX: intent.ax,
      moveY: intent.ay,
      kick: intent.kick,
      kickPower: intent.kickPower,
    });

    if (state.debug && canLogTick()) {
      window.__HB_BRIDGE__?.post("debug.tick", {
        tick: state.tick,
        matchState: state.matchState,
        bot: botPlayer.p.name,
        treeState: intent.debugState,
        ax: intent.ax, ay: intent.ay, kick: intent.kick,
      });
    }
  }

  function aiTick() {
    if (state.pausedBot) return;
    if (isProProfile)    return aiTickPro();
    if (isNnProfile)     return aiTickNN();
    if (isProBotProfile) return aiTickProBot();
    const scores = room.getScores();
    if (!scores) return;

    const ball = getBall(room);
    state.ballVel = estimateBallVel(state.lastBall, ball);
    state.lastBall = ball;

    const players = getPlayersWithDisc(room);
    const botPlayer = players.find((x) => x.isBot && x.p.team === botTeam);
    if (!botPlayer?.disc || !ball) return;

    const mem = getMem(botPlayer.p.name);
    const intent = adversarialIntent(ball, state.ballVel, botPlayer.disc, mem?.lastKickTick ?? -999999, state.tick);

    if (intent.kick && mem) {
      mem.lastKickTick = state.tick;
    }

    const axes = moveIntentToAxes(botPlayer.disc, intent.targetPos);
    postBotControl(botPlayer.p.name, {
      moveX: axes.ax,
      moveY: axes.ay,
      kick: intent.kick,
      kickPower: intent.kickPower,
    });

    if (state.debug && canLogTick()) {
      window.__HB_BRIDGE__?.post("debug.tick", {
        tick: state.tick,
        matchState: state.matchState,
        activeHumanId: state.activeHumanId,
        bot: botPlayer.p.name,
        axes,
        kick: intent.kick,
      });
    }
  }

  // ── Room callbacks ──────────────────────────────────────

  room.onRoomLink = function (link) {
    window.__HB_BRIDGE__?.post("room.link", { link });
    broadcast(room, "Room created. Waiting for players...");
    applyStadium();
  };

  room.onPlayerJoin = function (player) {
    window.__HB_BRIDGE__?.post("room.playerJoin", { id: player.id, name: player.name, team: player.team });

    // ── Bot avatar ─────────────────────────────────────
    if (isBotPlayer(player)) {
      room.setPlayerAvatar(player.id, "🦇");
    }

    // ── Capture auth (humans only) — only available here, not from room.getPlayer() later
    if (!isBotPlayer(player) && player.auth) {
      state.playerAuths.set(player.id, player.auth);
    }

    // ── Squares mode ──────────────────────────────────
    if (isSquaresMode) {
      if (isBotPlayer(player)) {
        room.setPlayerTeam(player.id, botTeam);
        const court = getCourtByBotName(player.name);
        if (court) {
          court.botId = player.id;
          if (room.getScores() != null) {
            setTimeout(() => {
              try { room.setPlayerDiscProperties(player.id, { x: court.botSpawnX, y: 0 }); } catch {}
            }, 200);
          }
        }
        squaresStartGameIfReady();
        return;
      }
      // Human joined
      state.humanIds.push(player.id);
      room.sendAnnouncement("Antrenman odasina hosgeldiniz!", player.id, 0x66ff66, "bold", 1);
      setTimeout(() => {
        room.sendAnnouncement("!afk yazarak spec gecebilirsiniz", player.id, 0xdddddd, "small", 1);
      }, 1500);
      setTimeout(() => {
        room.sendAnnouncement("Iletisim ve sohbet icin discord: https://discord.gg/z84TRaSVT", player.id, 0x66aaff, "small", 1);
      }, 3000);
      const court = assignHumanToCourt(player.id);
      if (court) {
        room.setPlayerTeam(player.id, traineeTeam);
        broadcast(room, player.name + " → " + court.name + " kare!");
        setTimeout(() => {
          room.sendAnnouncement("Topu bottan uzak tut, bot degerse sayac sifirlanir.", player.id, 0xffcc66, "small", 1);
        }, 4500);
        if (room.getScores() != null) {
          setTimeout(() => {
            try { room.setPlayerDiscProperties(player.id, { x: court.humanSpawnX, y: 0 }); } catch {}
          }, 200);
        } else {
          squaresStartGameIfReady();
        }
      } else {
        state.queuedHumanIds.push(player.id);
        room.setPlayerTeam(player.id, 0);
        room.sendAnnouncement("Tum kareler dolu. Sirada #" + state.queuedHumanIds.length + " bekle.", player.id, 0xdddddd, "small", 1);
      }
      emitRoomStatus();
      return;
    }

    // ── 1v1 / All mode ────────────────────────────────
    if (isBotPlayer(player)) {
      room.setPlayerTeam(player.id, botTeam);
      if (state.activeHumanId && (state.matchState === "WAITING" || state.matchState === "STARTING")) {
        startNewMatch();
      }
      return;
    }

    state.humanIds.push(player.id);
    room.sendAnnouncement("Antrenman odasina hosgeldiniz!", player.id, 0x66ff66, "bold", 1);
    setTimeout(() => {
      room.sendAnnouncement("!afk yazarak spec gecebilirsiniz", player.id, 0xdddddd, "small", 1);
    }, 1500);
    setTimeout(() => {
      room.sendAnnouncement("Iletisim ve sohbet icin discord: https://discord.gg/z84TRaSVT", player.id, 0x66aaff, "small", 1);
    }, 3000);

    if (isAllMode) {
      room.setPlayerTeam(player.id, traineeTeam);
      if (state.matchState === "WAITING") {
        state.activeHumanId = player.id;
        startNewMatch();
      } else if (state.matchState === "PLAYING") {
        ensureTeams();
      }
    } else if (state.matchState === "WAITING" && !state.activeHumanId) {
      state.activeHumanId = player.id;
      broadcast(room, "Welcome " + player.name + "! Starting 1v1...");
      startNewMatch();
    } else {
      state.queuedHumanIds.push(player.id);
      room.setPlayerTeam(player.id, 0);
      room.sendAnnouncement(
        "A match is in progress. You are #" + state.queuedHumanIds.length + " in queue.",
        player.id, 0xdddddd, "small", 1
      );
    }
    emitRoomStatus();
  };

  room.onPlayerLeave = function (player) {
    window.__HB_BRIDGE__?.post("room.playerLeave", { id: player.id, name: player.name, team: player.team });

    // Remove from tracking arrays
    state.humanIds = state.humanIds.filter((id) => id !== player.id);
    state.queuedHumanIds = state.queuedHumanIds.filter((id) => id !== player.id);
    state.afkIds = state.afkIds.filter((id) => id !== player.id);
    state.playerAuths?.delete(player.id);
    state.loggedInIds?.delete(player.id);

    // ── Squares mode ──────────────────────────────────
    if (isSquaresMode) {
      if (isBotPlayer(player)) {
        unassignBot(player.id);
        return;
      }
      // Human left — free their court
      const court = getCourtByHumanId(player.id);
      if (court) {
        court.humanId = null;
        court.counterTicks = 0;
        court.lastAnnouncedSec = 0;
        resetCourtBall(court);
        broadcast(room, player.name + " ayrildi (" + court.name + " kare bos).");
        // Promote queued player into freed court
        while (state.queuedHumanIds.length > 0) {
          const nextId = state.queuedHumanIds.shift();
          const np = room.getPlayer(nextId);
          if (!np || state.afkIds.includes(nextId)) continue;
          court.humanId = nextId;
          court.counterTicks = 0;
          court.lastAnnouncedSec = 0;
          room.setPlayerTeam(nextId, traineeTeam);
          broadcast(room, np.name + " → " + court.name + " kare!");
          setTimeout(() => {
            room.sendAnnouncement("Topu bottan uzak tut, bot degerse sayac sifirlanir.", nextId, 0xffcc66, "small", 1);
          }, 1000);
          if (room.getScores() != null) {
            setTimeout(() => {
              try { room.setPlayerDiscProperties(nextId, { x: court.humanSpawnX, y: 0 }); } catch {}
            }, 200);
          }
          break;
        }
      }
      // Stop game if no humans left
      if (!squaresHasHumans() && room.getScores() != null) {
        stopGame();
        transitionTo("WAITING");
        broadcast(room, "Oyuncu kalmadi. Bekleniyor...");
      }
      emitRoomStatus();
      return;
    }

    // ── 1v1 / All mode ────────────────────────────────
    if (isBotPlayer(player)) {
      if (state.matchState === "PLAYING" || state.matchState === "STARTING") {
        broadcast(room, "Bot disconnected. Waiting for reconnect...");
        stopGame();
        transitionTo("WAITING");
      }
      return;
    }

    if (isAllMode) {
      const activeHumans = state.humanIds.filter((id) => !state.afkIds.includes(id));
      if (activeHumans.length === 0) {
        state.activeHumanId = null;
        if (state.matchState === "PLAYING" || state.matchState === "GOAL_SCORED" || state.matchState === "MATCH_OVER") {
          stopGame();
        }
        transitionTo("WAITING");
        broadcast(room, "Waiting for players...");
      } else if (state.activeHumanId === player.id) {
        state.activeHumanId = activeHumans[0];
      }
    } else if (state.activeHumanId === player.id) {
      state.activeHumanId = null;
      if (state.matchState === "PLAYING" || state.matchState === "GOAL_SCORED" || state.matchState === "MATCH_OVER") {
        stopGame();
        transitionTo("RESETTING");
        broadcast(room, player.name + " left the match.");
        scheduleGuarded(() => promoteNextHuman(), 1000);
      } else {
        promoteNextHuman();
      }
    }
    emitRoomStatus();
  };

  room.onGameStart = function () {
    transitionTo("PLAYING");
    state.matchScore = { red: 0, blue: 0 };
    ensureTeams();
    if (isProProfile)    window.__HB_PRO_DECISION__?.resetProMemory(state.tick);
    if (isNnProfile)     window.__HB_NN_DECISION__?.resetNnMemory();
    if (isProBotProfile) window.__HB_TREEBOT_DECISION__?.resetTreeBotMemory();

    if (isSquaresMode) {
      room.setScoreLimit(0);
      room.setTimeLimit(0);
      // Teleport everyone to their courts after a short delay for disc init
      setTimeout(() => teleportToCourts(), 150);
      // Neutralize the spurious "ballPhysics" disc 0 (black dot at center):
      // keep at (0,0) so camera doesn't pan, but make it invisible and immovable.
      setTimeout(() => {
        try {
          room.setDiscProperties(0, {
            x: 0, y: 0,
            xspeed: 0, yspeed: 0,
            radius: 0,
            invMass: 0,
          });
        } catch {}
      }, 200);
      broadcast(room, "Antrenman basladi!");
    } else {
      room.setScoreLimit(state.scoreLimit);
      room.setTimeLimit(state.timeLimit);
      broadcast(room, "Match started! First to " + state.scoreLimit + ".");
    }
    window.__HB_BRIDGE__?.post("room.gameStart", {});
  };

  room.onGameStop = function () {
    window.__HB_BRIDGE__?.post("room.gameStop", {});

    if (isSquaresMode) {
      // Squares: auto-restart if humans are still present
      if (squaresHasHumans() && squaresHasBots()) {
        transitionTo("WAITING");
        setTimeout(() => squaresStartGameIfReady(), 500);
      } else {
        transitionTo("WAITING");
      }
      return;
    }

    if (state.matchState === "MATCH_OVER" || state.matchState === "RESETTING") {
      return;
    }

    if (state.matchState === "PLAYING" || state.matchState === "GOAL_SCORED") {
      transitionTo("RESETTING");
      scheduleGuarded(() => {
        if (state.activeHumanId && room.getPlayer(state.activeHumanId)) {
          startNewMatch();
        } else {
          promoteNextHuman();
        }
      }, 1000);
    }
  };

  room.onTeamGoal = function (team) {
    transitionTo("GOAL_SCORED");

    if (team === 1) state.matchScore.red++;
    else state.matchScore.blue++;

    const humanScore = traineeTeam === 1 ? state.matchScore.red : state.matchScore.blue;
    const botScore = botTeam === 1 ? state.matchScore.red : state.matchScore.blue;

    broadcast(room, "GOAL! You " + humanScore + " - " + botScore + " Bot");
  };

  room.onTeamVictory = function (scores) {
    transitionTo("MATCH_OVER");

    const humanScore = traineeTeam === 1 ? scores.red : scores.blue;
    const botScore = botTeam === 1 ? scores.red : scores.blue;
    const humanWon = humanScore > botScore;

    if (scores.time >= scores.timeLimit && scores.timeLimit > 0 && humanScore === botScore) {
      broadcast(room, "Time's up! Draw " + humanScore + " - " + botScore + ".");
    } else if (humanWon) {
      broadcast(room, "You win! " + humanScore + " - " + botScore);
    } else {
      broadcast(room, "Bot wins! " + botScore + " - " + humanScore);
    }

    // Auto-restart after delay
    scheduleGuarded(() => {
      transitionTo("RESETTING");
      stopGame();

      scheduleGuarded(() => {
        if (state.activeHumanId && room.getPlayer(state.activeHumanId)) {
          startNewMatch();
        } else {
          promoteNextHuman();
        }
      }, 1000);
    }, state.matchOverPauseMs);
  };

  room.onPositionsReset = function () {
    state.lastBall = null;
    state.ballVel = { x: 0, y: 0 };
    if (isProProfile)    window.__HB_PRO_DECISION__?.resetProMemory(state.tick);
    if (isNnProfile)     window.__HB_NN_DECISION__?.resetNnMemory();
    if (isProBotProfile) window.__HB_TREEBOT_DECISION__?.resetTreeBotMemory();
    window.__HB_BRIDGE__?.post("room.positionsReset", {});

    // After a goal, positions reset and game continues
    if (state.matchState === "GOAL_SCORED") {
      transitionTo("PLAYING");
    }
  };

  room.onGameTick = function () {
    state.tick++;

    if (isSquaresMode) {
      if (state.matchState === "PLAYING") squaresAiTick();
      return;
    }

    if (state.matchState === "STARTING") {
      ensureTeams();
      if (state.tick % 30 === 0) attemptAutoStartMatch();
    }

    if (state.matchState === "PLAYING") {
      aiTick();
    }
  };

  room.onPlayerChat = function (player, message) {
    return handleChatCommand({ room, state, player, message });
  };

  // Expose lifecycle helpers for commands.js
  window.__HB_LIFECYCLE__ = {
    promoteNextHuman,
    startNewMatch,
    isSquaresMode,
    isAllMode,
    getCourtByHumanId,
    unassignHuman,
    assignHumanToCourt,
    squaresHasHumans,
    squaresStartGameIfReady,
    resetCourtBall,
    adjustCourtBigger,
    adjustCourtSpeed,
    cycleCourtBall,
    BALL_BIGGER_MAX_USES,
    BALL_SPEED_MAX,
  };
})();
