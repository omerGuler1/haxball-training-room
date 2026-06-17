import { WebSocketServer } from "ws";
import { ControlMsgType } from "../shared/protocol.js";

export function createControlServer({ port, logger }) {
  const wss = new WebSocketServer({ port });
  const bots = new Map(); // name -> ws

  // Drop control packets when the bot's socket buffer is congested. Better to
  // skip a tick than queue a stale move command that arrives 200ms late.
  const BACKPRESSURE_BYTES = 64 * 1024;
  let backpressureWarnedAt = 0;
  function safeSend(ws, obj) {
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > BACKPRESSURE_BYTES) {
      const now = Date.now();
      if (now - backpressureWarnedAt > 5000) {
        backpressureWarnedAt = now;
        logger?.warn?.(`Control WS backpressure (buffered=${ws.bufferedAmount}B), dropping packet`);
      }
      return;
    }
    ws.send(JSON.stringify(obj));
  }

  wss.on("connection", (ws) => {
    let botName = null;

    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }

      if (msg?.t === ControlMsgType.HELLO) {
        botName = String(msg.name || "").trim();
        if (!botName) return;
        bots.set(botName, ws);
        logger?.info?.(`Bot connected: ${botName}`);
        return;
      }

      if (msg?.t === ControlMsgType.PING) {
        safeSend(ws, { t: ControlMsgType.PONG, ts: Date.now() });
      }
    });

    ws.on("close", () => {
      if (botName && bots.get(botName) === ws) {
        bots.delete(botName);
        logger?.warn?.(`Bot disconnected: ${botName}`);
      }
    });
  });

  return {
    url: `ws://127.0.0.1:${port}`,
    getBotNames: () => [...bots.keys()],
    sendToBot: (name, msg) => {
      const ws = bots.get(name);
      if (!ws) return false;
      safeSend(ws, msg);
      return true;
    },
    killBot: (name, reason = "watchdog") => {
      const ws = bots.get(name);
      if (!ws) return false;
      // Tell the bot to call cleanExit(1) — process orchestrator will respawn.
      // Bypass backpressure check; this message must land.
      if (ws.readyState === ws.OPEN) {
        try { ws.send(JSON.stringify({ t: ControlMsgType.KILL, reason })); } catch {}
      }
      return true;
    },
    broadcast: (msg) => {
      for (const ws of bots.values()) safeSend(ws, msg);
    },
    close: async () => {
      try {
        for (const ws of bots.values()) {
          try {
            ws.close();
          } catch {}
        }
      } catch {}
      await new Promise((resolve) => wss.close(resolve));
    },
  };
}

