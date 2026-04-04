// Browser-only: shared mutable state for the 1v1 match lifecycle.

(function initState() {
  const cfg = window.__HB_CONFIG__;
  const { clamp } = window.__HB_MATH__;

  const state = {
    tick: 0,

    // --- Match lifecycle ---
    matchMode: cfg.match?.mode || "1v1", // "1v1" or "all"
    matchState: "WAITING", // WAITING | STARTING | PLAYING | GOAL_SCORED | MATCH_OVER | RESETTING
    matchScore: { red: 0, blue: 0 },
    scoreLimit: clamp(Number(cfg.match?.scoreLimit || 3), 1, 20),
    timeLimit: Math.max(0, Number(cfg.match?.timeLimit ?? 180)),
    matchOverPauseMs: Math.max(0, Number(cfg.match?.matchOverPauseMs ?? 5000)),

    // --- Players ---
    humanIds: [],
    activeHumanId: null,
    queuedHumanIds: [],
    afkIds: [],

    // --- Bot ---
    botCount: clamp(Number(cfg.bots?.count || 1), 1, 2),
    pausedBot: false,

    // --- Debug ---
    debug: Boolean(cfg.debug?.botDebug),

    // --- Ball tracking ---
    lastBall: null,
    ballVel: { x: 0, y: 0 },
  };

  window.__HB_STATE__ = state;
})();
