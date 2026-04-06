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

  // ── Squares mode: court definitions ──────────────────
  if (state.matchMode === "squares") {
    state.courts = [
      { index: 0, name: "Sol",  centerX: -420, minX: -620, maxX: -220, discIndex: 1, botSpawnX: -540, humanSpawnX: -300, botId: null, humanId: null, lastBall: null, ballVel: { x: 0, y: 0 } },
      { index: 1, name: "Orta", centerX: 0,    minX: -200, maxX: 200,  discIndex: 2, botSpawnX: -100, humanSpawnX: 100,  botId: null, humanId: null, lastBall: null, ballVel: { x: 0, y: 0 } },
      { index: 2, name: "Sag",  centerX: 420,  minX: 220,  maxX: 620,  discIndex: 3, botSpawnX: 300,  humanSpawnX: 540,  botId: null, humanId: null, lastBall: null, ballVel: { x: 0, y: 0 } },
    ];
    // Player assignment order: center first, then left, then right
    state.courtJoinOrder = [1, 0, 2];
  }

  window.__HB_STATE__ = state;
})();
