// Browser-only utilities (rate limiting, ring sampling).

(function initUtil() {
  function createRateLimiter(minIntervalMs) {
    let last = 0;
    return function allow() {
      const now = Date.now();
      if (now - last < minIntervalMs) return false;
      last = now;
      return true;
    };
  }

  function createRingBuffer(capacity) {
    const buf = new Array(capacity);
    let idx = 0;
    let size = 0;
    return {
      push: (v) => {
        buf[idx] = v;
        idx = (idx + 1) % capacity;
        size = Math.min(capacity, size + 1);
      },
      toArray: () => {
        const out = [];
        for (let i = 0; i < size; i++) {
          const j = (idx - size + i + capacity) % capacity;
          out.push(buf[j]);
        }
        return out;
      },
      size: () => size,
    };
  }

  window.__HB_UTIL__ = { createRateLimiter, createRingBuffer };
})();

