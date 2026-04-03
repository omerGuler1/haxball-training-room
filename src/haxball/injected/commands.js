// Browser-only: chat command parsing and authorization.

(function initCommands() {
  const cfg = window.__HB_CONFIG__;

  function isAuthorized(room, state, player) {
    if (!player) return false;
    if (state.traineeId && player.id === state.traineeId) return true;
    const admins = (cfg.permissions?.adminNicknames || []).map((s) => String(s));
    return admins.includes(player.name);
  }

  function reply(room, id, msg) {
    room.sendAnnouncement(msg, id, 0xdddddd, "small", 1);
  }

  function broadcast(room, msg) {
    room.sendAnnouncement(msg, null, 0xdddddd, "small", 1);
  }

  function setMode(state, room, mode, byPlayerId) {
    const m = String(mode || "").toLowerCase();
    if (!["solo", "triangle", "wall", "free"].includes(m)) {
      reply(room, byPlayerId, "Invalid mode. Use: solo, triangle, wall, free");
      return;
    }
    state.mode = m;
    broadcast(room, `Mode set to: ${m}`);
  }

  function setBots(state, room, n, byPlayerId) {
    const v = Number(n);
    if (![1, 2].includes(v)) {
      reply(room, byPlayerId, "Invalid bot count. Use: !bots 1 or !bots 2");
      return;
    }
    state.botCount = v;
    broadcast(room, `Bot count set to: ${v}`);
  }

  function handleChatCommand({ room, state, player, message }) {
    const msg = String(message || "").trim();
    if (!msg.startsWith("!")) return true;

    const [cmd, ...rest] = msg.slice(1).split(/\s+/);
    const arg = rest.join(" ");

    if (cmd === "help") {
      reply(
        room,
        player.id,
        "Commands: !help !mode <solo|triangle|wall|free> !bots <1|2> !start !stop !reset !pausebot !resumebot !botdebug <on|off> !passspeed <v> !supportdist <v> !trainee <nick> !reloadstadium !status"
      );
      return false;
    }

    if (!isAuthorized(room, state, player)) {
      reply(room, player.id, "Not authorized.");
      return false;
    }

    if (cmd === "mode") setMode(state, room, rest[0], player.id);
    else if (cmd === "bots") setBots(state, room, rest[0], player.id);
    else if (cmd === "start") room.startGame();
    else if (cmd === "stop") room.stopGame();
    else if (cmd === "reset") room.stopGame(), setTimeout(() => room.startGame(), 250);
    else if (cmd === "pausebot") (state.pausedBot = true), broadcast(room, "Bots paused.");
    else if (cmd === "resumebot") (state.pausedBot = false), broadcast(room, "Bots resumed.");
    else if (cmd === "botdebug") {
      const v = (rest[0] || "").toLowerCase();
      state.debug = v === "on" ? true : v === "off" ? false : state.debug;
      broadcast(room, `Bot debug: ${state.debug ? "on" : "off"}`);
    } else if (cmd === "passspeed") {
      const v = Number(rest[0]);
      if (!Number.isFinite(v) || v < 0.2 || v > 2.5) reply(room, player.id, "passspeed range: 0.2..2.5");
      else (state.passSpeed = v), broadcast(room, `passspeed set to ${v}`);
    } else if (cmd === "supportdist") {
      const v = Number(rest[0]);
      if (!Number.isFinite(v) || v < 80 || v > 420) reply(room, player.id, "supportdist range: 80..420");
      else (state.supportDist = v), broadcast(room, `supportdist set to ${v}`);
    } else if (cmd === "trainee") {
      const nick = arg.trim();
      if (!nick) reply(room, player.id, "Usage: !trainee <nickname>");
      else {
        state.traineeId = null;
        cfg.trainee.nickname = nick;
        broadcast(room, `Trainee set to: ${nick}`);
      }
    } else if (cmd === "reloadstadium") {
      window.__HB_BRIDGE__?.post("stadium.reload", {});
    } else if (cmd === "status") {
      const trainee = state.traineeId ? room.getPlayer(state.traineeId) : null;
      reply(
        room,
        player.id,
        `mode=${state.mode} bots=${state.botCount} trainee=${trainee ? trainee.name : "none"} debug=${state.debug ? "on" : "off"}`
      );
    } else {
      reply(room, player.id, "Unknown command. Use !help");
    }

    return false;
  }

  window.__HB_COMMANDS__ = { handleChatCommand, broadcast, reply };
})();

