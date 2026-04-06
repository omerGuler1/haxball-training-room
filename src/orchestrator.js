import { fork } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./config/index.js";
import { createLogger } from "./logging/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function waitForMessage(child, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for child message"));
    }, timeoutMs);

    function onMessage(msg) {
      try {
        if (predicate(msg)) {
          cleanup();
          resolve(msg);
        }
      } catch (e) {
        cleanup();
        reject(e);
      }
    }

    function onExit(code, signal) {
      cleanup();
      reject(new Error(`Child exited before message (code=${code}, signal=${signal})`));
    }

    function cleanup() {
      clearTimeout(t);
      child.off("message", onMessage);
      child.off("exit", onExit);
    }

    child.on("message", onMessage);
    child.on("exit", onExit);
  });
}

export async function spawnOrchestrator() {
  const config = loadConfig();
  const log = createLogger(config);

  log.info("Starting orchestrator...");
  process.on("unhandledRejection", (e) => log.error(`Unhandled rejection: ${e?.message || e}`));

  if (!config.room.token) {
    log.error("Missing HAXBALL_TOKEN. Create a .env (see .env.example).");
    process.exit(1);
  }

  const host = fork(path.join(__dirname, "hostEntry.js"), [], {
    env: { ...process.env },
    stdio: ["inherit", "inherit", "inherit", "ipc"],
  });

  let ready;
  try {
    ready = await waitForMessage(
      host,
      (m) => m && m.type === "host.ready" && typeof m.roomLink === "string" && typeof m.controlWsUrl === "string",
      60_000
    );
  } catch (e) {
    log.error(String(e?.message || e));
    process.exit(1);
  }

  const { roomLink, controlWsUrl } = ready;

  log.info(`Room link: ${roomLink}`);
  log.info(`Bot control WS: ${controlWsUrl}`);

  // ── Bot launcher with auto-restart ──────────────────────

  const botBackoff = new Map(); // botIndex -> current backoff ms

  function launchBot(index) {
    const botName = config.bots.names[index] ?? `CoopBot${index + 1}`;
    const bot = fork(path.join(__dirname, "botEntry.js"), [], {
      env: {
        ...process.env,
        HB_ROOM_LINK: roomLink,
        HB_BOT_NAME: botName,
        HB_CONTROL_WS_URL: controlWsUrl,
        HB_ROOM_PASSWORD: config.room.password ?? "",
      },
      stdio: ["inherit", "inherit", "inherit", "ipc"],
    });

    bot.on("message", (m) => {
      if (m?.type === "bot.ready") {
        log.info(`Bot ready: ${m.name}`);
        botBackoff.set(index, 5000); // Reset backoff on success
      }
    });

    bot.on("exit", (code, signal) => {
      const currentBackoff = botBackoff.get(index) || 5000;
      log.warn(`Bot ${botName} exited (code=${code}, signal=${signal}). Restarting in ${currentBackoff / 1000}s...`);
      // Exponential backoff: 5s, 10s, 20s, 40s, max 60s
      const nextBackoff = Math.min(currentBackoff * 2, 60000);
      botBackoff.set(index, nextBackoff);
      setTimeout(() => launchBot(index), currentBackoff);
    });
  }

  const botsToLaunch = Math.max(0, Math.min(6, config.bots.count));
  for (let i = 0; i < botsToLaunch; i++) {
    if (i > 0) {
      const delay = Math.max(0, Number(config.bots.launchDelayMs) || 0);
      if (delay) await new Promise((r) => setTimeout(r, delay));
    }
    launchBot(i);
  }

  // ── Host crash recovery ────��────────────────────────────

  host.on("exit", (code, signal) => {
    log.error(`Host process exited (code=${code}, signal=${signal}). Entire stack will restart in 10s...`);
    setTimeout(() => {
      process.exit(1); // Let PM2 or supervisor restart us
    }, 10000);
  });

  // ── Graceful shutdown ───────────────────────────────────

  function shutdown(sig) {
    log.info(`${sig} received, shutting down...`);
    host.kill("SIGINT");
    setTimeout(() => process.exit(0), 3000);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
