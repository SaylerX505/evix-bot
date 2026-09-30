import { MessageFlags, PermissionFlagsBits } from "discord.js";
import { buildAddUserModal, buildRenameModal, buildTicketModal, handleTicketCommand } from "./commands.js";
import { getPanel, getPanelOption } from "./db.js";
import { isStaff, parseUserId } from "./utils.js";

function errorMessage(error) {
  return `Evix error: ${error instanceof Error ? error.message : "Unknown error."}`;
}

async function replySafely(interaction, payload) {
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
  return interaction.reply(payload);
}

function memberCanManageTicket(interaction, ticket) {
  if (interaction.member?.permissions?.has(PermissionFlagsBits.ManageChannels)) return true;
  return isStaff(interaction.member, ticket.staff_roles);
}

export async function handleInteraction(interaction, { service, ui }) {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "ticket") {
        await handleTicketCommand(interaction, service, ui);
      }
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("evix:p:")) {
      const match = interaction.customId.match(/^evix:p:(\d+):select$/);
      if (!match) throw new Error("Invalid panel interaction.");

      const optionId = interaction.values?.[0];
      if (!optionId) throw new Error("No ticket type was selected.");

      const option = await getPanelOption(optionId);
      if (!option || String(option.panel_id) !== match[1]) {
        throw new Error("This panel option is no longer available.");
      }

      if (option.action === "NOTHING") {
        const panel = await getPanel(interaction.guildId, option.panel_id);
        if (!panel) throw new Error("This ticket panel is no longer available.");
        await interaction.update(ui.buildPanelMessage(panel));
        return;
      }

      const modal = buildTicketModal(option);
      if (modal) {
        await interaction.showModal(modal);
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await service.createFromOption(interaction, option);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("evix:p:")) {
      const match = interaction.customId.match(/^evix:p:(\d+):o:(\d+)$/);
      if (!match) throw new Error("Invalid panel interaction.");

      const option = await getPanelOption(match[2]);
      if (!option || String(option.panel_id) !== match[1]) {
        throw new Error("This panel option is no longer available.");
      }

      if (option.action === "NOTHING") {
        const panel = await getPanel(interaction.guildId, option.panel_id);
        if (!panel) throw new Error("This ticket panel is no longer available.");
        await interaction.update(ui.buildPanelMessage(panel));
        return;
      }

      const modal = buildTicketModal(option);
      if (modal) {
        await interaction.showModal(modal);
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await service.createFromOption(interaction, option);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith("evix:modal:")) {
      const match = interaction.customId.match(/^evix:modal:(\d+)$/);
      if (!match) throw new Error("Invalid ticket form.");

      const option = await getPanelOption(match[1]);
      if (!option) throw new Error("This ticket form is no longer available.");

      const formValues = {};
      for (const field of option.modal_fields ?? []) {
        const value = interaction.fields.getTextInputValue(field.id);
        if (value?.trim()) formValues[field.label] = value;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await service.createFromOption(interaction, option, formValues);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith("evix:add-user:")) {
      const match = interaction.customId.match(/^evix:add-user:(\d+)$/);
      if (!match) throw new Error("Invalid add-user form.");

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const ticket = await service.getTicket(interaction, match[1]);
      const userId = parseUserId(interaction.fields.getTextInputValue("user"));
      await service.addMember(interaction, ticket, userId);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith("evix:rename:")) {
      const match = interaction.customId.match(/^evix:rename:(\d+)$/);
      if (!match) throw new Error("Invalid rename form.");

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const ticket = await service.getTicket(interaction, match[1]);
      await service.rename(interaction, ticket, interaction.fields.getTextInputValue("name"));
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("evix:t:")) {
      const match = interaction.customId.match(
        /^evix:t:(\d+):(claim|unclaim|lock|close|reopen|transcript|delete|add|rename|info|unlock)$/,
      );
      if (!match) throw new Error("Invalid ticket control.");

      const [, ticketId, action] = match;

      if (action === "add") {
        await interaction.showModal(buildAddUserModal(ticketId));
        return;
      }

      if (action === "rename") {
        await interaction.showModal(buildRenameModal(ticketId));
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const ticket = await service.getTicket(interaction, ticketId);

      const ownerAllowed = ticket.owner_id === interaction.user.id && ["close", "info"].includes(action);
      if (!memberCanManageTicket(interaction, ticket) && !ownerAllowed) {
        throw new Error("You are not authorized to use this ticket control.");
      }

      switch (action) {
        case "claim": await service.claim(interaction, ticket); break;
        case "unclaim": await service.unclaim(interaction, ticket); break;
        case "lock": await service.lock(interaction, ticket); break;
        case "unlock": await service.unlock(interaction, ticket); break;
        case "close": await service.close(interaction, ticket); break;
        case "reopen": await service.reopen(interaction, ticket); break;
        case "transcript": await service.sendTranscript(interaction, ticket); break;
        case "delete": await service.delete(interaction, ticket); break;
        case "info": await service.info(interaction, ticket); break;
        default: throw new Error("Unsupported ticket control.");
      }
    }
  } catch (error) {
    const payload = { content: errorMessage(error), allowedMentions: { parse: [] } };
    await replySafely(interaction, payload).catch(() => null);
    console.error("[evix-interaction-error]", error);
  }
}
