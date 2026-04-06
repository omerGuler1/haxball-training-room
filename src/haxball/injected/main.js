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
        return state.courts[ci];
      }
    }
    return null; // all courts full
  }

  function unassignHuman(humanId) {
    if (!state.courts) return;
    const court = state.courts.find((c) => c.humanId === humanId);
    if (court) court.humanId = null;
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

  function postBotControl(botName, intent) {
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

  function transitionTo(newState) {
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
    // Validate the active human still exists in the room
    if (state.activeHumanId && !room.getPlayer(state.activeHumanId)) {
      state.activeHumanId = null;
    }
    if (!state.activeHumanId) {
      transitionTo("WAITING");
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
    } else {
      state.activeHumanId = null;
      transitionTo("WAITING");
      broadcast(room, "Waiting for players...");
    }
  }

  // ── AI tick ─────────────────────────────────────────────

  function aiTick() {
    if (state.pausedBot) return;
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
      const court = assignHumanToCourt(player.id);
      if (court) {
        room.setPlayerTeam(player.id, traineeTeam);
        broadcast(room, player.name + " → " + court.name + " kare!");
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
        broadcast(room, player.name + " ayrildi (" + court.name + " kare bos).");
        // Promote queued player into freed court
        while (state.queuedHumanIds.length > 0) {
          const nextId = state.queuedHumanIds.shift();
          const np = room.getPlayer(nextId);
          if (!np || state.afkIds.includes(nextId)) continue;
          court.humanId = nextId;
          room.setPlayerTeam(nextId, traineeTeam);
          broadcast(room, np.name + " → " + court.name + " kare!");
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

    if (isSquaresMode) {
      room.setScoreLimit(0);
      room.setTimeLimit(0);
      // Teleport everyone to their courts after a short delay for disc init
      setTimeout(() => teleportToCourts(), 150);
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
    getCourtByHumanId,
    unassignHuman,
    assignHumanToCourt,
    squaresHasHumans,
  };
})();
