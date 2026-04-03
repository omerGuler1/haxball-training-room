import { startHost } from "./haxball/host.js";

const host = await startHost({
  onReady: (info) => {
    if (process.send) process.send({ type: "host.ready", ...info });
  },
});

process.on("SIGINT", async () => {
  await host?.shutdown?.();
  process.exit(0);
});

