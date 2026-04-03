// Browser-only: shared mutable state for training logic.

(function initState() {
  const cfg = window.__HB_CONFIG__;
  const { clamp } = window.__HB_MATH__;

  const state = {
    tick: 0,

    traineeId: null,
    mode: cfg.training?.defaultMode || "triangle",
    botCount: clamp(Number(cfg.bots?.count || 2), 0, 2),
    pausedBot: false,

    debug: Boolean(cfg.debug?.botDebug),
    passSpeed: 1.0,
    supportDist: 220,

    // ball samples for velocity estimation
    lastBall: null,
    ballVel: { x: 0, y: 0 },
  };

  window.__HB_STATE__ = state;
})();

