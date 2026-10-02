import {
  ChannelType,
  ContainerBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SeparatorBuilder,
  SeparatorSpacingSize,
  SlashCommandBuilder,
  TextDisplayBuilder,
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
import { assertPanelOptions, truncate, unique, validateModalFields } from "./utils.js";
import { beginPanelStudio } from "./panels.js";

const ADMIN = PermissionFlagsBits.ManageGuild;
const channelOption = (option, name, description, types) => option.setName(name).setDescription(description).addChannelTypes(...types);

const ticketCommand = new SlashCommandBuilder()
  .setName("ticket")
  .setDescription("Manage Evix tickets")
  .addSubcommand((s) => s.setName("info").setDescription("Show the current ticket information"))
  .addSubcommand((s) => s.setName("transcript").setDescription("Generate a transcript for the current ticket"))
  .addSubcommand((s) => s.setName("close").setDescription("Close the current ticket"))
  .addSubcommand((s) => s.setName("reopen").setDescription("Reopen the current ticket"))
  .addSubcommand((s) => s.setName("claim").setDescription("Claim the current ticket"))
  .addSubcommand((s) => s.setName("unclaim").setDescription("Unclaim the current ticket"))
  .addSubcommand((s) => s.setName("add").setDescription("Add a user or role to the current ticket")
    .addUserOption((o) => o.setName("user").setDescription("Member to add"))
    .addRoleOption((o) => o.setName("role").setDescription("Role to add")))
  .addSubcommand((s) => s.setName("remove").setDescription("Remove a member from the current ticket")
    .addUserOption((o) => o.setName("user").setDescription("Member to remove").setRequired(true)))
  .addSubcommand((s) => s.setName("rename").setDescription("Rename the current ticket")
    .addStringOption((o) => o.setName("name").setDescription("New channel name").setRequired(true).setMaxLength(90)))
  .addSubcommand((s) => s.setName("delete").setDescription("Delete the current ticket"))
  .addSubcommand((s) => s.setName("setup").setDescription("Configure ticket categories")
    .addChannelOption((o) => channelOption(o, "tickets_category", "Main ticket category", [ChannelType.GuildCategory]).setRequired(true))
    .addChannelOption((o) => channelOption(o, "backup_category", "Optional backup ticket category", [ChannelType.GuildCategory]))
    .addChannelOption((o) => channelOption(o, "closed_category", "Optional closed ticket category", [ChannelType.GuildCategory]))
    .addBooleanOption((o) => o.setName("clear_backup_category").setDescription("Clear the configured backup category"))
    .addBooleanOption((o) => o.setName("clear_closed_category").setDescription("Clear the configured closed category"))
    .addIntegerOption((o) => o.setName("ticket_limit").setDescription("Open tickets per member").setMinValue(1).setMaxValue(25)))
  .addSubcommand((s) => s.setName("config").setDescription("View ticket configuration"))
  .addSubcommand((s) => s.setName("logs").setDescription("Configure ticket logs")
    .addChannelOption((o) => channelOption(o, "ticket_channel", "Ticket lifecycle log channel", [ChannelType.GuildText]))
    .addChannelOption((o) => channelOption(o, "moderation_channel", "Moderation log channel", [ChannelType.GuildText]))
    .addChannelOption((o) => channelOption(o, "transcript_channel", "Transcript log channel", [ChannelType.GuildText]))
    .addBooleanOption((o) => o.setName("clear_moderation_channel").setDescription("Use ticket log as moderation fallback"))
    .addBooleanOption((o) => o.setName("clear_transcript_channel").setDescription("Use ticket log as transcript fallback"))
    .addBooleanOption((o) => o.setName("disable_ticket").setDescription("Disable ticket lifecycle logs"))
    .addBooleanOption((o) => o.setName("disable_moderation").setDescription("Disable moderation logs"))
    .addBooleanOption((o) => o.setName("disable_transcript").setDescription("Disable transcript logs")))
  .setDMPermission(false);

const panelCommand = new SlashCommandBuilder()
  .setName("panel").setDescription("Manage Evix ticket panels")
  .addSubcommand((s) => s.setName("create").setDescription("Create a ready-to-edit ticket panel").addStringOption((o) => o.setName("name").setDescription("Panel name").setRequired(true).setMinLength(1).setMaxLength(40)))
  .addSubcommand((s) => s.setName("edit").setDescription("Open the panel studio").addStringOption((o) => o.setName("panel").setDescription("Select a panel").setRequired(true).setAutocomplete(true)))
  .addSubcommand((s) => s.setName("list").setDescription("List ticket panels"))
  .addSubcommand((s) => s.setName("send").setDescription("Send a ticket panel").addStringOption((o) => o.setName("panel").setDescription("Select a panel").setRequired(true).setAutocomplete(true)).addChannelOption((o) => channelOption(o, "channel", "Destination text channel", [ChannelType.GuildText]).setRequired(true)))
  .addSubcommand((s) => s.setName("reset").setDescription("Reset a panel to its ready default").addStringOption((o) => o.setName("panel").setDescription("Select a panel").setRequired(true).setAutocomplete(true)))
  .addSubcommand((s) => s.setName("delete").setDescription("Delete a ticket panel").addStringOption((o) => o.setName("panel").setDescription("Select a panel").setRequired(true).setAutocomplete(true)))
  .addSubcommand((s) => s.setName("option-add").setDescription("Add a ticket option to a panel")
    .addStringOption((o) => o.setName("panel").setDescription("Select a panel").setRequired(true).setAutocomplete(true))
    .addStringOption((o) => o.setName("name").setDescription("Dropdown option name").setRequired(true).setMinLength(1).setMaxLength(80))
    .addStringOption((o) => o.setName("action").setDescription("What should happen when selected").setRequired(true).addChoices({ name: "Create ticket", value: "CREATE_TICKET" }, { name: "Nothing", value: "NOTHING" }))
    .addStringOption((o) => o.setName("description").setDescription("Optional dropdown description").setMaxLength(100))
    .addStringOption((o) => o.setName("emoji").setDescription("Optional emoji"))
    .addChannelOption((o) => channelOption(o, "category", "Optional category override", [ChannelType.GuildCategory]))
    .addChannelOption((o) => channelOption(o, "closed_category", "Optional closed-category override", [ChannelType.GuildCategory]))
    .addRoleOption((o) => o.setName("staff_roles").setDescription("Optional staff role"))
    .addRoleOption((o) => o.setName("ping_roles").setDescription("Optional role to ping when a ticket is created"))
    .addStringOption((o) => o.setName("close_behavior").setDescription("Optional close routing behavior").addChoices({ name: "Move", value: "move" }, { name: "Stay", value: "stay" }))
    .addBooleanOption((o) => o.setName("allow_multiple").setDescription("Allow multiple active tickets of this option")))
  .addSubcommand((s) => s.setName("option-edit").setDescription("Edit a ticket option")
    .addStringOption((o) => o.setName("panel").setDescription("Select a panel").setRequired(true).setAutocomplete(true))
    .addStringOption((o) => o.setName("option").setDescription("Select an option").setRequired(true).setAutocomplete(true))
    .addStringOption((o) => o.setName("name").setDescription("Dropdown option name").setMinLength(1).setMaxLength(80))
    .addStringOption((o) => o.setName("description").setDescription("Dropdown description; use - to clear").setMaxLength(100))
    .addStringOption((o) => o.setName("emoji").setDescription("Emoji; use - to clear"))
    .addChannelOption((o) => channelOption(o, "category", "Optional category override", [ChannelType.GuildCategory]))
    .addChannelOption((o) => channelOption(o, "closed_category", "Optional closed-category override", [ChannelType.GuildCategory]))
    .addBooleanOption((o) => o.setName("clear_category").setDescription("Use the global ticket category"))
    .addBooleanOption((o) => o.setName("clear_closed_category").setDescription("Use the global closed category"))
    .addRoleOption((o) => o.setName("staff_roles").setDescription("Select staff role to set"))
    .addRoleOption((o) => o.setName("ping_roles").setDescription("Select role to ping when a ticket is created"))
    .addBooleanOption((o) => o.setName("clear_staff_roles").setDescription("Clear the configured staff role"))
    .addBooleanOption((o) => o.setName("clear_ping_roles").setDescription("Clear the configured ping role"))
    .addStringOption((o) => o.setName("close_behavior").setDescription("Close routing behavior").addChoices({ name: "Move", value: "move" }, { name: "Stay", value: "stay" }))
    .addBooleanOption((o) => o.setName("allow_multiple").setDescription("Allow multiple active tickets"))
    .addStringOption((o) => o.setName("action").setDescription("What should happen when selected").addChoices({ name: "Create ticket", value: "CREATE_TICKET" }, { name: "Nothing", value: "NOTHING" })))
  .addSubcommand((s) => s.setName("option-remove").setDescription("Remove a ticket option").addStringOption((o) => o.setName("panel").setDescription("Select a panel").setRequired(true).setAutocomplete(true)).addStringOption((o) => o.setName("option").setDescription("Select an option").setRequired(true).setAutocomplete(true)))
  .setDMPermission(false);

export const commands = [ticketCommand, panelCommand];

function ephemeral(content) { return { content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }; }
async function respond(interaction, payload) { return interaction.deferred || interaction.replied ? interaction.editReply(payload) : interaction.reply(payload); }
async function validateConfiguredRoles(guild, roleIds) {
  for (const roleId of unique(roleIds)) {
    const role = await guild.roles.fetch(roleId).catch(() => null);
    if (!role) throw new Error("Configured role " + roleId + " was not found in this server.");
    if (role.id === guild.id) throw new Error("The @everyone role cannot be used as a staff or ping role.");
  }
}
async function refreshPanelMessage(guild, panel, ui) {
  if (!panel?.channel_id || !panel?.message_id) return;
  const channel = await guild.channels.fetch(panel.channel_id).catch(() => null);
  const message = await channel?.messages.fetch(panel.message_id).catch(() => null);
  if (!message) { await updatePanel(panel.id, { channel_id: null, message_id: null }).catch(() => null); return; }
  await message.edit(ui.buildPanelMessage(panel, guild.client.user)).catch((error) => console.error("[evix-panel-refresh-error]", error));
}
async function removeStoredPanelMessage(guild, panel) {
  if (!panel?.channel_id || !panel?.message_id) return;
  const channel = await guild.channels.fetch(panel.channel_id).catch(() => null);
  const message = await channel?.messages.fetch(panel.message_id).catch(() => null);
  await message?.delete("Evix panel removed").catch(() => null);
}

export async function handleTicketCommand(interaction, service, ui) {
  const sub = interaction.options.getSubcommand();
  if (["setup", "config", "logs"].includes(sub) && !interaction.memberPermissions?.has(ADMIN)) throw new Error("You need Manage Server to use this command.");

  if (sub === "setup") {
    const ticketsCategory = interaction.options.getChannel("tickets_category", true);
    const backupCategory = interaction.options.getChannel("backup_category");
    const closedCategory = interaction.options.getChannel("closed_category");
    const clearBackup = interaction.options.getBoolean("clear_backup_category") === true;
    const clearClosed = interaction.options.getBoolean("clear_closed_category") === true;
    if (backupCategory && clearBackup) throw new Error("Choose either a backup category or clear backup category.");
    if (closedCategory && clearClosed) throw new Error("Choose either a closed category or clear closed category.");

    const patch = {
      ticket_category_id: ticketsCategory.id,
      default_ticket_limit: interaction.options.getInteger("ticket_limit") ?? undefined,
    };
    if (clearBackup) patch.backup_category_id = null;
    else if (backupCategory) patch.backup_category_id = backupCategory.id;
    if (clearClosed) patch.closed_category_id = null;
    else if (closedCategory) patch.closed_category_id = closedCategory.id;

    const saved = await upsertGuildSettings(interaction.guildId, patch);
    return respond(interaction, { ...ui.buildSetupSummary(saved), flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 });
  }
  if (sub === "config") {
    const settings = await getGuildSettings(interaction.guildId);
    const panels = await listPanels(interaction.guildId);
    return respond(interaction, { ...ui.buildSetupSummary({ ...(settings ?? {}), panels_count: panels.length }), flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 });
  }
  if (sub === "logs") {
    const ticketChannel = interaction.options.getChannel("ticket_channel");
    const moderationChannel = interaction.options.getChannel("moderation_channel");
    const transcriptChannel = interaction.options.getChannel("transcript_channel");
    const clearModeration = interaction.options.getBoolean("clear_moderation_channel") === true;
    const clearTranscript = interaction.options.getBoolean("clear_transcript_channel") === true;
    const disableTicket = interaction.options.getBoolean("disable_ticket") === true;
    const disableModeration = interaction.options.getBoolean("disable_moderation") === true;
    const disableTranscript = interaction.options.getBoolean("disable_transcript") === true;
    if (disableTicket && ticketChannel) throw new Error("Choose either a ticket log channel or disable ticket logs.");
    if (disableModeration && moderationChannel) throw new Error("Choose either a moderation log channel, clear the channel, or disable moderation logs.");
    if (disableTranscript && transcriptChannel) throw new Error("Choose either a transcript log channel, clear the channel, or disable transcript logs.");
    if (clearModeration && moderationChannel) throw new Error("Choose either a moderation log channel or clear the channel.");
    if (clearTranscript && transcriptChannel) throw new Error("Choose either a transcript log channel or clear the channel.");
    if (clearModeration && disableModeration) throw new Error("Choose either clear moderation channel or disable moderation logs.");
    if (clearTranscript && disableTranscript) throw new Error("Choose either clear transcript channel or disable transcript logs.");

    const patch = {};
    if (disableTicket) {
      patch.ticket_logs_enabled = false;
    } else if (ticketChannel) {
      patch.ticket_log_channel_id = ticketChannel.id;
      patch.log_channel_id = ticketChannel.id;
      patch.ticket_logs_enabled = true;
    }
    if (disableModeration) {
      patch.moderation_logs_enabled = false;
    } else if (clearModeration) {
      patch.moderation_log_channel_id = null;
      patch.moderation_logs_enabled = true;
    } else if (moderationChannel) {
      patch.moderation_log_channel_id = moderationChannel.id;
      patch.moderation_logs_enabled = true;
    }
    if (disableTranscript) {
      patch.transcript_logs_enabled = false;
    } else if (clearTranscript) {
      patch.transcript_log_channel_id = null;
      patch.transcript_channel_id = null;
      patch.transcript_logs_enabled = true;
    } else if (transcriptChannel) {
      patch.transcript_log_channel_id = transcriptChannel.id;
      patch.transcript_channel_id = transcriptChannel.id;
      patch.transcript_logs_enabled = true;
    }

    const saved = await upsertGuildSettings(interaction.guildId, patch);
    const transcriptLog = saved.transcript_logs_enabled === false
      ? "off"
      : saved.transcript_log_channel_id
        ? "<#" + saved.transcript_log_channel_id + ">"
        : saved.ticket_logs_enabled !== false && saved.ticket_log_channel_id
          ? "fallback → <#" + saved.ticket_log_channel_id + ">"
          : "off";
    return respond(interaction, ephemeral([
      "Ticket logs: " + (saved.ticket_logs_enabled !== false && saved.ticket_log_channel_id ? "<#" + saved.ticket_log_channel_id + ">" : "off"),
      "Moderation logs: " + (saved.moderation_logs_enabled !== false && saved.moderation_log_channel_id ? "<#" + saved.moderation_log_channel_id + ">" : "off"),
      "Transcript logs: " + transcriptLog,
    ].join("\n")));
  }

  const ticket = await service.getTicket(interaction);
  const mutate = (callback) => service.withTicketActionLock(ticket.id, callback);

  switch (sub) {
    case "info": return service.info(interaction, ticket);
    case "transcript": return service.sendTranscript(interaction, ticket);
    case "close": return service.requestClose(interaction, ticket);
    case "reopen": return mutate(() => service.reopen(interaction, ticket));
    case "claim": return mutate(() => service.claim(interaction, ticket));
    case "unclaim": return mutate(() => service.unclaim(interaction, ticket));
    case "add": {
      const user = interaction.options.getUser("user");
      const role = interaction.options.getRole("role");
      if (Boolean(user) === Boolean(role)) throw new Error("Choose either a user or a role.");
      return mutate(() => user
        ? service.addMember(interaction, ticket, user.id)
        : service.addRole(interaction, ticket, role.id));
    }
    case "remove": return mutate(() => service.removeMember(interaction, ticket, interaction.options.getUser("user", true).id));
    case "rename": return mutate(() => service.rename(interaction, ticket, interaction.options.getString("name", true)));
    case "delete": return service.requestDelete(interaction, ticket);
    default: throw new Error("Unknown ticket subcommand.");
  }
}

async function handlePanelList(interaction, ui) {
  const panels = await listPanels(interaction.guildId);
  const description = panels.length ? panels.map((panel) => "**" + panel.name + "** · ID " + panel.id).join("\n") : "No panels created yet. Use /panel create.";
  return respond(interaction, ui.buildAdminEmbed("Evix Panels", description));
}

export async function handlePanelCommand(interaction, ui) {
  if (!interaction.memberPermissions?.has(ADMIN)) throw new Error("You need Manage Server to manage ticket panels.");
  const sub = interaction.options.getSubcommand();
  if (sub === "list") return handlePanelList(interaction, ui);
  const panelInput = interaction.options.getString("panel", false);
  if (sub === "create") {
    const panel = await createPanel({ guildId: interaction.guildId, name: interaction.options.getString("name", true), title: "", description: "", footer: "", imageUrl: null, placeholder: "", accentColor: 0x5865f2, footerShowBot: false, withDefaultOption: true });
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
    try { await updatePanel(panel.id, { channel_id: channel.id, message_id: message.id }); } catch (error) { await message.delete("Evix panel pointer update failed").catch(() => null); throw error; }
    if (previous.message_id && previous.message_id !== message.id) await removeStoredPanelMessage(interaction.guild, previous);
    return respond(interaction, ui.buildAdminEmbed("Panel Sent", "Panel **" + panel.name + "** has been sent to <#" + channel.id + ">."));
  }
  if (sub === "reset") {
    const previous = { channel_id: panel.channel_id, message_id: panel.message_id };
    const reset = await resetPanel(panel.id);
    if (previous.message_id) await removeStoredPanelMessage(interaction.guild, previous);
    return respond(interaction, ui.buildAdminEmbed("Panel Reset", "Panel **" + reset.name + "** has been reset successfully."));
  }
  if (sub === "delete") {
    const previous = { channel_id: panel.channel_id, message_id: panel.message_id };
    await deletePanel(panel.id);
    if (previous.message_id) await removeStoredPanelMessage(interaction.guild, previous);
    return respond(interaction, ui.buildAdminEmbed("Panel Deleted", "Panel **" + panel.name + "** has been deleted successfully.", 0xed4245));
  }

  if (sub === "option-add") {
    const label = interaction.options.getString("name", true);
    const action = interaction.options.getString("action", true);
    const description = interaction.options.getString("description");
    const emoji = interaction.options.getString("emoji");
    const category = interaction.options.getChannel("category");
    const closedCategory = interaction.options.getChannel("closed_category");
    const staffRole = interaction.options.getRole("staff_roles");
    const pingRole = interaction.options.getRole("ping_roles");
    const closeBehavior = interaction.options.getString("close_behavior");
    const allowMultiple = interaction.options.getBoolean("allow_multiple");
    const staffRoles = staffRole ? [staffRole.id] : [];
    const pingRoles = pingRole ? [pingRole.id] : [];
    await validateConfiguredRoles(interaction.guild, [...staffRoles, ...pingRoles]);

    const option = await addPanelOption({
      panelId: panel.id,
      label,
      description,
      emoji,
      action,
      categoryId: category?.id ?? null,
      closedCategoryId: closedCategory?.id ?? null,
      staffRoles,
      pingRoles,
      closeBehavior: closeBehavior || "move",
      allowMultiple: allowMultiple === true,
    });

    const refreshed = await getPanel(interaction.guildId, panel.id);
    await refreshPanelMessage(interaction.guild, refreshed, ui);
    return respond(
      interaction,
      ui.buildAdminEmbed(
        "Option Created",
        "Option **" + option.label + "** has been created successfully in panel **" + panel.name + "**.\\n\\n**Action**\\n\`" + option.action + "\`",
      ),
    );
  }

  let optionId;
  try {
    optionId = BigInt(interaction.options.getString("option", true));
  } catch {
    throw new Error("Select a valid ticket option from the option list.");
  }

  const target = await getPanelOption(optionId, interaction.guildId);
  if (!target || String(target.panel_id) !== String(panel.id)) throw new Error("Panel option not found.");

  if (sub === "option-remove") {
    await deletePanelOption(optionId);
    const refreshed = await getPanel(interaction.guildId, panel.id);
    if (refreshed?.options?.length) {
      await refreshPanelMessage(interaction.guild, refreshed, ui);
    } else {
      await removeStoredPanelMessage(interaction.guild, panel);
      if (refreshed) await updatePanel(refreshed.id, { channel_id: null, message_id: null });
    }
    return respond(interaction, ui.buildAdminEmbed("Option Removed", "The selected option has been removed successfully.", 0xed4245));
  }

  if (sub === "option-edit") {
    const patch = {};
    const description = interaction.options.getString("description");
    const emoji = interaction.options.getString("emoji");
    const category = interaction.options.getChannel("category");
    const closedCategory = interaction.options.getChannel("closed_category");
    const clearCategory = interaction.options.getBoolean("clear_category") === true;
    const clearClosedCategory = interaction.options.getBoolean("clear_closed_category") === true;
    const staffRole = interaction.options.getRole("staff_roles");
    const pingRole = interaction.options.getRole("ping_roles");
    const clearStaffRoles = interaction.options.getBoolean("clear_staff_roles") === true;
    const clearPingRoles = interaction.options.getBoolean("clear_ping_roles") === true;
    const closeBehavior = interaction.options.getString("close_behavior");
    const allowMultiple = interaction.options.getBoolean("allow_multiple");
    const action = interaction.options.getString("action");
    const name = interaction.options.getString("name");

    if (category && clearCategory) throw new Error("Choose either a category or clear category.");
    if (closedCategory && clearClosedCategory) throw new Error("Choose either a closed category or clear closed category.");
    if (staffRole || pingRole) await validateConfiguredRoles(interaction.guild, [staffRole?.id, pingRole?.id]);
    if (name !== null) {
      const trimmedName = name.trim();
      if (!trimmedName) throw new Error("Panel option name cannot be empty.");
      patch.label = trimmedName;
    }
    if (description !== null) patch.description = description === "-" ? null : description;
    if (emoji !== null) patch.emoji = emoji === "-" ? null : emoji;
    if (clearCategory) patch.category_id = null;
    else if (category) patch.category_id = category.id;
    if (clearClosedCategory) patch.closed_category_id = null;
    else if (closedCategory) patch.closed_category_id = closedCategory.id;
    if (staffRole && clearStaffRoles) throw new Error("Choose either a staff role or clear staff roles.");
    if (pingRole && clearPingRoles) throw new Error("Choose either a ping role or clear ping roles.");
    if (clearStaffRoles) patch.staff_roles = [];
    else if (staffRole) patch.staff_roles = [staffRole.id];
    if (clearPingRoles) patch.ping_roles = [];
    else if (pingRole) patch.ping_roles = [pingRole.id];
    if (closeBehavior !== null) patch.close_behavior = closeBehavior;
    if (allowMultiple !== null) patch.allow_multiple = allowMultiple;
    if (action !== null) patch.action = action;

    const updated = Object.keys(patch).length ? await updatePanelOption(optionId, patch) : target;
    const refreshed = await getPanel(interaction.guildId, panel.id);
    await refreshPanelMessage(interaction.guild, refreshed, ui);
    return respond(interaction, ui.buildAdminEmbed("Option Saved Successfully", "Option **" + updated.label + "** has been saved successfully in panel **" + panel.name + "**."));
  }

  throw new Error("Unknown panel action.");
}

export async function handlePanelAutocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  const query = String(focused.value ?? "").toLowerCase().trim();
  try {
    if (focused.name === "panel") {
      const panels = await listPanels(interaction.guildId);
      return interaction.respond(panels.filter((panel) => !query || String(panel.name).toLowerCase().includes(query) || String(panel.id).includes(query)).slice(0, 25).map((panel) => ({ name: truncate(String(panel.name) + " · ID " + panel.id, 100), value: String(panel.id) })));
    }
    if (focused.name === "option") {
      const panelInput = interaction.options.getString("panel");
      if (!panelInput) return interaction.respond([]);
      const panel = await getPanel(interaction.guildId, panelInput);
      if (!panel) return interaction.respond([]);
      const options = await listPanelOptions(panel.id);
      return interaction.respond(options.filter((option) => !query || String(option.label).toLowerCase().includes(query) || String(option.id).includes(query)).slice(0, 25).map((option) => ({ name: truncate(String(option.label) + " · ID " + option.id, 100), value: String(option.id) })));
    }
    return interaction.respond([]);
  } catch (error) {
    console.error("[evix-panel-autocomplete-error]", error);
    return interaction.respond([]).catch(() => null);
  }
}

export function buildRenameModal(ticketId) {
  const input = new TextInputBuilder().setCustomId("name").setStyle(TextInputStyle.Short).setPlaceholder("billing-help").setRequired(true).setMaxLength(90);
  return new ModalBuilder().setCustomId("evix:rename:" + ticketId).setTitle("Rename ticket").addLabelComponents(new LabelBuilder().setLabel("New ticket name").setTextInputComponent(input));
}

export function buildTicketModal(option) {
  const fields = validateModalFields(option.modal_fields);
  if (!fields.length) return null;
  const modal = new ModalBuilder().setCustomId("evix:modal:" + option.id).setTitle(String(option.label || "Ticket").slice(0, 45));
  for (const field of fields) {
    const input = new TextInputBuilder().setCustomId(field.id).setStyle(field.style === "paragraph" ? TextInputStyle.Paragraph : TextInputStyle.Short).setRequired(field.required);
    if (field.placeholder) input.setPlaceholder(field.placeholder);
    modal.addLabelComponents(new LabelBuilder().setLabel(field.label).setTextInputComponent(input));
  }
  return modal;
}
