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

  const botsToLaunch = Math.max(0, Math.min(2, config.bots.count));
  for (let i = 0; i < botsToLaunch; i++) {
    if (i > 0) {
      const delay = Math.max(0, Number(config.bots.launchDelayMs) || 0);
      if (delay) await new Promise((r) => setTimeout(r, delay));
    }
    const botName = config.bots.names[i] ?? `CoopBot${i + 1}`;
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
      if (m?.type === "bot.ready") log.info(`Bot ready: ${m.name}`);
    });
  }

  process.on("SIGINT", () => {
    log.info("SIGINT received, shutting down...");
    host.kill("SIGINT");
    process.exit(0);
  });
}

