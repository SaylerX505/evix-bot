import {
  ChannelType,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import {
  addPanelOption,
  createPanel,
  deletePanel,
  deletePanelOption,
  getGuildSettings,
  getPanel,
  getPanelOption,
  listPanelOptions,
  listPanels,
  resetPanel,
  updatePanel,
  updatePanelOption,
  upsertGuildSettings,
} from "./db.js";
import {
  assertPanelOptions,
  parseRoleMentions,
  unique,
  validateModalFields,
} from "./utils.js";
import { beginPanelStudio } from "./panels.js";

const ADMIN = PermissionFlagsBits.ManageGuild;

const channelOption = (option, name, description, types) =>
  option
    .setName(name)
    .setDescription(description)
    .addChannelTypes(...types);

const ticketCommand = new SlashCommandBuilder()
  .setName("ticket")
  .setDescription("Manage Evix tickets")
  .addSubcommand((s) => s.setName("info").setDescription("Show the current ticket information"))
  .addSubcommand((s) => s.setName("transcript").setDescription("Generate a transcript for the current ticket"))
  .addSubcommand((s) => s.setName("close").setDescription("Close the current ticket"))
  .addSubcommand((s) => s.setName("reopen").setDescription("Reopen the current ticket"))
  .addSubcommand((s) => s.setName("claim").setDescription("Claim the current ticket"))
  .addSubcommand((s) => s.setName("unclaim").setDescription("Unclaim the current ticket"))
  .addSubcommand((s) => s.setName("waiting").setDescription("Move the ticket to waiting or resume it"))
  .addSubcommand((s) => s.setName("add").setDescription("Add a member to the current ticket")
    .addUserOption((o) => o.setName("user").setDescription("Member to add").setRequired(true)))
  .addSubcommand((s) => s.setName("remove").setDescription("Remove a member from the current ticket")
    .addUserOption((o) => o.setName("user").setDescription("Member to remove").setRequired(true)))
  .addSubcommand((s) => s.setName("rename").setDescription("Rename the current ticket")
    .addStringOption((o) => o.setName("name").setDescription("New channel name").setRequired(true).setMaxLength(90)))
  .addSubcommand((s) => s.setName("lock").setDescription("Lock the current ticket"))
  .addSubcommand((s) => s.setName("unlock").setDescription("Unlock the current ticket"))
  .addSubcommand((s) => s.setName("delete").setDescription("Delete the current ticket"))
  .addSubcommand((s) => s.setName("setup").setDescription("Configure ticket categories")
    .addChannelOption((o) => channelOption(o, "tickets_category", "Main ticket category", [ChannelType.GuildCategory]).setRequired(true))
    .addChannelOption((o) => channelOption(o, "backup_category", "Optional backup ticket category", [ChannelType.GuildCategory]))
    .addChannelOption((o) => channelOption(o, "waiting_category", "Optional waiting ticket category", [ChannelType.GuildCategory]))
    .addChannelOption((o) => channelOption(o, "closed_category", "Optional closed ticket category", [ChannelType.GuildCategory]))
    .addIntegerOption((o) => o.setName("ticket_limit").setDescription("Open or waiting tickets per member").setMinValue(1).setMaxValue(25)))
  .addSubcommand((s) => s.setName("config").setDescription("View ticket configuration"))
  .addSubcommand((s) => s.setName("logs").setDescription("Configure ticket logs")
    .addChannelOption((o) => channelOption(o, "ticket_channel", "Ticket lifecycle log channel", [ChannelType.GuildText]))
    .addChannelOption((o) => channelOption(o, "moderation_channel", "Moderation log channel", [ChannelType.GuildText]))
    .addChannelOption((o) => channelOption(o, "transcript_channel", "Transcript log channel", [ChannelType.GuildText]))
    .addBooleanOption((o) => o.setName("disable_ticket").setDescription("Disable ticket lifecycle logs"))
    .addBooleanOption((o) => o.setName("disable_moderation").setDescription("Disable moderation logs"))
    .addBooleanOption((o) => o.setName("disable_transcript").setDescription("Disable transcript logs")))
  .setDMPermission(false);

const panelCommand = new SlashCommandBuilder()
  .setName("panel")
  .setDescription("Manage Evix ticket panels")
  .addSubcommand((s) => s.setName("create").setDescription("Create a ready-to-edit ticket panel")
    .addStringOption((o) => o.setName("name").setDescription("Panel name").setRequired(true).setMinLength(1).setMaxLength(40)))
  .addSubcommand((s) => s.setName("edit").setDescription("Open the panel studio")
    .addStringOption((o) => o.setName("panel").setDescription("Panel name or ID").setRequired(true)))
  .addSubcommand((s) => s.setName("list").setDescription("List ticket panels"))
  .addSubcommand((s) => s.setName("send").setDescription("Send a ticket panel")
    .addStringOption((o) => o.setName("panel").setDescription("Panel name or ID").setRequired(true))
    .addChannelOption((o) => channelOption(o, "channel", "Destination text channel", [ChannelType.GuildText]).setRequired(true)))
  .addSubcommand((s) => s.setName("reset").setDescription("Reset a panel to its ready default")
    .addStringOption((o) => o.setName("panel").setDescription("Panel name or ID").setRequired(true)))
  .addSubcommand((s) => s.setName("delete").setDescription("Delete a ticket panel")
    .addStringOption((o) => o.setName("panel").setDescription("Panel name or ID").setRequired(true)))
  .addSubcommand((s) => s.setName("option-add").setDescription("Add a ticket option to a panel")
    .addStringOption((o) => o.setName("panel").setDescription("Panel name or ID").setRequired(true))
    .addStringOption((o) => o.setName("name").setDescription("Dropdown option name").setRequired(true).setMaxLength(80))
    .addStringOption((o) => o.setName("description").setDescription("Optional dropdown description").setMaxLength(100))
    .addStringOption((o) => o.setName("emoji").setDescription("Optional emoji"))
    .addChannelOption((o) => channelOption(o, "category", "Optional category override", [ChannelType.GuildCategory]))
    .addChannelOption((o) => channelOption(o, "closed_category", "Optional closed-category override", [ChannelType.GuildCategory]))
    .addStringOption((o) => o.setName("staff_roles").setDescription("Optional role mentions separated by spaces"))
    .addStringOption((o) => o.setName("ping_roles").setDescription("Optional role mentions separated by spaces"))
    .addStringOption((o) => o.setName("welcome").setDescription("Optional welcome text").setMaxLength(4000))
    .addStringOption((o) => o.setName("name_template").setDescription("Optional ticket channel template").setMaxLength(90))
    .addStringOption((o) => o.setName("close_behavior").setDescription("Optional close routing behavior")
      .addChoices({ name: "Move", value: "move" }, { name: "Stay", value: "stay" }))
    .addStringOption((o) => o.setName("form").setDescription("Optional JSON modal fields").setMaxLength(4000))
    .addBooleanOption((o) => o.setName("allow_multiple").setDescription("Allow multiple active tickets of this option"))
    .addBooleanOption((o) => o.setName("transcript_on_close").setDescription("Create a transcript on close")))
  .addSubcommand((s) => s.setName("option-edit").setDescription("Edit a ticket option")
    .addStringOption((o) => o.setName("panel").setDescription("Panel name or ID").setRequired(true))
    .addStringOption((o) => o.setName("option").setDescription("Option ID").setRequired(true))
    .addStringOption((o) => o.setName("name").setDescription("Dropdown option name").setMaxLength(80))
    .addStringOption((o) => o.setName("description").setDescription("Dropdown description; use - to clear").setMaxLength(100))
    .addStringOption((o) => o.setName("emoji").setDescription("Emoji; use - to clear"))
    .addChannelOption((o) => channelOption(o, "category", "Optional category override", [ChannelType.GuildCategory]))
    .addChannelOption((o) => channelOption(o, "closed_category", "Optional closed-category override", [ChannelType.GuildCategory]))
    .addStringOption((o) => o.setName("staff_roles").setDescription("Role mentions separated by spaces; use - to clear"))
    .addStringOption((o) => o.setName("ping_roles").setDescription("Role mentions separated by spaces; use - to clear"))
    .addStringOption((o) => o.setName("welcome").setDescription("Welcome text; use - to clear").setMaxLength(4000))
    .addStringOption((o) => o.setName("name_template").setDescription("Channel template; use - to restore default").setMaxLength(90))
    .addStringOption((o) => o.setName("close_behavior").setDescription("Close routing behavior")
      .addChoices({ name: "Move", value: "move" }, { name: "Stay", value: "stay" }))
    .addStringOption((o) => o.setName("form").setDescription("Modal fields JSON; use [] to clear").setMaxLength(4000))
    .addBooleanOption((o) => o.setName("allow_multiple").setDescription("Allow multiple active tickets"))
    .addBooleanOption((o) => o.setName("transcript_on_close").setDescription("Create a transcript on close")))
  .addSubcommand((s) => s.setName("option-remove").setDescription("Remove a ticket option")
    .addStringOption((o) => o.setName("panel").setDescription("Panel name or ID").setRequired(true))
    .addStringOption((o) => o.setName("option").setDescription("Option ID").setRequired(true)))
  .setDMPermission(false);

export const commands = [ticketCommand, panelCommand];

function ephemeral(content) {
  return { content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };
}

async function validateConfiguredRoles(guild, roleIds) {
  for (const roleId of unique(roleIds)) {
    const role = await guild.roles.fetch(roleId).catch(() => null);
    if (!role) throw new Error("Configured role " + roleId + " was not found in this server.");
  }
}

function parseFormInput(raw) {
  if (raw === null) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("The form option must be valid JSON.");
  }
  return validateModalFields(parsed);
}

function clearable(value, fallback = null) {
  if (value === null) return undefined;
  if (value === "-") return fallback;
  return value;
}

async function refreshPanelMessage(guild, panel, ui) {
  if (!panel?.channel_id || !panel?.message_id) return;
  const channel = await guild.channels.fetch(panel.channel_id).catch(() => null);
  const message = await channel?.messages.fetch(panel.message_id).catch(() => null);
  if (!message) {
    await updatePanel(panel.id, { channel_id: null, message_id: null }).catch(() => null);
    return;
  }
  try {
    await message.edit(ui.buildPanelMessage(panel, guild.client.user));
  } catch (error) {
    console.error("[evix-panel-refresh-error]", error);
  }
}

async function removeStoredPanelMessage(guild, panel) {
  if (!panel?.channel_id || !panel?.message_id) return;
  const channel = await guild.channels.fetch(panel.channel_id).catch(() => null);
  const message = await channel?.messages.fetch(panel.message_id).catch(() => null);
  await message?.delete("Evix panel removed").catch(() => null);
}

export async function handleTicketCommand(interaction, service, ui) {
  const sub = interaction.options.getSubcommand();

  if (["setup", "config", "logs"].includes(sub) && !interaction.memberPermissions?.has(ADMIN)) {
    throw new Error("You need Manage Server to use this command.");
  }

  if (sub === "setup") {
    const current = await getGuildSettings(interaction.guildId) ?? {};
    const ticketsCategory = interaction.options.getChannel("tickets_category", true);
    const saved = await upsertGuildSettings(interaction.guildId, {
      ticket_category_id: ticketsCategory.id,
      open_category_id: ticketsCategory.id,
      backup_category_id: interaction.options.getChannel("backup_category")?.id ?? current.backup_category_id ?? null,
      waiting_category_id: interaction.options.getChannel("waiting_category")?.id ?? current.waiting_category_id ?? null,
      closed_category_id: interaction.options.getChannel("closed_category")?.id ?? current.closed_category_id ?? null,
      default_ticket_limit: interaction.options.getInteger("ticket_limit") ?? current.default_ticket_limit ?? 1,
    });
    return interaction.reply({
      ...ui.buildSetupSummary(saved),
      flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
    });
  }

  if (sub === "config") {
    const settings = await getGuildSettings(interaction.guildId);
    const panels = await listPanels(interaction.guildId);
    return interaction.reply({
      ...ui.buildSetupSummary(settings),
      content: "Panels configured: " + panels.length,
      flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
    });
  }

  if (sub === "logs") {
    const current = await getGuildSettings(interaction.guildId) ?? {};
    const ticketChannel = interaction.options.getChannel("ticket_channel");
    const moderationChannel = interaction.options.getChannel("moderation_channel");
    const transcriptChannel = interaction.options.getChannel("transcript_channel");
    const disableTicket = interaction.options.getBoolean("disable_ticket") === true;
    const disableModeration = interaction.options.getBoolean("disable_moderation") === true;
    const disableTranscript = interaction.options.getBoolean("disable_transcript") === true;

    if (disableTicket && ticketChannel) throw new Error("Choose either a ticket log channel or disable ticket logs.");
    if (disableModeration && moderationChannel) throw new Error("Choose either a moderation log channel or disable moderation logs.");
    if (disableTranscript && transcriptChannel) throw new Error("Choose either a transcript log channel or disable transcript logs.");

    const saved = await upsertGuildSettings(interaction.guildId, {
      ticket_log_channel_id: disableTicket ? null : (ticketChannel?.id ?? current.ticket_log_channel_id ?? current.log_channel_id ?? null),
      moderation_log_channel_id: disableModeration ? null : (moderationChannel?.id ?? current.moderation_log_channel_id ?? null),
      transcript_log_channel_id: disableTranscript ? (current.transcript_log_channel_id ?? current.transcript_channel_id ?? null) : (transcriptChannel?.id ?? current.transcript_log_channel_id ?? current.transcript_channel_id ?? null),
      ticket_logs_enabled: disableTicket ? false : (ticketChannel ? true : (current.ticket_logs_enabled !== false)),
      moderation_logs_enabled: disableModeration ? false : (moderationChannel ? true : (current.moderation_logs_enabled !== false)),
      transcript_logs_enabled: disableTranscript ? false : (transcriptChannel ? true : (current.transcript_logs_enabled !== false)),
      log_channel_id: disableTicket ? (current.log_channel_id ?? current.ticket_log_channel_id ?? null) : (ticketChannel?.id ?? current.log_channel_id ?? current.ticket_log_channel_id ?? null),
      transcript_channel_id: disableTranscript ? (current.transcript_channel_id ?? current.transcript_log_channel_id ?? null) : (transcriptChannel?.id ?? current.transcript_channel_id ?? current.transcript_log_channel_id ?? null),
    });

    return interaction.reply(ephemeral(
      [
        "Ticket logs: " + (saved.ticket_log_channel_id ? "<#" + saved.ticket_log_channel_id + ">" : "off"),
        "Moderation logs: " + (saved.moderation_log_channel_id ? "<#" + saved.moderation_log_channel_id + ">" : "off"),
        "Transcript logs: " + (saved.transcript_log_channel_id ? "<#" + saved.transcript_log_channel_id + ">" : "off"),
      ].join("\n"),
    ));
  }

  const ticket = await service.getTicket(interaction);
  switch (sub) {
    case "info": return service.info(interaction, ticket);
    case "transcript": return service.sendTranscript(interaction, ticket);
    case "close": return service.close(interaction, ticket);
    case "reopen": return service.reopen(interaction, ticket);
    case "claim": return service.claim(interaction, ticket);
    case "unclaim": return service.unclaim(interaction, ticket);
    case "waiting": return service.waiting(interaction, ticket);
    case "add": return service.addMember(interaction, ticket, interaction.options.getUser("user", true).id);
    case "remove": return service.removeMember(interaction, ticket, interaction.options.getUser("user", true).id);
    case "rename": return service.rename(interaction, ticket, interaction.options.getString("name", true));
    case "lock": return service.lock(interaction, ticket);
    case "unlock": return service.unlock(interaction, ticket);
    case "delete": return service.requestDelete(interaction, ticket);
    default: throw new Error("Unknown ticket subcommand.");
  }
}

async function handlePanelList(interaction) {
  const panels = await listPanels(interaction.guildId);
  const { ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize } = await import("discord.js");
  const lines = panels.length
    ? panels.map((panel) => "**" + panel.name + "** · ID " + panel.id).join("\n")
    : "No panels created yet. Use /panel create.";
  const container = new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("# Evix Panels"),
      new TextDisplayBuilder().setContent(lines),
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
    )
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("-# Evix 1.0.2"));
  return interaction.reply({
    components: [container],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

export async function handlePanelCommand(interaction, ui) {
  if (!interaction.memberPermissions?.has(ADMIN)) {
    throw new Error("You need Manage Server to manage ticket panels.");
  }

  const sub = interaction.options.getSubcommand();

  if (sub === "list") return handlePanelList(interaction, ui);

  const panelInput = interaction.options.getString("panel", false);
  if (sub === "create") {
    const panel = await createPanel({
      guildId: interaction.guildId,
      name: interaction.options.getString("name", true),
      title: "",
      description: "",
      footer: "",
      imageUrl: null,
      placeholder: "",
      accentColor: 0x5865f2,
      footerShowBot: false,
      withDefaultOption: true,
    });
    return beginPanelStudio(interaction, panel);
  }

  const panel = await getPanel(interaction.guildId, panelInput);
  if (!panel) throw new Error("Panel not found.");

  if (sub === "edit") return beginPanelStudio(interaction, panel);

  if (sub === "send") {
    assertPanelOptions(panel.options);
    const channel = interaction.options.getChannel("channel", true);
    const previous = { channel_id: panel.channel_id, message_id: panel.message_id };
    const message = await channel.send(ui.buildPanelMessage(panel, interaction.client.user));
    try {
      await updatePanel(panel.id, { channel_id: channel.id, message_id: message.id });
    } catch (error) {
      await message.delete("Evix panel pointer update failed").catch(() => null);
      throw error;
    }
    if (previous.message_id && previous.message_id !== message.id) {
      await removeStoredPanelMessage(interaction.guild, previous);
    }
    return interaction.reply(ephemeral("Panel sent to <#" + channel.id + ">."));
  }

  if (sub === "reset") {
    const previous = { channel_id: panel.channel_id, message_id: panel.message_id };
    const reset = await resetPanel(panel.id);
    if (previous.message_id) await removeStoredPanelMessage(interaction.guild, previous);
    return interaction.reply(ephemeral("Panel " + reset.name + " was reset to its ready default."));
  }

  if (sub === "delete") {
    const previous = { channel_id: panel.channel_id, message_id: panel.message_id };
    await deletePanel(panel.id);
    if (previous.message_id) await removeStoredPanelMessage(interaction.guild, previous);
    return interaction.reply(ephemeral("Panel " + panel.name + " deleted."));
  }

  const optionInput = interaction.options.getString("option", true);
  let optionId;
  try {
    optionId = BigInt(optionInput);
  } catch {
    throw new Error("Option ID must be a valid numeric ID.");
  }

  const target = await getPanelOption(optionId, interaction.guildId);
  if (!target || String(target.panel_id) !== String(panel.id)) {
    throw new Error("Panel option not found.");
  }

  if (sub === "option-remove") {
    await deletePanelOption(optionId);
    const refreshed = await getPanel(interaction.guildId, panel.id);
    if (refreshed?.options?.length) {
      await refreshPanelMessage(interaction.guild, refreshed, ui);
    } else {
      await removeStoredPanelMessage(interaction.guild, panel);
      if (refreshed) await updatePanel(refreshed.id, { channel_id: null, message_id: null });
    }
    return interaction.reply(ephemeral("Ticket option removed."));
  }

  const defaults = await getGuildSettings(interaction.guildId);
  const description = interaction.options.getString("description");
  const emoji = interaction.options.getString("emoji");
  const category = interaction.options.getChannel("category");
  const closedCategory = interaction.options.getChannel("closed_category");
  const staffRolesInput = interaction.options.getString("staff_roles");
  const pingRolesInput = interaction.options.getString("ping_roles");
  const welcome = interaction.options.getString("welcome");
  const nameTemplate = interaction.options.getString("name_template");
  const closeBehavior = interaction.options.getString("close_behavior");
  const formInput = interaction.options.getString("form");
  const allowMultiple = interaction.options.getBoolean("allow_multiple");
  const transcriptOnClose = interaction.options.getBoolean("transcript_on_close");

  if (sub === "option-add") {
    const label = interaction.options.getString("name", true);
    const staffRoles = unique(parseRoleMentions(staffRolesInput || ""));
    const pingRoles = unique(parseRoleMentions(pingRolesInput || ""));
    await validateConfiguredRoles(interaction.guild, [...staffRoles, ...pingRoles]);

    const options = await listPanelOptions(panel.id);
    const option = await addPanelOption({
      panelId: panel.id,
      position: options.length,
      label,
      description,
      emoji,
      categoryId: category?.id ?? null,
      closedCategoryId: closedCategory?.id ?? null,
      staffRoles,
      pingRoles,
      welcomeMessage: welcome ?? "",
      ticketNameTemplate: nameTemplate || "ticket-{number}",
      closeBehavior: closeBehavior || "move",
      allowMultiple: allowMultiple === true,
      transcriptOnClose: transcriptOnClose !== false,
      modalFields: parseFormInput(formInput),
    });

    const refreshed = await getPanel(interaction.guildId, panel.id);
    await refreshPanelMessage(interaction.guild, refreshed, ui);
    return interaction.reply(ephemeral("Ticket option " + option.label + " created. ID " + option.id + "."));
  }

  if (sub === "option-edit") {
    const patch = {};
    const name = interaction.options.getString("name");
    if (name !== null) patch.label = name;
    if (description !== null) patch.description = description === "-" ? null : description;
    if (emoji !== null) patch.emoji = emoji === "-" ? null : emoji;
    if (category) patch.category_id = category.id;
    if (closedCategory) patch.closed_category_id = closedCategory.id;
    if (staffRolesInput !== null) {
      const roles = unique(parseRoleMentions(staffRolesInput));
      await validateConfiguredRoles(interaction.guild, roles);
      patch.staff_roles = roles;
    }
    if (pingRolesInput !== null) {
      const roles = unique(parseRoleMentions(pingRolesInput));
      await validateConfiguredRoles(interaction.guild, roles);
      patch.ping_roles = roles;
    }
    if (welcome !== null) patch.welcome_message = welcome === "-" ? "" : welcome;
    if (nameTemplate !== null) patch.ticket_name_template = nameTemplate === "-" ? "ticket-{number}" : nameTemplate;
    if (closeBehavior !== null) patch.close_behavior = closeBehavior;
    if (formInput !== null) patch.modal_fields = parseFormInput(formInput);
    if (allowMultiple !== null) patch.allow_multiple = allowMultiple;
    if (transcriptOnClose !== null) patch.transcript_on_close = transcriptOnClose;

    const updated = Object.keys(patch).length ? await updatePanelOption(optionId, patch) : target;
    const refreshed = await getPanel(interaction.guildId, panel.id);
    await refreshPanelMessage(interaction.guild, refreshed, ui);
    return interaction.reply(ephemeral("Ticket option " + updated.label + " updated."));
  }

  throw new Error("Unknown panel action.");
}

export function buildAddUserModal(ticketId) {
  const input = new TextInputBuilder()
    .setCustomId("user")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("<@123456789012345678>")
    .setRequired(true)
    .setMaxLength(30);
  return new ModalBuilder()
    .setCustomId("evix:add-user:" + ticketId)
    .setTitle("Add user to ticket")
    .addLabelComponents(new LabelBuilder().setLabel("User ID or mention").setTextInputComponent(input));
}

export function buildRenameModal(ticketId) {
  const input = new TextInputBuilder()
    .setCustomId("name")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("billing-help")
    .setRequired(true)
    .setMaxLength(90);
  return new ModalBuilder()
    .setCustomId("evix:rename:" + ticketId)
    .setTitle("Rename ticket")
    .addLabelComponents(new LabelBuilder().setLabel("New ticket name").setTextInputComponent(input));
}

export function buildTicketModal(option) {
  const fields = validateModalFields(option.modal_fields);
  if (!fields.length) return null;
  const modal = new ModalBuilder()
    .setCustomId("evix:modal:" + option.id)
    .setTitle(String(option.label || "Ticket").slice(0, 45));
  for (const field of fields) {
    const input = new TextInputBuilder()
      .setCustomId(field.id)
      .setStyle(field.style === "paragraph" ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(field.required);
    if (field.placeholder) input.setPlaceholder(field.placeholder);
    modal.addLabelComponents(new LabelBuilder().setLabel(field.label).setTextInputComponent(input));
  }
  return modal;
}
