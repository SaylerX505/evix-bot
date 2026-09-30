import { Client, GatewayIntentBits } from "discord.js";
import { config, validateConfig } from "./config.js";
import { closeDatabase, initDatabase } from "./db.js";
import { handleInteraction } from "./handler.js";
import { TicketService } from "./tickets.js";
import * as ui from "./ui.js";

async function main() {
  validateConfig();
  await initDatabase(config.databaseUrl);

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  });

  const service = new TicketService(client);

  client.once("ready", () => {
    console.log(`[evix] logged in as ${client.user.tag}`);
    console.log(`[evix] guilds: ${client.guilds.cache.size}`);
  });

  client.on("interactionCreate", (interaction) => {
    void handleInteraction(interaction, { service, ui });
  });

  client.on("error", (error) => console.error("[evix-discord-error]", error));
  process.on("unhandledRejection", (reason) => console.error("[evix-unhandled-rejection]", reason));
  process.on("uncaughtException", (error) => console.error("[evix-uncaught-exception]", error));

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[evix] shutting down (${signal})`);
    client.destroy();
    await closeDatabase().catch((error) => console.error("[evix-db-close-error]", error));
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await client.login(config.token);
}

main().catch((error) => {
  console.error("[evix-startup-error]", error);
  process.exit(1);
});
