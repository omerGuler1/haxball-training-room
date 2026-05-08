// Diagnostic: figure out which import is hanging.
console.log("[diag] node start, version=", process.version);

console.log("[diag] importing dotenv…");
const t0 = Date.now();
await import("dotenv").then(() => console.log("[diag] dotenv ok in", Date.now() - t0, "ms")).catch((e) => console.error("[diag] dotenv FAIL:", e.message));

console.log("[diag] importing better-sqlite3…");
const t1 = Date.now();
await import("better-sqlite3").then(() => console.log("[diag] better-sqlite3 ok in", Date.now() - t1, "ms")).catch((e) => console.error("[diag] better-sqlite3 FAIL:", e.message));

console.log("[diag] importing discord.js…");
const t2 = Date.now();
await import("discord.js").then(() => console.log("[diag] discord.js ok in", Date.now() - t2, "ms")).catch((e) => console.error("[diag] discord.js FAIL:", e.message));

console.log("[diag] importing ../config/index.js…");
const t3 = Date.now();
await import("../config/index.js").then(() => console.log("[diag] config ok in", Date.now() - t3, "ms")).catch((e) => console.error("[diag] config FAIL:", e.message));

console.log("[diag] importing ../db/database.js…");
const t4 = Date.now();
await import("../db/database.js").then(() => console.log("[diag] db/database ok in", Date.now() - t4, "ms")).catch((e) => console.error("[diag] db/database FAIL:", e.message));

console.log("[diag] all imports done");
