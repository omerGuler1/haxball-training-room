// Browser-only: adversarial 1v1 AI — always chase the ball, kick when close.

(function initDecision() {
  const { norm, dist, signAxis } = window.__HB_MATH__;

  const KICK_COOLDOWN_TICKS = 18; // ~300ms at 60fps

  /**
   * Core AI: chase the ball, kick when in control.
   * Returns { targetPos, kick, kickPower }.
   */
  function adversarialIntent(ball, ballVel, botDisc, lastKickTick, currentTick) {
    if (!ball || !botDisc) {
      return { targetPos: { x: 0, y: 0 }, kick: false, kickPower: 0 };
    }

    // Always chase: intercept with velocity lead
    const targetPos = {
      x: ball.x + ballVel.x * 2.5,
      y: ball.y + ballVel.y * 2.5,
    };

    // Kick when close enough and off cooldown
    const controlled = hasControl(ball, botDisc, ballVel);
    const offCooldown = currentTick - lastKickTick >= KICK_COOLDOWN_TICKS;
    const kick = controlled && offCooldown;

    return { targetPos, kick, kickPower: 1.0 };
  }

  function moveIntentToAxes(from, to) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const v = norm(dx, dy);
    const dead = 0.22;
    return { ax: signAxis(v.x, dead), ay: signAxis(v.y, dead) };
  }

  function hasControl(ball, selfDisc) {
    if (!ball || !selfDisc) return false;
    return dist(selfDisc, ball) < 28;
  }

  window.__HB_DECISION__ = {
    adversarialIntent,
    moveIntentToAxes,
    hasControl,
  };
})();
