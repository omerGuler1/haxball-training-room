// Browser-only. Provides a safe bridge back to Node via exposed function.

(function initBridge() {
  function safePost(type, payload) {
    try {
      window.__hbNodeBridgePost?.({ type, payload });
    } catch {
      // ignore
    }
  }

  window.__HB_BRIDGE__ = {
    post: safePost,
  };
})();

