// Browser-only: 1v1 "nn" decision module — HaxAI SP_V16 inference port.
// PPO policy with MultiDiscrete([3, 3, 2]) action space:
//   13-dim obs → tanh(W0·obs+B0) → tanh(W1·h+B1) → W2·h+B2 → logits(8)
// Weights are loaded by host.js into window.__HB_NN_WEIGHTS__ from NN_WEIGHTS_PATH.
//
// Action segment mapping:
//   ax ∈ {0,1,2}  → moveX: -1 / 0 / +1 (mirrored if bot is on blue team)
//   ay ∈ {0,1,2}  → moveY: -1 / 0 / +1
//   kick ∈ {0,1}  → kick: false / true
//
// Inference cadence: every 4 ticks (matches HaxAI play.py — 15Hz at 60Hz physics).

(function initNnDecision() {
  // ── HaxAI training-sim constants (engine.py / config.py) ──
  // Observation normalization uses these *training* bounds, not v1-v2 bounds.
  // Keeping them aligned with training so the model sees in-distribution values.
  const FIELD_W = 368;
  const FIELD_H = 171;
  const MAX_VEL = 15.0;
  const FW2 = FIELD_W * 2;
  const FH2 = FIELD_H * 2;

  // canKick approximation: in training sim kick fires within
  // player_radius(15) + ball_radius(5.5) + KICK_OFF(10) = 30.5 units.
  // We don't track real Haxball's kick-armed state; proximity is a reasonable proxy.
  const KICK_RANGE_APPROX = 35;

  const INFERENCE_INTERVAL = 4;

  // ── Weight handles (lazy-loaded from window.__HB_NN_WEIGHTS__) ──
  let W0, B0, W1, B1, W2, B2;
  let weightsLoaded = false;

  function tryLoadWeights() {
    const w = window.__HB_NN_WEIGHTS__;
    if (!w || !w.w0 || !w.b0 || !w.w1 || !w.b1 || !w.w2 || !w.b2) return false;
    W0 = w.w0; B0 = w.b0;
    W1 = w.w1; B1 = w.b1;
    W2 = w.w2; B2 = w.b2;
    weightsLoaded = true;
    return true;
  }

  // ── Pure JS inference (no libs) ──────────────────────
  function matVec(M, v) {
    const rows = M.length, out = new Array(rows);
    for (let i = 0; i < rows; i++) {
      let s = 0;
      const row = M[i];
      const cols = row.length;
      for (let j = 0; j < cols; j++) s += row[j] * v[j];
      out[i] = s;
    }
    return out;
  }
  function addBiasInPlace(v, b) {
    for (let i = 0; i < v.length; i++) v[i] += b[i];
    return v;
  }
  function tanhInPlace(v) {
    for (let i = 0; i < v.length; i++) v[i] = Math.tanh(v[i]);
    return v;
  }
  function argmaxRange(arr, start, end) {
    let bi = start;
    for (let i = start + 1; i < end; i++) if (arr[i] > arr[bi]) bi = i;
    return bi - start;
  }

  function policyInfer(obs) {
    const h1 = tanhInPlace(addBiasInPlace(matVec(W0, obs),  B0));
    const h2 = tanhInPlace(addBiasInPlace(matVec(W1, h1), B1));
    const lg = addBiasInPlace(matVec(W2, h2), B2);
    return [
      argmaxRange(lg, 0, 3),  // ax
      argmaxRange(lg, 3, 6),  // ay
      argmaxRange(lg, 6, 8),  // kick
    ];
  }

  // ── Observation builder — mirror of selfplay_env._get_obs() ──
  function nc(v, m) { return Math.max(-1, Math.min(1, v / m)); }

  function buildObs(perception) {
    const { ball, ballVel, bot, botVel, opponent, oppVel, botTeam } = perception;
    const dm = botTeam === 1 ? 1 : -1;          // dir_mult — flips for p2 (blue)
    const goalX = FIELD_W * dm;                  // own bot's target goal x in training-sim space
    const dx = ball.x - bot.x, dy = ball.y - bot.y;
    const distToBall = Math.hypot(dx, dy);
    const canKickFlag = distToBall < KICK_RANGE_APPROX ? 1.0 : -1.0;

    return [
      nc(botVel.x * dm,         MAX_VEL),
      nc(botVel.y,              MAX_VEL),
      nc(dx * dm,               FW2),
      nc(dy,                    FH2),
      nc(ballVel.x * dm,        MAX_VEL),
      nc(ballVel.y,             MAX_VEL),
      nc((goalX - bot.x) * dm,  FW2),
      nc(0 - bot.y,             FH2),
      canKickFlag,
      nc((opponent.x - bot.x) * dm, FW2),
      nc(opponent.y - bot.y,        FH2),
      nc(oppVel.x * dm,             MAX_VEL),
      nc(oppVel.y,                  MAX_VEL),
    ];
  }

  // ── Main entry ────────────────────────────────────────
  const memory = {
    lastAction: [1, 1, 0],   // [ax_idx, ay_idx, kick_idx] — defaults: idle
    lastInferenceTick: -INFERENCE_INTERVAL,
  };

  function nnIntent(perception, currentTick) {
    if (!weightsLoaded && !tryLoadWeights()) {
      return { ax: 0, ay: 0, kick: false, kickPower: 0, debugState: "NN_NO_WEIGHTS" };
    }
    if (!perception.ball || !perception.bot || !perception.opponent) {
      return { ax: 0, ay: 0, kick: false, kickPower: 0, debugState: "NN_WAIT" };
    }

    if (currentTick - memory.lastInferenceTick >= INFERENCE_INTERVAL) {
      try {
        const obs = buildObs(perception);
        memory.lastAction = policyInfer(obs);
        memory.lastInferenceTick = currentTick;
      } catch (e) {
        // Degrade gracefully on any inference error
        memory.lastAction = [1, 1, 0];
      }
    }

    const [ax_i, ay_i, k_i] = memory.lastAction;
    let ax = ax_i === 0 ? -1 : ax_i === 2 ? 1 : 0;
    let ay = ay_i === 0 ? -1 : ay_i === 2 ? 1 : 0;
    if (perception.botTeam === 2) ax = -ax;   // mirror x for blue (POV symmetry)

    return {
      ax, ay,
      kick: k_i === 1,
      kickPower: 1.0,
      debugState: "NN_" + ax_i + "" + ay_i + "" + k_i,
    };
  }

  function resetNnMemory() {
    memory.lastAction = [1, 1, 0];
    memory.lastInferenceTick = -INFERENCE_INTERVAL;
  }

  window.__HB_NN_DECISION__ = { nnIntent, resetNnMemory };
})();
