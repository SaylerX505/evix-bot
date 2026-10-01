import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, MessageFlags, PermissionFlagsBits } from "discord.js";
import {
  buildPanelStudioPayload,
  clearPanelDraft,
  getPanelDraft,
  panelBasicModal,
  panelMediaModal,
  panelStudioButtonId,
  setPanelDraft,
} from "./panels.js";
import { getPanel, getPanelOption, updatePanel } from "./db.js";
import { buildActionResult, buildCloseConfirmation, buildClosedTicketView, buildErrorResult, buildInfoView, buildPanelMessage, buildTicketView, v2Message } from "./ui.js";
import { logInteractionError, normalizeError } from "./errors.js";
import { buildRenameModal, buildTicketModal, handlePanelAutocomplete, handlePanelCommand, handleTicketCommand } from "./commands.js";

async function replySafely(interaction, payload) {
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
  return interaction.reply(payload);
}
async function requirePanelDraft(interaction, panelId) {
  const draft = getPanelDraft(interaction.guildId, interaction.user.id, panelId);
  if (!draft) throw new Error("This panel studio session has expired. Open /panel edit again.");
  return draft;
}

export async function handleInteraction(interaction, { service, ui }) {
  try {
    if (interaction.isAutocomplete()) {
      if (interaction.commandName === "panel") await handlePanelAutocomplete(interaction);
      else await interaction.respond([]);
      return;
    }

    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "panel") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await handlePanelCommand(interaction, ui);
        return;
      }
      if (interaction.commandName === "ticket") {
        const sub = interaction.options.getSubcommand();
        if (["setup", "config", "logs", "close", "delete", "transcript"].includes(sub)) {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        } else if (["info", "claim", "unclaim", "waiting", "reopen", "add", "remove", "rename"].includes(sub)) {
          await interaction.deferReply();
        }
        await handleTicketCommand(interaction, service, ui);
      }
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("evix:p:")) {
      const match = interaction.customId.match(/^evix:p:(\d+):select$/);
      if (!match) throw new Error("Invalid panel interaction.");
      const optionId = interaction.values?.[0];
      if (!optionId) throw new Error("No ticket type was selected.");
      const option = await getPanelOption(optionId, interaction.guildId);
      if (!option || String(option.panel_id) !== match[1]) throw new Error("This panel option is no longer available.");
      if (option.action === "NOTHING") {
        await interaction.reply({
          ...buildActionResult("Option Selected", "This option does not perform an action."),
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        });
        return;
      }
      const modal = buildTicketModal(option);
      if (modal) { await interaction.showModal(modal); return; }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await service.createFromOption(interaction, option);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith("evix:modal:")) {
      const match = interaction.customId.match(/^evix:modal:(\d+)$/);
      if (!match) throw new Error("Invalid ticket form.");
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const option = await getPanelOption(match[1], interaction.guildId);
      if (!option) throw new Error("This ticket form is no longer available.");
      const formValues = {};
      for (const field of option.modal_fields ?? []) {
        const value = interaction.fields.getTextInputValue(field.id);
        if (value?.trim()) formValues[field.id] = value;
      }
      await service.createFromOption(interaction, option, formValues);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith("evix:panelstudio-modal:")) {
      const match = interaction.customId.match(/^evix:panelstudio-modal:(\d+):(basic|media)$/);
      if (!match) throw new Error("Invalid panel studio form.");
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) throw new Error("You need Manage Server to edit ticket panels.");
      const draft = await requirePanelDraft(interaction, match[1]);
      if (match[2] === "basic") {
        draft.name = interaction.fields.getTextInputValue("name").trim();
        draft.title = interaction.fields.getTextInputValue("title").trim();
        draft.description = interaction.fields.getTextInputValue("description").trim();
        draft.footer = "";
        draft.footer_show_bot = false;
      } else {
        const uploaded = interaction.fields.getUploadedFiles("image_file", false)?.first?.();
        const imageUrl = uploaded?.url || interaction.fields.getTextInputValue("image_url")?.trim() || "";
        draft.image_url = imageUrl || null;
      }
      setPanelDraft(interaction.guildId, interaction.user.id, match[1], draft);
      await interaction.deferUpdate();
      return await interaction.editReply(buildPanelStudioPayload(draft, interaction.client.user));
    }

    if (interaction.isButton() && interaction.customId.startsWith("evix:panelstudio:")) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) throw new Error("You need Manage Server to manage ticket panels.");
      const match = interaction.customId.match(/^evix:panelstudio:(\d+):(basic|media|preview|preview-back|save|close)$/);
      if (!match) throw new Error("Invalid panel studio action.");
      const [, panelId, action] = match;
      if (action === "preview") {
        const draft = await requirePanelDraft(interaction, panelId);
        const preview = buildPanelMessage(draft, interaction.client.user, { preview: true });
        preview.components.push(new ContainerBuilder().addActionRowComponents(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(panelStudioButtonId(panelId, "preview-back")).setLabel("Back").setStyle(ButtonStyle.Secondary))));
        return await interaction.update(preview);
      }
      if (action === "preview-back") {
        const draft = await requirePanelDraft(interaction, panelId);
        return await interaction.update(buildPanelStudioPayload(draft, interaction.client.user));
      }
      if (action === "close") {
        clearPanelDraft(interaction.guildId, interaction.user.id, panelId);
        await interaction.deferUpdate();
        return interaction.deleteReply().catch(() => null);
      }
      const draft = await requirePanelDraft(interaction, panelId);
      if (action === "basic") return await interaction.showModal(panelBasicModal(draft));
      if (action === "media") return await interaction.showModal(panelMediaModal(draft));
      if (action === "save") {
        await interaction.deferUpdate();
        const current = await getPanel(interaction.guildId, panelId);
        if (!current) throw new Error("Panel not found.");
        const panelName = String(draft.name || "").trim();
        if (!panelName) throw new Error("Panel name is required.");
        const saved = await updatePanel(panelId, {
          name: panelName,
          title: String(draft.title || "").trim(),
          description: String(draft.description || "").trim(),
          image_url: draft.image_url || null,
          accent_color: Number.isInteger(Number(draft.accent_color)) ? Number(draft.accent_color) : 0x5865f2,
          placeholder: String(draft.placeholder || "").trim(),
          footer: "",
          footer_show_bot: false,
        });
        if (!String(saved?.name || "").trim()) throw new Error("Panel name is required.");
        const refreshed = await getPanel(interaction.guildId, panelId);
        setPanelDraft(interaction.guildId, interaction.user.id, panelId, refreshed);
        if (refreshed.channel_id && refreshed.message_id) {
          const channel = await interaction.guild.channels.fetch(refreshed.channel_id).catch(() => null);
          const message = await channel?.messages.fetch(refreshed.message_id).catch(() => null);
          if (message) await message.edit(ui.buildPanelMessage(refreshed, interaction.client.user)).catch(() => null);
        }
        return await interaction.editReply(buildPanelStudioPayload(refreshed, interaction.client.user, { saved: true }));
      }
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith("evix:rename:")) {
      const match = interaction.customId.match(/^evix:rename:(\d+)$/);
      if (!match) throw new Error("Invalid rename form.");
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const ticket = await service.getTicket(interaction, match[1]);
      await service.withTicketActionLock(ticket.id, () =>
        service.rename(interaction, ticket, interaction.fields.getTextInputValue("name")),
      );
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("evix:confirm:")) {
      const match = interaction.customId.match(/^evix:confirm:(\d+):(close|keep-open|delete|cancel)$/);
      if (!match) throw new Error("Invalid confirmation action.");
      const [, ticketId, action] = match;

      // Acknowledge immediately; database/API work must not consume Discord's interaction window.
      await interaction.deferUpdate();

      const ticket = await service.getTicket(interaction, ticketId);
      const canManage = service.canManageTicket(interaction.member, ticket);
      const canClose = service.canClose(interaction.member, ticket);
      if (!canManage && !((action === "close" || action === "keep-open") && canClose)) throw new Error("You are not authorized to confirm this action.");

      if (action === "keep-open" || action === "cancel") {
        await interaction.deleteReply().catch(() => null);
        return;
      }

      await interaction.deleteReply().catch(() => null);

      try {
        if (action === "close") {
          await service.withTicketActionLock(ticket.id, () =>
            service.close(interaction, ticket, { reply: false, closedBy: interaction.user.id }),
          );
          await interaction.followUp({
            ...buildActionResult("Ticket Closed", "This ticket has been closed by <@" + interaction.user.id + ">."),
            flags: MessageFlags.Ephemeral,
          }).catch(() => null);
          return;
        }

        await service.withTicketActionLock(ticket.id, () => service.delete(interaction, ticket));
        await interaction.followUp({
          ...buildActionResult("Ticket Deleted", "This ticket has been permanently deleted."),
          flags: MessageFlags.Ephemeral,
        }).catch(() => null);
      } catch (error) {
        const normalized = normalizeError(error);
        logInteractionError(interaction, normalized, error);
        await interaction.followUp({
          ...buildErrorResult(normalized),
          flags: MessageFlags.Ephemeral,
        }).catch(() => null);
      }
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("evix:t:")) {
      const match = interaction.customId.match(/^evix:t:(\d+):(claim|unclaim|close|reopen|transcript|delete|info|waiting)$/);
      if (!match) throw new Error("Invalid ticket control.");
      const [, ticketId, action] = match;

      // Resume updates the public ticket control message itself, so acknowledge it as
      // a component update. The lookup still happens only after the immediate ACK.
      if (action === "waiting") {
        await interaction.deferUpdate();
      } else {
        const ephemeralActions = new Set(["close", "delete", "transcript"]);
        await interaction.deferReply({
          flags: ephemeralActions.has(action) ? MessageFlags.Ephemeral : 0,
        });
      }

      const ticket = await service.getTicket(interaction, ticketId);
      const ownerAllowed = ticket.owner_id === interaction.user.id && ["close", "info"].includes(action);
      if (!service.canManageTicket(interaction.member, ticket) && !ownerAllowed) throw new Error("You are not authorized to use this ticket control.");

      if (action === "close") return await service.requestClose(interaction, ticket);
      if (action === "delete") return await service.requestDelete(interaction, ticket);
      if (action === "info") return await service.info(interaction, ticket);

      const mutate = (callback) => service.withTicketActionLock(ticket.id, callback);
      switch (action) {
        case "claim": return await mutate(() => service.claim(interaction, ticket));
        case "unclaim": return await mutate(() => service.unclaim(interaction, ticket));
        case "waiting":
          return await mutate(() => ticket.status === "waiting"
            ? service.resume(interaction, ticket)
            : service.waiting(interaction, ticket));
        case "reopen": return await mutate(() => service.reopen(interaction, ticket));
        case "transcript": return await service.sendTranscript(interaction, ticket);
        default: throw new Error("Unsupported ticket control.");
      }
    }


  } catch (error) {
    const normalized = normalizeError(error);
    logInteractionError(interaction, normalized, error);
    if (interaction.isAutocomplete()) {
      await interaction.respond([]).catch(() => null);
      return;
    }
    const publicTicketStateButton = interaction.isButton?.()
      && /^evix:t:\d+:waiting$/.test(interaction.customId || "");
    if (publicTicketStateButton && (interaction.deferred || interaction.replied)) {
      await interaction.followUp({
        ...buildErrorResult(normalized),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      }).catch(() => null);
      return;
    }
    await replySafely(interaction, buildErrorResult(normalized)).catch(() => null);
  }
}
