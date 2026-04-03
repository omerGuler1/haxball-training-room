import fs from "node:fs/promises";

export async function loadStadiumJsonString(stadiumPath) {
  const raw = await fs.readFile(stadiumPath, "utf8");
  // Validate JSON early so errors are clear.
  JSON.parse(raw);
  return raw;
}

