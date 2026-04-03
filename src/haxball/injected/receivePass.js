// Browser-only: receive + pass logic helpers (one-touch vs settle, cooldowns).

(function initReceivePass() {
  const { len, norm, dist } = window.__HB_MATH__;

  function dot(ax, ay, bx, by) {
    return ax * bx + ay * by;
  }

  function incomingPassScore(ball, ballVel, selfDisc) {
    if (!ball || !selfDisc) return 0;
    const toSelf = { x: selfDisc.x - ball.x, y: selfDisc.y - ball.y };
    const v = norm(ballVel.x, ballVel.y);
    const w = norm(toSelf.x, toSelf.y);
    const toward = dot(v.x, v.y, w.x, w.y); // 1 means toward self
    const speed = len(ballVel.x, ballVel.y);
    const d = dist(ball, selfDisc);
    const nearEnough = d < 260 ? 1 : 0;
    return toward * speed * nearEnough;
  }

  function pickPassTarget({ trainee, otherBot, mode }) {
    // Prefer trainee; in triangle sometimes play to other bot.
    if (mode === "triangle" && otherBot && Math.random() < 0.25) return otherBot;
    return trainee;
  }

  function kickPowerForDistance(d) {
    // Approximation: longer hold for longer passes (client-side pulse duration).
    if (!Number.isFinite(d)) return 0.8;
    if (d < 120) return 0.35;
    if (d < 220) return 0.55;
    if (d < 360) return 0.75;
    return 1.0;
  }

  window.__HB_RECEIVE_PASS__ = {
    incomingPassScore,
    pickPassTarget,
    kickPowerForDistance,
  };
})();

