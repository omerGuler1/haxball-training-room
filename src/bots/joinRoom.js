export async function joinRoomClient({ page, roomLink, password, nickname }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Navigate to the room link. Haxball uses hash parameters.
  await page.goto(roomLink, { waitUntil: "domcontentloaded" });

  // Best-effort: set nickname via localStorage before room boot.
  await page.evaluate((nick) => {
    try {
      // This may vary; keep best-effort and non-fatal.
      localStorage.setItem("player_name", nick);
    } catch {}
  }, nickname);

  // Reload so the nickname takes effect if needed.
  await page.reload({ waitUntil: "domcontentloaded" });

  // Password entry is UI-based; selectors can change.
  // Only try if a password was provided.
  if (password) {
    const tryPassword = async () => {
      const input = await page.$('input[type="password"]');
      if (!input) return false;
      await input.click({ clickCount: 3 });
      await input.type(password);
      await page.keyboard.press("Enter");
      return true;
    };

    for (let i = 0; i < 10; i++) {
      const ok = await tryPassword();
      if (ok) break;
      await sleep(500);
    }
  }

  // Try to close dialogs / confirm buttons if any appear.
  for (let i = 0; i < 10; i++) {
    const btn = await page.$('button, input[type="button"], input[type="submit"]');
    if (btn) {
      const txt = await page.evaluate((el) => (el.innerText || el.value || "").toLowerCase(), btn);
      if (["ok", "confirm", "join", "play"].some((k) => txt.includes(k))) {
        await btn.click().catch(() => {});
      }
    }
    await sleep(400);
  }
}

