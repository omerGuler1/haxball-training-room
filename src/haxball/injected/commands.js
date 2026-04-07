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
      // ── Un-AFK ─────────────────────────────────────
      state.afkIds = state.afkIds.filter((x) => x !== id);
      broadcast(room, player.name + " is back!");

      const traineeId = cfg.training?.traineeTeamId === 1 ? 1 : 2;

      if (lifecycle?.isSquaresMode) {
        // Squares: try to assign to a free court
        const court = lifecycle.assignHumanToCourt(id);
        if (court) {
          room.setPlayerTeam(id, traineeId);
          broadcast(room, player.name + " → " + court.name + " kare!");
          if (room.getScores() != null) {
            setTimeout(() => {
              try { room.setPlayerDiscProperties(id, { x: court.humanSpawnX, y: 0 }); } catch {}
            }, 200);
          } else {
            // No game running — start it now
            lifecycle.squaresStartGameIfReady?.();
          }
        } else {
          // All courts full — queue
          if (!state.queuedHumanIds.includes(id)) {
            state.queuedHumanIds.push(id);
            room.sendAnnouncement("Tum kareler dolu. Sirada #" + state.queuedHumanIds.length + " bekle.", id, 0xdddddd, "small", 1);
          }
        }
      } else if (lifecycle?.isAllMode) {
        // All mode: put player back on team
        room.setPlayerTeam(id, traineeId);
        if (!state.activeHumanId) state.activeHumanId = id;
        if (state.matchState === "WAITING") {
          lifecycle?.startNewMatch();
        }
      } else if (!state.activeHumanId) {
        // 1v1: no active player — take the slot and start
        state.activeHumanId = id;
        lifecycle?.startNewMatch();
      } else if (!state.queuedHumanIds.includes(id)) {
        state.queuedHumanIds.push(id);
        room.sendAnnouncement("You are #" + state.queuedHumanIds.length + " in queue.", id, 0xdddddd, "small", 1);
      }
    } else {
      // ── Go AFK ─────────────────────────────────────
      state.afkIds.push(id);
      state.queuedHumanIds = state.queuedHumanIds.filter((x) => x !== id);
      room.setPlayerTeam(id, 0);
      broadcast(room, player.name + " is now AFK.");

      if (lifecycle?.isSquaresMode) {
        // Squares: free their court, promote queued player into it
        const court = lifecycle.getCourtByHumanId(id);
        if (court) {
          court.humanId = null;
          // Find next queued non-AFK player
          while (state.queuedHumanIds.length > 0) {
            const nextId = state.queuedHumanIds.shift();
            const np = room.getPlayer(nextId);
            if (!np || state.afkIds.includes(nextId)) continue;
            court.humanId = nextId;
            room.setPlayerTeam(nextId, cfg.training?.traineeTeamId === 1 ? 1 : 2);
            broadcast(room, np.name + " → " + court.name + " kare!");
            if (room.getScores() != null) {
              setTimeout(() => {
                try { room.setPlayerDiscProperties(nextId, { x: court.humanSpawnX, y: 0 }); } catch {}
              }, 200);
            }
            break;
          }
          // If no humans left on any court, stop game
          if (!lifecycle.squaresHasHumans() && room.getScores() != null) {
            try { room.stopGame(); } catch {}
          }
        }
      } else if (lifecycle?.isAllMode) {
        // All mode: pick another non-AFK human as activeHumanId
        const remaining = state.humanIds.filter((x) => !state.afkIds.includes(x) && room.getPlayer(x));
        if (remaining.length === 0) {
          state.activeHumanId = null;
          const isGameRunning = state.matchState === "PLAYING" || state.matchState === "GOAL_SCORED" || state.matchState === "MATCH_OVER";
          if (isGameRunning) {
            try { room.stopGame(); } catch {}
          }
        } else if (state.activeHumanId === id) {
          state.activeHumanId = remaining[0];
        }
      } else if (state.activeHumanId === id) {
        state.activeHumanId = null;
        const isGameRunning = state.matchState === "PLAYING" || state.matchState === "GOAL_SCORED" || state.matchState === "MATCH_OVER";
        if (isGameRunning) {
          try { room.stopGame(); } catch {}
        }
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

    if (cmd === "kick" || cmd === "ban") {
      const admins = (cfg.permissions?.adminNicknames || []).map((s) => String(s));
      if (!admins.includes(player.name)) {
        reply(room, player.id, "Sadece adminler kullanabilir.");
        return false;
      }
      const arg = (rest[0] || "").trim();
      if (!arg) {
        reply(room, player.id, "Kullanim: !kick <id veya isim>  (!players ile id'leri gor)");
        return false;
      }
      const list = room.getPlayerList().filter((p) => p.id !== 0);
      const numId = Number(arg);
      let target = Number.isFinite(numId) ? list.find((p) => p.id === numId) : null;
      if (!target) target = list.find((p) => p.name.toLowerCase() === arg.toLowerCase());
      if (!target) target = list.find((p) => p.name.toLowerCase().includes(arg.toLowerCase()));
      if (!target) { reply(room, player.id, "Oyuncu bulunamadi: " + arg); return false; }
      try { room.kickPlayer(target.id, "Kicked by " + player.name, cmd === "ban"); } catch {}
      return false;
    }
    if (cmd === "players" || cmd === "list") {
      const list = room.getPlayerList().filter((p) => p.id !== 0);
      const text = list.map((p) => "#" + p.id + " " + p.name + (p.team === 0 ? " (spec)" : "")).join(", ");
      reply(room, player.id, text || "(empty)");
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
