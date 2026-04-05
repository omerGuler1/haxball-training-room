// Browser-only: chat command parsing and authorization for 1v1 mode.

(function initCommands() {
  const cfg = window.__HB_CONFIG__;

  function isAuthorized(room, state, player) {
    if (!player) return false;
    if (state.activeHumanId && player.id === state.activeHumanId) return true;
    const admins = (cfg.permissions?.adminNicknames || []).map((s) => String(s));
    return admins.includes(player.name);
  }

  function reply(room, id, msg) {
    room.sendAnnouncement(msg, id, 0xdddddd, "small", 1);
  }

  function broadcast(room, msg) {
    room.sendAnnouncement(msg, null, 0xdddddd, "small", 1);
  }

  function handleAfk(room, state, player) {
    const id = player.id;
    const isAfk = state.afkIds.includes(id);
    const lifecycle = window.__HB_LIFECYCLE__;

    if (isAfk) {
      // Un-AFK: remove from afkIds, add to queue (or make active)
      state.afkIds = state.afkIds.filter((x) => x !== id);
      broadcast(room, player.name + " is back!");

      if (!state.activeHumanId && state.matchState === "WAITING") {
        state.activeHumanId = id;
        lifecycle?.startNewMatch();
      } else if (!state.queuedHumanIds.includes(id)) {
        state.queuedHumanIds.push(id);
        room.sendAnnouncement("You are #" + state.queuedHumanIds.length + " in queue.", id, 0xdddddd, "small", 1);
      }
    } else {
      // Go AFK: add to afkIds, remove from queue, move to spec
      state.afkIds.push(id);
      state.queuedHumanIds = state.queuedHumanIds.filter((x) => x !== id);
      room.setPlayerTeam(id, 0);
      broadcast(room, player.name + " is now AFK.");

      if (state.activeHumanId === id) {
        // Active player going AFK — stop match via lifecycle, promote next
        state.activeHumanId = null;
        const isGameRunning = state.matchState === "PLAYING" || state.matchState === "GOAL_SCORED" || state.matchState === "MATCH_OVER";
        if (isGameRunning) {
          try { room.stopGame(); } catch {}
        }
        // promoteNextHuman uses scheduleGuarded internally via startNewMatch,
        // so we call it directly — the transitionTo inside will invalidate any stale timeouts.
        lifecycle?.promoteNextHuman();
      }
    }
  }

  function handleChatCommand({ room, state, player, message }) {
    const msg = String(message || "").trim();
    if (!msg.startsWith("!")) return true;

    const [cmd, ...rest] = msg.slice(1).split(/\s+/);

    if (cmd === "help") {
      reply(
        room,
        player.id,
        "Commands: !help !kayit <sifre> !giris <sifre> !bagla !profil !afk !start !stop !reset !status"
      );
      return false;
    }

    // ── Auth commands (no auth needed, available to everyone) ──

    if (cmd === "kayit" || cmd === "kayıt") {
      const password = rest.join(" ").trim();
      if (!password || password.length < 4) {
        reply(room, player.id, "Kullanim: !kayit <sifre> (en az 4 karakter)");
        return false;
      }
      window.__HB_BRIDGE__?.post("auth.register", {
        playerId: player.id,
        playerName: player.name,
        password: password,
      });
      return false;
    }

    if (cmd === "giris" || cmd === "giriş" || cmd === "giris") {
      const password = rest.join(" ").trim();
      if (!password) {
        reply(room, player.id, "Kullanim: !giris <sifre>");
        return false;
      }
      window.__HB_BRIDGE__?.post("auth.login", {
        playerId: player.id,
        playerName: player.name,
        password: password,
      });
      return false;
    }

    if (cmd === "bagla" || cmd === "bağla") {
      window.__HB_BRIDGE__?.post("auth.createLinkCode", {
        playerId: player.id,
        playerName: player.name,
      });
      return false;
    }

    if (cmd === "profil") {
      window.__HB_BRIDGE__?.post("auth.profile", {
        playerId: player.id,
        playerName: player.name,
      });
      return false;
    }

    // !afk is available to everyone (no auth needed)
    if (cmd === "afk") {
      handleAfk(room, state, player);
      return false;
    }

    if (!isAuthorized(room, state, player)) {
      reply(room, player.id, "Not authorized.");
      return false;
    }

    if (cmd === "start") room.startGame();
    else if (cmd === "stop") room.stopGame();
    else if (cmd === "reset") room.stopGame(), setTimeout(() => room.startGame(), 250);
    else if (cmd === "pausebot") (state.pausedBot = true), broadcast(room, "Bot paused.");
    else if (cmd === "resumebot") (state.pausedBot = false), broadcast(room, "Bot resumed.");
    else if (cmd === "botdebug") {
      const v = (rest[0] || "").toLowerCase();
      state.debug = v === "on" ? true : v === "off" ? false : state.debug;
      broadcast(room, "Bot debug: " + (state.debug ? "on" : "off"));
    } else if (cmd === "reloadstadium") {
      window.__HB_BRIDGE__?.post("stadium.reload", {});
    } else if (cmd === "status") {
      const human = state.activeHumanId ? room.getPlayer(state.activeHumanId) : null;
      const humanScore = state.matchScore ? (cfg.training?.traineeTeamId === 1 ? state.matchScore.red : state.matchScore.blue) : 0;
      const botScore = state.matchScore ? (cfg.training?.botTeamId === 1 ? state.matchScore.red : state.matchScore.blue) : 0;
      reply(
        room,
        player.id,
        "state=" + state.matchState + " score=" + humanScore + "-" + botScore +
        " player=" + (human ? human.name : "none") +
        " queue=" + state.queuedHumanIds.length +
        " debug=" + (state.debug ? "on" : "off")
      );
    } else {
      reply(room, player.id, "Unknown command. Use !help");
    }

    return false;
  }

  window.__HB_COMMANDS__ = { handleChatCommand, broadcast, reply };
})();
