import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { anthropicClient } from "../engine/llm.ts";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dbPath = process.env.BLINDSPOT_DB ?? resolve(root, "data/blindspot.db");
mkdirSync(dirname(dbPath), { recursive: true });

// The API key is read on the server only and is never sent to the browser.
const key = process.env.ANTHROPIC_API_KEY;
const llm = key ? anthropicClient(key, process.env.BLINDSPOT_MODEL ?? "claude-haiku-5-5") : null;

const port = Number(process.env.PORT ?? 3000);
createApp({ db: openDb(dbPath), llm, publicDir: resolve(root, "public") }).listen(port, () => {
  console.log(`BlindSpot AI running at http://localhost:${port} (${llm ? "AI extraction enabled" : "offline keyword engine only"})`);
});
