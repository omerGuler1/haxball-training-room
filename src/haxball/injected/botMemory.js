// Browser-only: per-bot memory for receive/pass behavior.

(function initBotMemory() {
  function getMem(name) {
    const key = String(name || "");
    if (!key) return null;
    const map = window.__HB_BOTMEM__ || (window.__HB_BOTMEM__ = new Map());
    if (!map.has(key)) {
      map.set(key, {
        state: "support", // support|chase|receive|settle|pass
        lastKickTick: -999999,
        controlSinceTick: null,
        receiveStartTick: null,
        lastTargetName: null,
      });
    }
    return map.get(key);
  }

  window.__HB_BOTMEM__ = window.__HB_BOTMEM__ || new Map();
  window.__HB_BOTMEM_API__ = { getMem };
})();

