// Browser-only vector helpers.

(function initMath() {
  function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }

  function len(x, y) {
    return Math.hypot(x, y);
  }

  function norm(x, y) {
    const l = len(x, y);
    if (l < 1e-6) return { x: 0, y: 0 };
    return { x: x / l, y: y / l };
  }

  function dist(a, b) {
    return len(a.x - b.x, a.y - b.y);
  }

  function signAxis(v, dead) {
    if (Math.abs(v) <= dead) return 0;
    return v > 0 ? 1 : -1;
  }

  window.__HB_MATH__ = { clamp, len, norm, dist, signAxis };
})();

