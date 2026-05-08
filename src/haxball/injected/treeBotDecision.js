// Browser-only: rule-based "ProBot" decision module — port of the user's intuitive
// decision tree (originally implemented in Python: hb_train/src/env/opponents.py
// ProBotOpponent). Used by DECISION_PROFILE=probot.
//
// Decision tree:
//  A. Top bizdeyse:
//     A1. Kaleye yol açık mı?
//         açık + opp_half     → hizala + şut
//         açık + own_half     → top+bot'u opp half'a taşı
//         kapalı + opp <100   → duvardan dolaş
//         kapalı + opp uzak   → kaleye yaklaş + jitter
//  B. Top bizde değilse:
//     B.a. Rakipte top:
//          own_half  → 75% defansif hatta
//          opp_half  → hafif açılı yaklaş
//     B.b. Loose ball:
//          opp yakın + retreat → kale ortasına
//          opp yakın + normal  → kovala
//          biz yakın + opp<200 + retreat → kovala + clear-kick
//          biz yakın + opp<200 + normal  → kovala + spam kick
//          biz yakın + opp uzak → topu al, opp half'a yönlendir

(function initTreeBotDecision() {
  // ── Stadium constants (haxv1-v2.hbs) ─────────────────
  const FIELD_W = 373.8;     // goal x
  const FIELD_H = 170;
  const GOAL_HALF_H = 63;

  // ── Tree thresholds (mirror of Python ProBot) ────────
  const POSSESSION_DIST    = 35;
  const OPP_NEAR           = 100;
  const OPP_DANGER         = 200;
  const PATH_CLEAR_PERP    = 35;
  const DEFENSIVE_LINE_PCT = 0.75;
  const APPROACH_ANGLE_OFF = 25;
  const DEAD_ZONE          = 0.22;
  const KICK_COOLDOWN_TICKS = 30;     // selective kick cooldown (~500ms)
  const LEAD_TICKS         = 2.5;     // velocity-lead for chase

  const memory = { lastKickTick: -9999 };

  // ── Helpers ──────────────────────────────────────────
  function perpToSeg(p, a, b) {
    const vx = b.x - a.x, vy = b.y - a.y;
    const wx = p.x - a.x, wy = p.y - a.y;
    const L2 = vx * vx + vy * vy;
    if (L2 < 1e-6) return Math.hypot(wx, wy);
    let t = (wx * vx + wy * vy) / L2;
    t = Math.max(0, Math.min(1, t));
    const cx = a.x + t * vx, cy = a.y + t * vy;
    return Math.hypot(p.x - cx, p.y - cy);
  }

  function targetToAxes(bot, targetX, targetY) {
    const dx = targetX - bot.x;
    const dy = targetY - bot.y;
    const mag = Math.hypot(dx, dy);
    if (mag < 1e-6) return { ax: 0, ay: 0 };
    const nx = dx / mag, ny = dy / mag;
    const ax = Math.abs(nx) < DEAD_ZONE ? 0 : (nx > 0 ? 1 : -1);
    const ay = Math.abs(ny) < DEAD_ZONE ? 0 : (ny > 0 ? 1 : -1);
    return { ax, ay };
  }

  // ── Main decision ────────────────────────────────────
  function treeBotIntent(perception, currentTick) {
    const { ball, ballVel, bot, opponent, botTeam } = perception;
    if (!ball || !bot || !opponent) {
      return { ax: 0, ay: 0, kick: false, kickPower: 0, debugState: "IDLE" };
    }

    // Team-aware orientation: red attacks +x, blue attacks -x.
    const isRed   = botTeam === 1;
    const dirSign = isRed ? 1 : -1;
    const ownGoalX = isRed ? -FIELD_W : FIELD_W;
    const oppGoalX = isRed ?  FIELD_W : -FIELD_W;

    // Forward-relative position (used so logic reads naturally in absolute coords)
    const botFwd  = bot.x  * dirSign;
    const ballFwd = ball.x * dirSign;

    const ballToBot = { x: bot.x - ball.x, y: bot.y - ball.y };
    const botToBall = Math.hypot(ballToBot.x, ballToBot.y);
    const oppToBall = Math.hypot(opponent.x - ball.x, opponent.y - ball.y);
    const botToOpp  = Math.hypot(opponent.x - bot.x, opponent.y - bot.y);

    const weHave  = botToBall < POSSESSION_DIST;
    const oppHas  = oppToBall < POSSESSION_DIST;

    const ballInOppHalf = ballFwd > 0;
    const ballInOwnHalf = ballFwd < 0;
    const botInOwnHalf  = botFwd  < 0;

    let targetX = bot.x, targetY = bot.y;
    let kick = false;
    let label = "";

    // ── DURUM A: top bizde ───────────────────────────
    if (weHave) {
      const oppGoalP = { x: oppGoalX, y: 0 };
      const perp = perpToSeg(opponent, ball, oppGoalP);
      const pathClear = perp > PATH_CLEAR_PERP;

      if (pathClear) {
        if (ballInOppHalf) {
          // A1.evet.opp_half: hizala + şut
          targetX = ball.x + dirSign * 30;
          targetY = 0;
          kick = (currentTick - memory.lastKickTick > KICK_COOLDOWN_TICKS);
          label = "A_SHOOT";
        } else {
          // A1.evet.own_half: top+bot'u opp half'a taşı
          targetX = ball.x + dirSign * 80;
          targetY = ball.y * 0.6;
          label = "A_PUSH";
        }
      } else {
        if (botToOpp < OPP_NEAR) {
          // A1.hayır.opp_yakın: duvardan dolaş
          const wallY = opponent.y > 0 ? -FIELD_H * 0.7 : FIELD_H * 0.7;
          targetX = ball.x + dirSign * 40;
          targetY = wallY;
          label = "A_WALL";
        } else {
          // A1.hayır.opp_uzak: kaleye yaklaş + jitter
          const jitter = (Math.random() - 0.5) * 40;
          targetX = ball.x + dirSign * 70;
          targetY = ball.y + jitter;
          label = "A_NUDGE";
        }
      }
    }
    // ── DURUM B.a: rakipte top ───────────────────────
    else if (oppHas) {
      if (botInOwnHalf || ballInOwnHalf) {
        // B.a.own_half: 75% defansif hat
        targetX = ownGoalX + (ball.x - ownGoalX) * DEFENSIVE_LINE_PCT;
        targetY = ball.y * DEFENSIVE_LINE_PCT;
        label = "Ba_DEFEND";
      } else {
        // B.a.opp_half: hafif açılı yaklaş
        const yOffset = ball.y >= 0 ? APPROACH_ANGLE_OFF : -APPROACH_ANGLE_OFF;
        targetX = ball.x - dirSign * 20;
        targetY = ball.y + yOffset;
        label = "Ba_ANGLE";
      }
    }
    // ── DURUM B.b: loose ball ────────────────────────
    else {
      const weCloser   = botToBall < oppToBall;
      const needRetreat = ballFwd < botFwd;  // top bot'un arkasında (own goal yönünde)

      if (!weCloser) {
        if (needRetreat) {
          targetX = ownGoalX + dirSign * 35;
          targetY = 0;
          label = "Bb_GOAL_CENTER";
        } else {
          targetX = ball.x + ballVel.x * LEAD_TICKS;
          targetY = ball.y + ballVel.y * LEAD_TICKS;
          label = "Bb_CHASE";
        }
      } else {
        if (botToOpp < OPP_DANGER) {
          if (needRetreat) {
            // chase + clear (kick when behind ball relative to forward)
            targetX = ball.x + ballVel.x * LEAD_TICKS;
            targetY = ball.y + ballVel.y * LEAD_TICKS;
            const alignedClear = ballFwd > botFwd;
            kick = alignedClear && (currentTick - memory.lastKickTick > KICK_COOLDOWN_TICKS);
            label = "Bb_CLEAR";
          } else {
            // spam kick
            targetX = ball.x + ballVel.x * LEAD_TICKS;
            targetY = ball.y + ballVel.y * LEAD_TICKS;
            kick = true;  // no cooldown — spam
            label = "Bb_SPAM";
          }
        } else {
          // possess + push forward
          targetX = ball.x + ballVel.x * LEAD_TICKS;
          targetY = ball.y + ballVel.y * LEAD_TICKS;
          label = "Bb_POSSESS";
        }
      }
    }

    if (kick) memory.lastKickTick = currentTick;

    const axes = targetToAxes(bot, targetX, targetY);
    return {
      ax: axes.ax,
      ay: axes.ay,
      kick,
      kickPower: 1.0,
      debugState: label,
    };
  }

  function resetTreeBotMemory() {
    memory.lastKickTick = -9999;
  }

  window.__HB_TREEBOT_DECISION__ = { treeBotIntent, resetTreeBotMemory };
})();
