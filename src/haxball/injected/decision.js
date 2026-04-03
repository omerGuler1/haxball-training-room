// Browser-only: decision layer (roles, support spots, kick heuristics).

(function initDecision() {
  const { len, norm, signAxis, dist } = window.__HB_MATH__;

  function chooseChaser(ball, traineeDisc, bots) {
    if (!ball) return null;
    const scored = bots
      .filter((b) => b.disc)
      .map((b) => ({ id: b.p.id, d: len(b.disc.x - ball.x, b.disc.y - ball.y) }))
      .sort((a, b) => a.d - b.d);
    if (scored.length === 0) return null;

    if (traineeDisc) {
      const traineeD = len(traineeDisc.x - ball.x, traineeDisc.y - ball.y);
      if (traineeD + 35 < scored[0].d) return null; // trainee claims if clearly closer
    }
    return scored[0].id;
  }

  function supportSpot(ball, traineeDisc, side, distForward, lateral) {
    const center = { x: 0, y: 0 };
    if (!traineeDisc) return center;
    const toBall = ball ? { x: ball.x - traineeDisc.x, y: ball.y - traineeDisc.y } : { x: 1, y: 0 };
    const dir = norm(toBall.x, toBall.y);
    const px = -dir.y * side;
    const py = dir.x * side;
    return {
      x: traineeDisc.x + dir.x * distForward + px * lateral,
      y: traineeDisc.y + dir.y * distForward + py * lateral,
    };
  }

  function moveIntentToAxes(from, to) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const v = norm(dx, dy);
    const dead = 0.22;
    return { ax: signAxis(v.x, dead), ay: signAxis(v.y, dead) };
  }

  function hasControl(ball, selfDisc, ballVel) {
    if (!ball || !selfDisc) return false;
    const dBall = dist(selfDisc, ball);
    const close = dBall < 22;
    const speed = len(ballVel.x, ballVel.y);
    return close && speed < 7.5;
  }

  function shouldKickToTarget(ball, selfDisc, targetDisc, ballVel) {
    if (!ball || !selfDisc || !targetDisc) return false;
    if (!hasControl(ball, selfDisc, ballVel)) return false;
    const d = dist(selfDisc, targetDisc);
    if (d < 80) return false;
    return true;
  }

  window.__HB_DECISION__ = {
    chooseChaser,
    supportSpot,
    moveIntentToAxes,
    hasControl,
    shouldKickToTarget,
  };
})();

