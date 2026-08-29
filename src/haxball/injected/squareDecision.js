// Browser-only: single-agent square-room ball-control decision (Task A: same-wall rally).
// Used by DECISION_PROFILE=square on a single-square stadium (1square_ok.hbs), origin-centered.
// Default = scripted teacher (ported verbatim from tools/square_teacher.mjs taskA_teacher); if a
// 17-input NN model is loaded into window.__HB_NN_WEIGHTS__, runs that policy on the 17-dim obsSquare.
//
// Physics (1square_ok.hbs): walls at x=±202.238, y=±150; ball kick ~4.55; kick range center ≤28;
// contact gap 25; bot terminal speed ~2.6 (slower than a kicked ball → control via dribble + anchored
// receiver: wait at a fixed x, re-kick the returning ball into the wall, anti-drift aim keeps it level).
(function initSquareDecision() {
  const SX = 202.238, SY = 150, MV = 15, KS = 7.17, CONTACT = 21.4;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  // ── SOLID dribble-control (Task A) → MD332 action [mx,my,kk] ──
  // The user's choice: NEVER lose the ball. The bot shepherds the ball to the RIGHT wall and keeps it
  // glued at the ~21px contact gap (body-dribble → perfect possession). It positions on the far side of
  // the ball from the rally target (right wall, pulled toward center y) so contact dribbles the ball
  // there and gently taps it off the wall. NO hard kick — a ~7.2 kick would fling this fast ball away
  // (the "tek vuruşta kaçırma" failure). Pure position control → smooth, decisive, and lag-robust.
  function taskA(bot, ball) {
    const targetX = 186, targetY = clamp(ball.y * 0.6, -75, 75);        // drive to wall, recenter in y
    let ux = targetX - ball.x, uy = targetY - ball.y; const L = Math.hypot(ux, uy) || 1; ux /= L; uy /= L;
    const tx = Math.min(ball.x - ux * 19, 178), ty = ball.y - uy * 19;  // sit behind the ball on the push line
    let mx = 1, my = 1; const ex = tx - bot.x, ey = ty - bot.y;
    if (ex > 2 && bot.x < 178) mx = 2; else if (ex < -2) mx = 0;
    if (ey > 2) my = 2; else if (ey < -2) my = 0;
    return [mx, my, 0];
  }

  // ── 17-dim square obs (matches tools/square_teacher.mjs obsSquare / rollout_square.mjs) ──
  function obsSquare(bot, ball, prevBV, krmin) {
    const nc = (v, m) => clamp(v / m, -1, 1);
    return [
      nc(bot.vx, MV), nc(bot.vy, MV),
      nc(ball.x - bot.x, 2 * SX), nc(ball.y - bot.y, 2 * SY),
      nc(ball.vx, MV), nc(ball.vy, MV),
      nc(ball.vx - prevBV.x, MV), nc(ball.vy - prevBV.y, MV),
      (bot.x + SX) / (2 * SX), (SX - bot.x) / (2 * SX), (bot.y + SY) / (2 * SY), (SY - bot.y) / (2 * SY),
      (ball.x + SX) / (2 * SX), (SX - ball.x) / (2 * SX), (ball.y + SY) / (2 * SY), (SY - ball.y) / (2 * SY),
      nc(krmin || 0, 20),
    ];
  }
  // MLP forward (tanh hidden, linear out), weights {w0,b0,w1,b1,...}; heads [0,3)[3,6)[6,8) argmax.
  function nnAction(W, x) {
    let a = x;
    for (let L = 0; W["w" + L]; L++) {
      const w = W["w" + L], b = W["b" + L], last = !W["w" + (L + 1)], out = new Array(w.length);
      for (let i = 0; i < w.length; i++) {
        let s = b[i]; const row = w[i];
        for (let j = 0; j < row.length; j++) s += row[j] * a[j];
        out[i] = last ? s : Math.tanh(s);
      }
      a = out;
    }
    const am = (lo, hi) => { let bi = lo, bv = a[lo]; for (let i = lo + 1; i < hi; i++) if (a[i] > bv) { bv = a[i]; bi = i; } return bi - lo; };
    return [am(0, 3), am(3, 6), am(6, 8)];
  }
  // ── 23-dim KEEP-AWAY obs (matches tools/square_teacher.mjs obsKeepaway): obsSquare + opponent info ──
  function obsKeepaway(bot, ball, opp, prevBV, krmin) {
    const nc = (v, m) => clamp(v / m, -1, 1);
    return [
      ...obsSquare(bot, ball, prevBV, krmin),
      nc(opp.x - bot.x, 2 * SX), nc(opp.y - bot.y, 2 * SY),
      nc(opp.x - ball.x, 2 * SX), nc(opp.y - ball.y, 2 * SY),
      nc(opp.vx, MV), nc(opp.vy, MV),
    ];
  }
  function has17(W) { return W && Array.isArray(W.w0) && W.w0[0] && W.w0[0].length === 17; }
  function has23(W) { return W && Array.isArray(W.w0) && W.w0[0] && W.w0[0].length === 23; }

  let prevBV = { x: 0, y: 0 };
  // perception passes {bot, ball, opp?, krmin?}. 23-dim weights → keep-away (needs opp; if none, a far
  // placeholder so it falls back to wall play). 17-dim → wall obs. Else scripted. Returns {ax,ay,kick,...}.
  function squareIntent(p, _tick) {
    const { bot, ball } = p;
    const W = window.__HB_NN_WEIGHTS__;
    let act;
    if (has23(W)) {
      const opp = p.opp || { x: bot.x + 9999, y: bot.y, vx: 0, vy: 0 };   // no opponent → "far" → wall play
      act = nnAction(W, obsKeepaway(bot, ball, opp, prevBV, p.krmin || 0));
    } else if (has17(W)) {
      act = nnAction(W, obsSquare(bot, ball, prevBV, p.krmin || 0));
    } else {
      act = taskA(bot, ball);
    }
    prevBV = { x: ball.vx, y: ball.vy };
    return { ax: act[0] - 1, ay: act[1] - 1, kick: act[2] === 1, kickPower: 0.2 };
  }

  window.__HB_SQUARE_DECISION__ = {
    squareIntent,
    mode: () => { const W = window.__HB_NN_WEIGHTS__; return has23(W) ? "keepaway23" : has17(W) ? "nn17" : "scripted"; },
  };
})();
