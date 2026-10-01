import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";
import {
  buildPanelStudioPayload,
  clearPanelDraft,
  getPanelDraft,
  panelBasicModal,
  panelMediaModal,
  panelStudioButtonId,
  setPanelDraft,
} from "./panels.js";

import {
  getPanel,
  getPanelOption,
  updatePanel,
} from "./db.js";
import { parseUserId } from "./utils.js";
import { buildPanelMessage } from "./ui.js";
import { buildAddUserModal, buildRenameModal, buildTicketModal, handlePanelCommand, handleTicketCommand } from "./commands.js";

function errorMessage(error) {
  return "Evix error: " + (error instanceof Error ? error.message : "Unknown error.");
}

async function replySafely(interaction, payload) {
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
  return interaction.reply(payload);
}

async function requirePanelDraft(interaction, panelId) {
  const draft = getPanelDraft(interaction.guildId, interaction.user.id, panelId);
  if (!draft) throw new Error("This panel studio session has expired. Open /panel edit again.");
  return draft;
}

async function updateStudio(interaction, draft, state = {}) {
  return interaction.editReply(
    buildPanelStudioPayload(draft, interaction.client.user, state),
  );
}

async function savePanelDraft(interaction, panelId, draft) {
  const saved = await updatePanel(panelId, {
    name: String(draft.name || "").trim(),
    title: String(draft.title || "").trim(),
    description: String(draft.description || "").trim(),
    image_url: draft.image_url || null,
    accent_color: Number.isInteger(Number(draft.accent_color)) ? Number(draft.accent_color) : 0x5865f2,
    placeholder: String(draft.placeholder || "").trim(),
    footer: String(draft.footer || "").trim(),
    footer_show_bot: draft.footer_show_bot === true,
  });
  return saved;
}

export async function handleInteraction(interaction, { service, ui }) {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "ticket") {
        await handleTicketCommand(interaction, service, ui);
      } else if (interaction.commandName === "panel") {
        await handlePanelCommand(interaction, ui);
      }
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("evix:p:")) {
      const match = interaction.customId.match(/^evix:p:(\d+):select$/);
      if (!match) throw new Error("Invalid panel interaction.");

      const optionId = interaction.values?.[0];
      if (!optionId) throw new Error("No ticket type was selected.");

      const option = await getPanelOption(optionId, interaction.guildId);
      if (!option || String(option.panel_id) !== match[1]) {
        throw new Error("This panel option is no longer available.");
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

      const option = await getPanelOption(match[1], interaction.guildId);
      if (!option) throw new Error("This ticket form is no longer available.");

      const formValues = {};
      for (const field of option.modal_fields ?? []) {
        const value = interaction.fields.getTextInputValue(field.id);
        if (value?.trim()) formValues[field.id] = value;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await service.createFromOption(interaction, option, formValues);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith("evix:panelstudio-modal:")) {
      const match = interaction.customId.match(/^evix:panelstudio-modal:(\d+):(basic|media)$/);
      if (!match) throw new Error("Invalid panel studio form.");
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        throw new Error("You need Manage Server to edit ticket panels.");
      }

      const draft = await requirePanelDraft(interaction, match[1]);

      if (match[2] === "basic") {
        draft.name = interaction.fields.getTextInputValue("name").trim();
        draft.title = interaction.fields.getTextInputValue("title").trim();
        draft.description = interaction.fields.getTextInputValue("description").trim();
        draft.footer = interaction.fields.getTextInputValue("footer").trim();
      } else {
        const uploaded = interaction.fields.getUploadedFiles("image_file", false)?.first?.();
        const imageUrl = uploaded?.url || interaction.fields.getTextInputValue("image_url")?.trim() || "";
        draft.image_url = imageUrl || null;
      }

      setPanelDraft(interaction.guildId, interaction.user.id, match[1], draft);
      await interaction.deferUpdate();
      return updateStudio(interaction, draft);
    }

    if (interaction.isButton() && interaction.customId.startsWith("evix:panelstudio:")) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        throw new Error("You need Manage Server to manage ticket panels.");
      }

      const match = interaction.customId.match(/^evix:panelstudio:(\d+):(basic|media|toggle-footer|preview|preview-back|save|close)$/);
      if (!match) throw new Error("Invalid panel studio action.");

      const [, panelId, action] = match;

      if (action === "preview") {
        const draft = await requirePanelDraft(interaction, panelId);
        await interaction.update(buildPanelStudioPreview(draft, interaction.client.user, panelId));
        return;
      }

      if (action === "preview-back") {
        const draft = await requirePanelDraft(interaction, panelId);
        await interaction.update(buildPanelStudioPayload(draft, interaction.client.user));
        return;
      }

      if (action === "close") {
        clearPanelDraft(interaction.guildId, interaction.user.id, panelId);
        await interaction.deferUpdate();
        await interaction.deleteReply().catch(() => null);
        return;
      }

      const draft = await requirePanelDraft(interaction, panelId);

      if (action === "basic") {
        await interaction.showModal(panelBasicModal(draft));
        return;
      }

      if (action === "media") {
        await interaction.showModal(panelMediaModal(draft));
        return;
      }

      if (action === "toggle-footer") {
        draft.footer_show_bot = draft.footer_show_bot !== true;
        setPanelDraft(interaction.guildId, interaction.user.id, panelId, draft);
        await interaction.update(buildPanelStudioPayload(draft, interaction.client.user));
        return;
      }

      if (action === "save") {
        const current = await getPanel(interaction.guildId, panelId);
        if (!current) throw new Error("Panel not found.");
        const saved = await savePanelDraft(interaction, panelId, draft);
        if (!String(saved?.name || "").trim()) throw new Error("Panel name is required.");
        const refreshed = await getPanel(interaction.guildId, panelId);
        setPanelDraft(interaction.guildId, interaction.user.id, panelId, refreshed);
        if (refreshed.channel_id && refreshed.message_id) {
          const channel = await interaction.guild.channels.fetch(refreshed.channel_id).catch(() => null);
          const message = await channel?.messages.fetch(refreshed.message_id).catch(() => null);
          if (message) await message.edit(ui.buildPanelMessage(refreshed, interaction.client.user)).catch(() => null);
        }
        await interaction.update(buildPanelStudioPayload(interaction.guild ? refreshed : draft, interaction.client.user, { saved: true }));
      }
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

    if (interaction.isButton() && interaction.customId.startsWith("evix:confirm:")) {
      const match = interaction.customId.match(/^evix:confirm:(\d+):(delete|cancel)$/);
      if (!match) throw new Error("Invalid confirmation action.");

      const [, ticketId, action] = match;
      const ticket = await service.getTicket(interaction, ticketId);
      if (!service.canManageTicket(interaction.member, ticket)) {
        throw new Error("You are not authorized to confirm this action.");
      }

      if (action === "cancel") {
        if (ticket.status === "closed") {
          await interaction.update(ui.buildClosedTicketView(ticket));
        } else {
          await interaction.update(ui.buildTicketView(ticket, {
            welcome_message: ticket.welcome_message
              || "Thanks for opening a ticket. A member of the team will be with you shortly.",
          }));
        }
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await service.delete(interaction, ticket);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("evix:t:")) {
      const match = interaction.customId.match(
        /^evix:t:(\d+):(claim|unclaim|lock|close|reopen|transcript|delete|add|rename|info|unlock|waiting)$/
      );
      if (!match) throw new Error("Invalid ticket control.");

      const [, ticketId, action] = match;
      const ticket = await service.getTicket(interaction, ticketId);

      if (action === "add" || action === "rename") {
        if (!service.canManageTicket(interaction.member, ticket)) {
          throw new Error("You are not authorized to use this ticket control.");
        }

        if (action === "add") {
          await interaction.showModal(buildAddUserModal(ticketId));
        } else {
          await interaction.showModal(buildRenameModal(ticketId));
        }
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const ownerAllowed = ticket.owner_id === interaction.user.id && ["close", "info"].includes(action);
      if (!service.canManageTicket(interaction.member, ticket) && !ownerAllowed) {
        throw new Error("You are not authorized to use this ticket control.");
      }

      if (action === "delete") {
        await service.requestDelete(interaction, ticket);
        return;
      }

      switch (action) {
        case "claim": await service.claim(interaction, ticket); break;
        case "unclaim": await service.unclaim(interaction, ticket); break;
        case "lock": await service.lock(interaction, ticket); break;
        case "unlock": await service.unlock(interaction, ticket); break;
        case "waiting": await service.waiting(interaction, ticket); break;
        case "close": await service.close(interaction, ticket); break;
        case "reopen": await service.reopen(interaction, ticket); break;
        case "transcript": await service.sendTranscript(interaction, ticket); break;
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

function buildPanelStudioPreview(panel, botUser, panelId) {
  const preview = buildPanelMessage(panel, botUser, { preview: true });
  preview.components.push(
    new ContainerBuilder().addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(panelStudioButtonId(panelId, "preview-back"))
          .setLabel("Back")
          .setStyle(ButtonStyle.Secondary),
      ),
    ),
  );
  return preview;
}
