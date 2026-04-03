// Browser-only: wires up HBInit callbacks and runs AI each tick.

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
  const { pickTrainee, getBall, getPlayersWithDisc, estimateBallVel } = window.__HB_PERCEPTION__;
  const { chooseChaser, supportSpot, moveIntentToAxes, shouldKickToTarget } = window.__HB_DECISION__;
  const { dist } = window.__HB_MATH__;
  const { getMem } = window.__HB_BOTMEM_API__;
  const { incomingPassScore, pickPassTarget, kickPowerForDistance } = window.__HB_RECEIVE_PASS__;
  const { handleChatCommand, broadcast } = window.__HB_COMMANDS__;

  const canLogTick = createRateLimiter(2000);

  function ensureTeams() {
    const trainee = state.traineeId ? room.getPlayer(state.traineeId) : null;
    if (trainee && trainee.team !== 1) room.setPlayerTeam(trainee.id, 1);
    const bots = room.getPlayerList().filter((p) => window.__HB_PERCEPTION__.isBotPlayer(p));
    for (const b of bots) {
      if (b.team !== 1) room.setPlayerTeam(b.id, 1);
    }
  }

  function autoStartIfReady() {
    if (!cfg.training?.autoStart) return;
    if (room.getScores() != null) return;
    const trainee = state.traineeId ? room.getPlayer(state.traineeId) : null;
    if (!trainee) return;
    const red = room.getPlayerList().filter((p) => p.id !== 0 && p.team === 1);
    if (red.length >= 2) {
      // Team changes are async-ish; do a small delayed start to avoid starting while bots are still spectators.
      setTimeout(() => {
        const red2 = room.getPlayerList().filter((p) => p.id !== 0 && p.team === 1);
        if (room.getScores() == null && red2.length >= 2) room.startGame();
      }, 250);
    }
  }

  function applyStadium() {
    const stadium = cfg.stadium?.jsonString;
    if (!stadium) return;
    try {
      room.setCustomStadium(stadium);
      broadcast(room, "Stadium loaded.");
    } catch (e) {
      broadcast(room, `Stadium load failed: ${e?.message || e}`);
    }
  }

  function postBotControl(botName, intent) {
    window.__HB_BRIDGE__?.post("bot.control", {
      botName,
      tick: state.tick,
      ...intent,
    });
  }

  function aiTick() {
    if (state.pausedBot) return;
    const scores = room.getScores();
    if (!scores) return;

    const ball = getBall(room);
    state.ballVel = estimateBallVel(state.lastBall, ball);
    state.lastBall = ball;

    const players = getPlayersWithDisc(room);
    const trainee = state.traineeId ? players.find((x) => x.p.id === state.traineeId) : null;
    const traineeDisc = trainee?.disc ?? null;
    const botPlayers = players.filter((x) => x.isBot && x.p.team !== 0);
    const activeBots = botPlayers.slice(0, state.botCount);
    if (activeBots.length === 0 || !traineeDisc) return;

    const chaserId = chooseChaser(ball, traineeDisc, activeBots);
    const otherBot = activeBots.length === 2 ? activeBots.find((b) => b.p.id !== chaserId) : null;

    for (const bot of activeBots) {
      if (!bot.disc) continue;
      const isChaser = chaserId != null && bot.p.id === chaserId;
      const mem = getMem(bot.p.name);

      let targetPos = { x: 0, y: 0 };
      let kick = false;
      let kickPower = 0.75;

      if (!ball) {
        targetPos = { x: 0, y: 0 };
      } else if (isChaser) {
        // Receive heuristic: if ball is coming to bot, prioritize receiving over raw chase.
        const passScore = incomingPassScore(ball, state.ballVel, bot.disc);
        const receiving = passScore > 4.0 && dist(ball, bot.disc) < 220;

        if (receiving && mem) {
          mem.state = "receive";
          if (mem.receiveStartTick == null) mem.receiveStartTick = state.tick;
        } else if (mem) {
          mem.state = "chase";
          mem.receiveStartTick = null;
        }

        // Chase/intercept with small velocity lead.
        targetPos = { x: ball.x + state.ballVel.x * 2.5, y: ball.y + state.ballVel.y * 2.5 };

        // Pass behavior: if controlled, wait a short settle window sometimes before kicking.
        const passTargetDisc = pickPassTarget({
          trainee: traineeDisc,
          otherBot: otherBot?.disc || null,
          mode: state.mode,
        });

        const controlled = window.__HB_DECISION__.hasControl(ball, bot.disc, state.ballVel);
        if (mem) {
          if (controlled) {
            if (mem.controlSinceTick == null) mem.controlSinceTick = state.tick;
          } else {
            mem.controlSinceTick = null;
          }
        }

        const settleTicks = 8; // ~130ms at 60 tps
        const oneTouchProb = 0.45;
        const canOneTouch = controlled && Math.random() < oneTouchProb;
        const canSettle = controlled && mem?.controlSinceTick != null && state.tick - mem.controlSinceTick >= settleTicks;

        const kickCooldownTicks = 18;
        const offCooldown = !mem || state.tick - mem.lastKickTick >= kickCooldownTicks;

        if (offCooldown && (canOneTouch || canSettle)) {
          kick = shouldKickToTarget(ball, bot.disc, passTargetDisc, state.ballVel);
          const d = dist(bot.disc, passTargetDisc);
          kickPower = kickPowerForDistance(d) * state.passSpeed;
          kickPower = Math.max(0.2, Math.min(1.0, kickPower));
          if (kick && mem) {
            mem.lastKickTick = state.tick;
            mem.lastTargetName = passTargetDisc === traineeDisc ? "trainee" : "bot";
          }
        }
      } else {
        const dist = state.supportDist;
        if (state.mode === "wall") targetPos = supportSpot(ball, traineeDisc, 1, dist * 0.65, 170);
        else if (state.mode === "solo") targetPos = supportSpot(ball, traineeDisc, 1, dist, 110);
        else if (state.mode === "triangle") {
          const side = bot.p.name === (cfg.bots?.names?.[0] || "") ? 1 : -1;
          targetPos = supportSpot(ball, traineeDisc, side, dist, 140);
        } else {
          const side = Math.random() < 0.5 ? 1 : -1;
          targetPos = supportSpot(ball, traineeDisc, side, dist, 120);
        }
        if (mem) mem.state = "support";
      }

      const axes = moveIntentToAxes(bot.disc, targetPos);
      postBotControl(bot.p.name, { moveX: axes.ax, moveY: axes.ay, kick, kickPower });

      if (state.debug && canLogTick()) {
        window.__HB_BRIDGE__?.post("debug.tick", {
          tick: state.tick,
          mode: state.mode,
          traineeId: state.traineeId,
          chaserId,
          bot: bot.p.name,
          botState: mem?.state,
          lastTarget: mem?.lastTargetName,
          axes,
          kick,
        });
      }
    }
  }

  room.onRoomLink = function (link) {
    window.__HB_BRIDGE__?.post("room.link", { link });
    broadcast(room, "Room created.");
    broadcast(room, `Link: ${link}`);
    applyStadium();
  };

  room.onPlayerJoin = function (player) {
    window.__HB_BRIDGE__?.post("room.playerJoin", { id: player.id, name: player.name, team: player.team });
    if (state.traineeId == null) state.traineeId = pickTrainee(room);
    ensureTeams();
    autoStartIfReady();
  };

  room.onPlayerLeave = function (player) {
    window.__HB_BRIDGE__?.post("room.playerLeave", { id: player.id, name: player.name, team: player.team });
    if (state.traineeId === player.id) {
      state.traineeId = pickTrainee(room);
      broadcast(room, "Trainee left. Bots will idle until trainee is present.");
    }
  };

  room.onPositionsReset = function () {
    state.lastBall = null;
    state.ballVel = { x: 0, y: 0 };
    window.__HB_BRIDGE__?.post("room.positionsReset", {});
  };

  room.onGameStart = function () {
    ensureTeams();
    window.__HB_BRIDGE__?.post("room.gameStart", {});
  };

  room.onGameStop = function () {
    window.__HB_BRIDGE__?.post("room.gameStop", {});
  };

  room.onGameTick = function () {
    state.tick++;
    if (state.traineeId == null) state.traineeId = pickTrainee(room);
    ensureTeams();
    aiTick();
  };

  room.onPlayerChat = function (player, message) {
    return handleChatCommand({ room, state, player, message });
  };
})();

