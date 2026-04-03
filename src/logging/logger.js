export function createLogger(config) {
  const level = String(config?.debug?.logLevel ?? "info").toLowerCase();
  const levels = ["debug", "info", "warn", "error"];
  const minIdx = Math.max(0, levels.indexOf(level));

  function should(lvl) {
    const idx = levels.indexOf(lvl);
    return idx >= minIdx;
  }

  function fmt(args) {
    const ts = new Date().toISOString();
    return [ts, ...args];
  }

  return {
    debug: (...args) => should("debug") && console.log(...fmt(["DEBUG", ...args])),
    info: (...args) => should("info") && console.log(...fmt(["INFO", ...args])),
    warn: (...args) => should("warn") && console.warn(...fmt(["WARN", ...args])),
    error: (...args) => should("error") && console.error(...fmt(["ERROR", ...args])),
  };
}

