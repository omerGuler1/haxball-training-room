import { WebSocketServer } from "ws";
import { ControlMsgType } from "../shared/protocol.js";

export function createControlServer({ port, logger }) {
  const wss = new WebSocketServer({ port });
  const bots = new Map(); // name -> ws

  function safeSend(ws, obj) {
    if (ws.readyState !== ws.OPEN) return;
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

