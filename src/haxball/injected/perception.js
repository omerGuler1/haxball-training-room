// Browser-only: perception layer (ball, velocity, players, trainee selection).

(function initPerception() {
  const cfg = window.__HB_CONFIG__;
  const { len } = window.__HB_MATH__;

  function isBotPlayer(p) {
    const botNames = new Set((cfg.bots?.names || []).map((s) => String(s)));
    const botAvatarPrefix = String(cfg.bots?.avatarPrefix || "");
    if (!p) return false;
    if (botNames.has(p.name)) return true;
    if (botAvatarPrefix && typeof p.avatar === "string" && p.avatar.startsWith(botAvatarPrefix)) return true;
    return false;
  }

  function pickTrainee(room) {
    const list = room.getPlayerList().filter((p) => p.id !== 0);
    const wanted = String(cfg.trainee?.nickname || "").trim();
    if (wanted) {
      const exact = list.find((p) => !isBotPlayer(p) && p.name === wanted);
      if (exact) return exact.id;
    }
    const firstHuman = list.find((p) => !isBotPlayer(p));
    return firstHuman ? firstHuman.id : null;
  }

  function getBall(room) {
    try {
      return room.getDiscProperties(0);
    } catch {
      return null;
    }
  }

  function getDisc(room, discIndex) {
    try {
      return room.getDiscProperties(discIndex);
    } catch {
      return null;
    }
  }

  function getPlayersWithDisc(room) {
    const list = room.getPlayerList().filter((p) => p.id !== 0);
    const result = [];
    for (const p of list) {
      let disc = null;
      try {
        disc = room.getPlayerDiscProperties(p.id);
      } catch {
        disc = null;
      }
      result.push({ p, disc, isBot: isBotPlayer(p) });
    }
    return result;
  }

  function estimateBallVel(prevBall, ball) {
    if (!prevBall || !ball) return { x: 0, y: 0 };
    return { x: ball.x - prevBall.x, y: ball.y - prevBall.y };
  }

  function ballSpeed(v) {
    return len(v.x, v.y);
  }

  window.__HB_PERCEPTION__ = {
    isBotPlayer,
    pickTrainee,
    getBall,
    getDisc,
    getPlayersWithDisc,
    estimateBallVel,
    ballSpeed,
  };
})();

