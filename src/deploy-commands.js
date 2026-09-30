import { REST, Routes } from "discord.js";
import { commands } from "./commands.js";
import { config, validateConfig } from "./config.js";

validateConfig();

const rest = new REST({ version: "10" }).setToken(config.token);

try {
  await rest.put(
    Routes.applicationCommands(config.clientId),
    { body: commands.map((command) => command.toJSON()) },
  );
  console.log(`[evix] registered ${commands.length} global command definition.`);
} catch (error) {
  console.error("[evix-command-deploy-error]", error);
  process.exit(1);
}
