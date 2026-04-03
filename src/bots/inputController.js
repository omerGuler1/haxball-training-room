const KEY = Object.freeze({
  UP: "ArrowUp",
  DOWN: "ArrowDown",
  LEFT: "ArrowLeft",
  RIGHT: "ArrowRight",
  KICK: "Space",
});

export function createInputController({ page, logger, maxTransitionsPerSec = 40 }) {
  const held = new Map(); // key -> bool
  let lastTransitionAt = 0;
  const minDt = 1000 / Math.max(5, maxTransitionsPerSec);
  let kicking = false;

  async function setKey(key, on) {
    const isOn = held.get(key) === true;
    if (isOn === on) return;

    const now = Date.now();
    if (now - lastTransitionAt < minDt) return;
    lastTransitionAt = now;

    held.set(key, on);
    try {
      if (on) await page.keyboard.down(key);
      else await page.keyboard.up(key);
    } catch (e) {
      logger?.warn?.(`Key ${key} failed: ${e?.message || e}`);
    }
  }

  async function applyAxes(moveX, moveY, kick) {
    const mx = Math.max(-1, Math.min(1, Number(moveX) || 0));
    const my = Math.max(-1, Math.min(1, Number(moveY) || 0));

    await setKey(KEY.LEFT, mx < 0);
    await setKey(KEY.RIGHT, mx > 0);
    await setKey(KEY.UP, my < 0);
    await setKey(KEY.DOWN, my > 0);
    if (Boolean(kick)) {
      // kick is handled as a pulse to allow approximate “power” control by hold duration
      // (within the limits of Haxball input).
      // Actual timing is triggered by kickPulse().
    } else if (!kicking) {
      await setKey(KEY.KICK, false);
    }
  }

  async function kickPulse(kickPower = 1.0) {
    if (kicking) return;
    kicking = true;
    const p = Math.max(0.15, Math.min(1.0, Number(kickPower) || 1.0));
    const holdMs = Math.round(35 + p * 80); // 35..115ms
    try {
      await setKey(KEY.KICK, true);
      setTimeout(async () => {
        try {
          await setKey(KEY.KICK, false);
        } finally {
          kicking = false;
        }
      }, holdMs);
    } catch (e) {
      kicking = false;
      logger?.warn?.(`Kick pulse failed: ${e?.message || e}`);
    }
  }

  async function releaseAll() {
    for (const key of Object.values(KEY)) {
      held.set(key, false);
      try {
        await page.keyboard.up(key);
      } catch {}
    }
    kicking = false;
  }

  return { applyAxes, kickPulse, releaseAll };
}

