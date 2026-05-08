// Browser-only: 1v1 "pro" decision module — cs7632-style behavior tree port.
// Stadium-specific to v1-v2.hbs (red goal x=-411, blue goal x=+411, posts y=±70).
//
// Architecture (top-down Selector):
//   1) DEFEND_DANGER   : enemy has ball AND ball within T_DANGER of own goal → DefenderChase (smart, kicks to clear)
//   2) DEFEND_INTERCEPT: enemy has ball AND ball on our side → MoveBetweenOpponentAndGoal(pct)
//   3) ATTACK          : Sequence(Chase → Align → Shoot) with phase persistence
//
// Smart Chase / Align: uses the cross-product trick — kick is gated until the
// (bot→ball→goal-top) and (bot→ball→goal-bottom) cross products have opposite
// signs (i.e., bot is in the goal-mouth cone), and bot is on the opposite side
// of the ball from the goal so the kick pushes the ball *toward* the goal.

(function initProDecision() {
  // ── Stadium constants (v1-v2.hbs) ─────────────────────
  const RED_GOAL_TOP     = { x: -411, y: -70 };
  const RED_GOAL_BOTTOM  = { x: -411, y:  70 };
  const RED_GOAL_CENTER  = { x: -411, y:   0 };
  const BLUE_GOAL_TOP    = { x:  411, y: -70 };
  const BLUE_GOAL_BOTTOM = { x:  411, y:  70 };
  const BLUE_GOAL_CENTER = { x:  411, y:   0 };

  // ── Tunables (cs7632-derived; tweak in playtest) ──────
  const T_CHASE             = 36;   // dist threshold to attempt kick during Chase
  const T_PROXIMITY         = 10;   // axis dead-zone while moving toward ball
  const T_SHOOT             = 30;   // Shoot's chase/align dist threshold
  const T_POSSESSION        = 90;   // distance at which a player "possesses" the ball
  const T_DANGER            = 200;  // ball within this of own goal → emergency
  const T_ALIGN_Y           = 12;   // y tolerance for align "good enough"
  const KICK_INTERVAL_TICKS = 30;   // ~500ms between Chase kicks
  const ATTACK_RESET_DIST   = 100;  // bot drift > this during align/shoot → reset to chase
  const INTERCEPT_PCT       = 0.6;  // MoveBetweenOpponentAndGoal default percentage

  // ── Helpers ───────────────────────────────────────────
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function cross(a, b) { return a.x * b.y - a.y * b.x; }
  function sub(a, b)   { return { x: a.x - b.x, y: a.y - b.y }; }
  function signOf(v)   { return v > 0 ? 1 : v < 0 ? -1 : 0; }

  // ── Memory (single bot, 1v1pro mode) ──────────────────
  const memory = {
    phase: "chase",          // attack-sequence phase
    lastKickTick: -9999,
    lastResetTick: 0,
  };

  // ── Daemons (return boolean) ──────────────────────────
  function enemyHasPossession(ctx) {
    return !!ctx.opponent && dist(ctx.opponent, ctx.ball) < T_POSSESSION;
  }
  function ballOnOurSide(ctx) {
    return ctx.isRed ? ctx.ball.x < 0 : ctx.ball.x > 0;
  }
  function dangerToGoal(ctx, threshold) {
    return dist(ctx.ball, ctx.ownGoalCenter) < threshold;
  }

  // ── Action atoms ──────────────────────────────────────
  // Each returns { ax, ay, kick, status: 'success' | 'running' }
  // 'success' allows a Sequence to advance; 'running' keeps the same step.

  // Smart Chase: move toward ball; once close, kick only if (cross-product cone OK + correct x-side + cooldown).
  function chase(ctx) {
    const { bot, ball, oppGoalTop, oppGoalBottom, isRed, currentTick } = ctx;
    const d = dist(bot, ball);

    let ax = 0, ay = 0;
    if (Math.abs(bot.x - ball.x) > T_PROXIMITY) ax = bot.x < ball.x ? 1 : -1;
    if (Math.abs(bot.y - ball.y) > T_PROXIMITY) ay = bot.y < ball.y ? 1 : -1;

    if (d < T_CHASE) {
      // Cross-product cone check: signs differ → goal-mouth cone aligned with bot
      const pb = sub(bot, ball);
      const tb = sub(oppGoalTop, ball);
      const bb = sub(oppGoalBottom, ball);
      const aligned = signOf(cross(pb, tb)) !== signOf(cross(pb, bb));
      // X-side: bot must be on opposite side of ball from opp goal
      const correctSide = isRed
        ? (oppGoalTop.x > ball.x && ball.x > bot.x)
        : (oppGoalTop.x < ball.x && ball.x < bot.x);
      const offCooldown = currentTick - memory.lastKickTick > KICK_INTERVAL_TICKS;
      const kick = aligned && correctSide && offCooldown;
      if (kick) memory.lastKickTick = currentTick;
      return { ax, ay, kick, status: "success" };
    }
    return { ax, ay, kick: false, status: "running" };
  }

  // Align: position bot on opposite side of ball from opp goal (+ rough Y match), then kick
  function align(ctx) {
    const { bot, ball, oppGoalCenter, isRed } = ctx;
    let ax = 0, ay = 0;
    let aligned = true;

    if (isRed) {
      if (!(oppGoalCenter.x > ball.x && ball.x > bot.x)) {
        ax = -1; aligned = false;
      }
    } else {
      if (!(oppGoalCenter.x < ball.x && ball.x < bot.x)) {
        ax = 1; aligned = false;
      }
    }

    if (Math.abs(bot.y - ball.y) > T_ALIGN_Y) {
      ay = bot.y < ball.y ? 1 : -1;
      aligned = false;
    }

    if (aligned) return { ax: 0, ay: 0, kick: true, status: "success" };
    return { ax, ay, kick: false, status: "running" };
  }

  // Shoot: press kick + nudge toward ball if too far on either axis (cs7632 Shoot)
  function shoot(ctx) {
    const { bot, ball } = ctx;
    let ax = 0, ay = 0;
    if (Math.abs(bot.x - ball.x) > T_SHOOT) ax = bot.x < ball.x ? 1 : -1;
    if (Math.abs(bot.y - ball.y) > T_SHOOT) ay = bot.y < ball.y ? 1 : -1;
    return { ax, ay, kick: true, status: "success" };
  }

  // DefenderChase: same logic as Chase (cs7632 gates entry by danger zone — we do that at the selector level)
  function defenderChase(ctx) {
    return chase(ctx);
  }

  // Position between opponent (ball-holder) and own goal, pct of the way toward goal.
  // pct=0.6 → 60% from ball toward own goal; pct=0.75 → 75% (deeper, defensive).
  function moveBetweenOpponentAndGoal(ctx, pct) {
    const { bot, ball, ownGoalCenter, isRed } = ctx;
    let destX, destY;
    if (isRed) {
      destX = ball.x - Math.abs(ball.x - ownGoalCenter.x) * pct;
    } else {
      destX = ball.x + Math.abs(ball.x - ownGoalCenter.x) * pct;
    }
    if (ball.y > 0) {
      destY = ball.y - Math.abs(ball.y) * pct;
    } else {
      destY = ball.y + Math.abs(ball.y) * pct;
    }
    let ax = 0, ay = 0;
    if (bot.x > destX + 5)      ax = -1;
    else if (bot.x < destX - 5) ax = 1;
    if (bot.y > destY + 5)      ay = -1;
    else if (bot.y < destY - 5) ay = 1;
    return { ax, ay, kick: false, status: "success" };
  }

  // ── Attack sequence with phase persistence ────────────
  function runAttackSequence(ctx) {
    // Reality check: if we drift far from ball mid-sequence, restart at chase
    const d = dist(ctx.bot, ctx.ball);
    if (d > ATTACK_RESET_DIST && memory.phase !== "chase") {
      memory.phase = "chase";
    }

    if (memory.phase === "chase") {
      const r = chase(ctx);
      if (r.status === "success") memory.phase = "align";
      return { ...r, debugAction: "chase" };
    }
    if (memory.phase === "align") {
      const r = align(ctx);
      if (r.status === "success") memory.phase = "shoot";
      return { ...r, debugAction: "align" };
    }
    if (memory.phase === "shoot") {
      const r = shoot(ctx);
      memory.phase = "chase";
      return { ...r, debugAction: "shoot" };
    }
    memory.phase = "chase";
    return { ...chase(ctx), debugAction: "chase-fallback" };
  }

  // ── Main entry — Selector root ────────────────────────
  function proIntent(perception, currentTick) {
    const { ball, bot, opponent, botTeam } = perception;
    if (!ball || !bot) return { ax: 0, ay: 0, kick: false, kickPower: 0, debugState: "IDLE" };

    const isRed = botTeam === 1;
    const ctx = {
      ball, bot, opponent, isRed, currentTick,
      ownGoalTop:    isRed ? RED_GOAL_TOP    : BLUE_GOAL_TOP,
      ownGoalBottom: isRed ? RED_GOAL_BOTTOM : BLUE_GOAL_BOTTOM,
      ownGoalCenter: isRed ? RED_GOAL_CENTER : BLUE_GOAL_CENTER,
      oppGoalTop:    isRed ? BLUE_GOAL_TOP    : RED_GOAL_TOP,
      oppGoalBottom: isRed ? BLUE_GOAL_BOTTOM : RED_GOAL_BOTTOM,
      oppGoalCenter: isRed ? BLUE_GOAL_CENTER : RED_GOAL_CENTER,
    };

    let result, label;

    if (enemyHasPossession(ctx) && dangerToGoal(ctx, T_DANGER)) {
      result = defenderChase(ctx);
      label = "DEFEND_DANGER";
      // Reset attack phase whenever defending — fresh chase next time we attack
      memory.phase = "chase";
    } else if (enemyHasPossession(ctx) && ballOnOurSide(ctx)) {
      result = moveBetweenOpponentAndGoal(ctx, INTERCEPT_PCT);
      label = "DEFEND_INTERCEPT";
      memory.phase = "chase";
    } else {
      result = runAttackSequence(ctx);
      label = "ATTACK_" + (result.debugAction || "?").toUpperCase();
    }

    return {
      ax: result.ax,
      ay: result.ay,
      kick: !!result.kick,
      kickPower: 1.0,
      debugState: label,
    };
  }

  function resetProMemory(currentTick) {
    memory.phase = "chase";
    memory.lastKickTick = -9999;
    memory.lastResetTick = currentTick || 0;
  }

  window.__HB_PRO_DECISION__ = { proIntent, resetProMemory };
})();
