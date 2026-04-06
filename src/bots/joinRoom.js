export async function joinRoomClient({ page, roomLink, password, nickname }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Set nickname in localStorage before navigating
  await page.goto("https://www.haxball.com", { waitUntil: "domcontentloaded" });
  await page.evaluate((nick) => {
    try { localStorage.setItem("player_name", nick); } catch {}
  }, nickname);

  // Navigate to the room
  await page.goto(roomLink, { waitUntil: "domcontentloaded" });
  await sleep(3000);

  // Haxball renders its game UI inside an iframe. Find it.
  async function getGameFrame() {
    const frames = page.frames();
    for (const f of frames) {
      if (f === page.mainFrame()) continue;
      try {
        const hasInput = await f.evaluate(() => !!document.querySelector("input"));
        if (hasInput) return f;
        const hasCanvas = await f.evaluate(() => !!document.querySelector("canvas"));
        if (hasCanvas) return f;
      } catch {}
    }
    return null;
  }

  // Wait for iframe to appear
  let frame = null;
  for (let i = 0; i < 15; i++) {
    frame = await getGameFrame();
    if (frame) break;
    await sleep(1000);
  }

  // If no iframe found, try the main page as fallback
  const ctx = frame || page;

  for (let attempt = 0; attempt < 20; attempt++) {
    // Check if already in game
    const inGame = await ctx.evaluate(() => {
      const c = document.querySelector("canvas");
      return c && c.width > 100;
    }).catch(() => false);
    if (inGame) return;

    // Find input and fill nickname
    const result = await ctx.evaluate((nick) => {
      const inputs = document.querySelectorAll("input");
      for (const inp of inputs) {
        const t = (inp.type || "text").toLowerCase();
        if (t === "password" || t === "hidden") continue;
        inp.focus();
        // Clear and set value
        inp.value = nick;
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        inp.dispatchEvent(new Event("change", { bubbles: true }));
        return "filled";
      }
      return "no-input";
    }, nickname).catch(() => "error");

    if (result === "filled") {
      // Click the Ok button
      await ctx.evaluate(() => {
        // Try buttons first
        const btns = document.querySelectorAll("button");
        for (const b of btns) {
          if (b.offsetParent === null) continue;
          const text = (b.innerText || "").toLowerCase().trim();
          if (text === "ok" || text === "join" || text === "play") {
            b.click();
            return "btn-clicked";
          }
        }
        // Try any clickable div/span with "ok" text
        const all = document.querySelectorAll("div, span, a");
        for (const el of all) {
          if (el.offsetParent === null) continue;
          const text = (el.innerText || "").toLowerCase().trim();
          if (text === "ok") {
            el.click();
            return "div-clicked";
          }
        }
        // Click any visible button as last resort
        for (const b of btns) {
          if (b.offsetParent !== null) { b.click(); return "fallback-btn"; }
        }
        return "no-button";
      }).catch(() => "error");

      await sleep(300);

      // Also try Enter key
      if (frame) {
        await frame.evaluate(() => {
          const inp = document.querySelector("input");
          if (inp) {
            inp.focus();
            inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
            inp.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
            inp.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
          }
        }).catch(() => {});
      }
      // Use Puppeteer keyboard as well
      await page.keyboard.press("Enter").catch(() => {});

      await sleep(500);
    }

    // Handle password if needed
    if (password) {
      const hasPw = await ctx.evaluate((pw) => {
        const inp = document.querySelector('input[type="password"]');
        if (!inp) return false;
        inp.focus();
        inp.value = pw;
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      }, password).catch(() => false);
      if (hasPw) {
        await page.keyboard.press("Enter").catch(() => {});
        await sleep(500);
      }
    }

    await sleep(1000);
  }

  await sleep(2000);
}
