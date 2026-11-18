// Entry point: node src/main.js  (env: KV_PORT, KV_DATA_DIR)
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigStore } from "./config.js";
import { SecretStore } from "./discord/auth.js";
import { DiscordService } from "./discord/service.js";
import { startServer } from "./server.js";
import { checkForUpdate } from "./update.js";

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

// In the background, so startup never waits on the network. KV_UPDATE_CHECK=0 turns it off.
if (process.env.KV_UPDATE_CHECK === "0") server.setUpdate({ state: "disabled" });
else {
  checkForUpdate({ root }).then((u) => {
    server.setUpdate(u);
    if (u.state !== "available") return;
    const what = u.behind ? `${u.behind} new change${u.behind === 1 ? "" : "s"}` : `version ${u.latest.version}`;
    const how = u.via === "git" ? "close Kosmik Voice, run  git pull  and start it again" : `download it from ${u.url}`;
    console.log(`
  ** Update available: ${what}. To install it, ${how}.`);
    if (u.via === "git") console.log(`     What's new: ${u.url}`);
  });
}

const shutdown = async () => {
  discord.stop();
  await server.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
