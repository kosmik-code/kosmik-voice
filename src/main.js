// Entry point: node src/main.js  (env: KV_PORT, KV_DATA_DIR)
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigStore } from "./config.js";
import { SecretStore } from "./discord/auth.js";
import { DiscordService } from "./discord/service.js";
import { startServer } from "./server.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.resolve(process.env.KV_DATA_DIR || path.join(root, "data"));
const publicDir = path.join(root, "public");
const port = Number(process.env.KV_PORT || 7429);

const config = new ConfigStore(dataDir);
await config.load();
const secrets = new SecretStore(dataDir);
const discord = new DiscordService({ clientId: config.current.discord.clientId, secrets });

let server;
try {
  server = await startServer({ port, dataDir, publicDir, config, secrets, discord });
} catch (err) {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${port} is busy. Is Kosmik Voice already running? Use KV_PORT=<port> to pick another.`);
    process.exit(1);
  }
  throw err;
}

discord.on("status", ({ state, message }) => console.log(`[discord] ${state}${message ? `: ${message}` : ""}`));
discord.start();

console.log(`Kosmik Voice running`);
console.log(`  Editor:  ${server.url}/editor/`);
console.log(`  Overlay: ${server.url}/overlay/<preset-id>   (e.g. ${server.url}/overlay/main)`);

const shutdown = async () => {
  discord.stop();
  await server.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
