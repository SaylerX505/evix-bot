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

const ADMIN = PermissionFlagsBits.ManageGuild;

export const commands = [
  new SlashCommandBuilder()
    .setName("ticket")
    .setDescription("Manage Evix tickets")
    .addSubcommand((s) => s.setName("info").setDescription("Show the current ticket information"))
    .addSubcommand((s) => s.setName("transcript").setDescription("Generate a transcript for the current ticket"))
    .addSubcommand((s) => s.setName("close").setDescription("Close the current ticket"))
    .addSubcommand((s) => s.setName("reopen").setDescription("Reopen the current ticket"))
    .addSubcommand((s) => s.setName("claim").setDescription("Claim the current ticket"))
    .addSubcommand((s) => s.setName("unclaim").setDescription("Unclaim the current ticket"))
    .addSubcommand((s) => s.setName("add").setDescription("Add a member to the current ticket")
      .addUserOption((o) => o.setName("user").setDescription("Member to add").setRequired(true)))
    .addSubcommand((s) => s.setName("remove").setDescription("Remove a member from the current ticket")
      .addUserOption((o) => o.setName("user").setDescription("Member to remove").setRequired(true)))
    .addSubcommand((s) => s.setName("rename").setDescription("Rename the current ticket")
      .addStringOption((o) => o.setName("name").setDescription("New channel name").setRequired(true).setMaxLength(90)))
    .addSubcommand((s) => s.setName("lock").setDescription("Lock the current ticket"))
    .addSubcommand((s) => s.setName("unlock").setDescription("Unlock the current ticket"))
    .addSubcommand((s) => s.setName("delete").setDescription("Delete the current ticket"))
    .addSubcommand((s) => s.setName("setup").setDescription("Configure default ticket settings")
      .addChannelOption((o) => o.setName("open_category").setDescription("Default open-ticket category").addChannelTypes(ChannelType.GuildCategory))
      .addChannelOption((o) => o.setName("closed_category").setDescription("Default closed-ticket category").addChannelTypes(ChannelType.GuildCategory))
      .addChannelOption((o) => o.setName("log_channel").setDescription("Default ticket log channel").addChannelTypes(ChannelType.GuildText))
      .addChannelOption((o) => o.setName("transcript_channel").setDescription("Default transcript channel").addChannelTypes(ChannelType.GuildText))
      .addIntegerOption((o) => o.setName("ticket_limit").setDescription("Open ticket limit per member").setMinValue(1).setMaxValue(25)))
    .addSubcommand((s) => s.setName("config").setDescription("View ticket configuration"))
    .addSubcommand((s) => s.setName("logs").setDescription("Configure ticket logging")
      .addChannelOption((o) => o.setName("log_channel").setDescription("Ticket log channel").addChannelTypes(ChannelType.GuildText))
      .addChannelOption((o) => o.setName("transcript_channel").setDescription("Transcript channel").addChannelTypes(ChannelType.GuildText))
      .addBooleanOption((o) => o.setName("disable_logs").setDescription("Turn ticket logs off"))
      .addBooleanOption((o) => o.setName("disable_transcripts").setDescription("Turn transcripts off")))
    .addSubcommandGroup((g) => g.setName("panel").setDescription("Manage ticket panels")
      .addSubcommand((s) => s.setName("create").setDescription("Create a ticket panel")
        .addStringOption((o) => o.setName("name").setDescription("Unique panel name").setRequired(true).setMinLength(1).setMaxLength(40))
        .addStringOption((o) => o.setName("mode").setDescription("Panel component mode").setRequired(true)
          .addChoices({ name: "Buttons", value: "buttons" }, { name: "Dropdown", value: "dropdown" }, { name: "Both", value: "both" }))
        .addStringOption((o) => o.setName("title").setDescription("Panel title").setMaxLength(256))
        .addStringOption((o) => o.setName("description").setDescription("Panel description").setMaxLength(4000))
        .addStringOption((o) => o.setName("footer").setDescription("Panel footer").setMaxLength(1000))
        .addIntegerOption((o) => o.setName("accent_color").setDescription("Decimal accent color").setMinValue(0).setMaxValue(16777215)))
      .addSubcommand((s) => s.setName("edit").setDescription("Edit a ticket panel")
        .addStringOption((o) => o.setName("panel").setDescription("Panel name or ID").setRequired(true))
        .addStringOption((o) => o.setName("name").setDescription("New panel name").setMaxLength(40))
        .addStringOption((o) => o.setName("mode").setDescription("Component mode")
          .addChoices({ name: "Buttons", value: "buttons" }, { name: "Dropdown", value: "dropdown" }, { name: "Both", value: "both" }))
        .addStringOption((o) => o.setName("title").setDescription("Panel title").setMaxLength(256))
        .addStringOption((o) => o.setName("description").setDescription("Panel description").setMaxLength(4000))
        .addStringOption((o) => o.setName("footer").setDescription("Panel footer").setMaxLength(1000))
        .addIntegerOption((o) => o.setName("accent_color").setDescription("Decimal accent color").setMinValue(0).setMaxValue(16777215)))
      .addSubcommand((s) => s.setName("delete").setDescription("Delete a ticket panel")
        .addStringOption((o) => o.setName("panel").setDescription("Panel name or ID").setRequired(true)))
      .addSubcommand((s) => s.setName("send").setDescription("Send a ticket panel")
        .addStringOption((o) => o.setName("panel").setDescription("Panel name or ID").setRequired(true))
        .addChannelOption((o) => o.setName("channel").setDescription("Destination channel").setRequired(true).addChannelTypes(ChannelType.GuildText)))
      .addSubcommand((s) => s.setName("reset").setDescription("Reset a panel to a clean default state")
        .addStringOption((o) => o.setName("panel").setDescription("Panel name or ID").setRequired(true)))
      .addSubcommand((s) => s.setName("option-add").setDescription("Add a panel option")
        .addStringOption((o) => o.setName("panel").setDescription("Panel name or ID").setRequired(true))
        .addStringOption((o) => o.setName("component").setDescription("Button or dropdown").setRequired(true)
          .addChoices({ name: "Button", value: "button" }, { name: "Dropdown", value: "dropdown" }))
        .addStringOption((o) => o.setName("label").setDescription("Visible option label").setRequired(true).setMaxLength(80))
        .addStringOption((o) => o.setName("action").setDescription("What this option does").setRequired(true)
          .addChoices({ name: "Create Ticket", value: "CREATE_TICKET" }, { name: "Nothing / Reset", value: "NOTHING" }))
        .addStringOption((o) => o.setName("description").setDescription("Option description").setMaxLength(100))
        .addStringOption((o) => o.setName("emoji").setDescription("Unicode emoji").setMaxLength(32))
        .addChannelOption((o) => o.setName("category").setDescription("Ticket category; defaults to /ticket setup").addChannelTypes(ChannelType.GuildCategory))
        .addChannelOption((o) => o.setName("closed_category").setDescription("Closed-ticket category").addChannelTypes(ChannelType.GuildCategory))
        .addChannelOption((o) => o.setName("log_channel").setDescription("Ticket log channel").addChannelTypes(ChannelType.GuildText))
        .addChannelOption((o) => o.setName("transcript_channel").setDescription("Transcript channel").addChannelTypes(ChannelType.GuildText))
        .addStringOption((o) => o.setName("staff_roles").setDescription("Role mentions, separated by spaces"))
        .addStringOption((o) => o.setName("ping_roles").setDescription("Role mentions, separated by spaces"))
        .addStringOption((o) => o.setName("welcome").setDescription("Welcome message").setMaxLength(4000))
        .addStringOption((o) => o.setName("name_template").setDescription("e.g. ticket-{number}").setMaxLength(90))
        .addStringOption((o) => o.setName("close_behavior").setDescription("Move or stay when closed")
          .addChoices({ name: "Move", value: "move" }, { name: "Stay", value: "stay" }))
        .addIntegerOption((o) => o.setName("button_style").setDescription("1 Primary, 2 Secondary, 3 Success, 4 Danger").setMinValue(1).setMaxValue(4))
        .addStringOption((o) => o.setName("form").setDescription("Optional JSON array of modal fields").setMaxLength(4000))
        .addBooleanOption((o) => o.setName("allow_multiple").setDescription("Allow multiple active tickets of this type"))
        .addBooleanOption((o) => o.setName("transcript_on_close").setDescription("Create transcript when closing")))
      .addSubcommand((s) => s.setName("option-edit").setDescription("Edit a panel option")
        .addStringOption((o) => o.setName("panel").setDescription("Panel name or ID").setRequired(true))
        .addStringOption((o) => o.setName("option").setDescription("Option ID").setRequired(true))
        .addStringOption((o) => o.setName("label").setDescription("Visible option label").setMaxLength(80))
        .addStringOption((o) => o.setName("component").setDescription("Button or dropdown")
          .addChoices({ name: "Button", value: "button" }, { name: "Dropdown", value: "dropdown" }))
        .addStringOption((o) => o.setName("action").setDescription("What this option does")
          .addChoices({ name: "Create Ticket", value: "CREATE_TICKET" }, { name: "Nothing / Reset", value: "NOTHING" }))
        .addStringOption((o) => o.setName("description").setDescription("Option description").setMaxLength(100))
        .addStringOption((o) => o.setName("emoji").setDescription("Unicode emoji").setMaxLength(32))
        .addChannelOption((o) => o.setName("category").setDescription("Ticket category").addChannelTypes(ChannelType.GuildCategory))
        .addChannelOption((o) => o.setName("closed_category").setDescription("Closed-ticket category").addChannelTypes(ChannelType.GuildCategory))
        .addChannelOption((o) => o.setName("log_channel").setDescription("Ticket log channel").addChannelTypes(ChannelType.GuildText))
        .addChannelOption((o) => o.setName("transcript_channel").setDescription("Transcript channel").addChannelTypes(ChannelType.GuildText))
        .addStringOption((o) => o.setName("staff_roles").setDescription("Role mentions, separated by spaces"))
        .addStringOption((o) => o.setName("ping_roles").setDescription("Role mentions, separated by spaces"))
        .addStringOption((o) => o.setName("welcome").setDescription("Welcome message").setMaxLength(4000))
        .addStringOption((o) => o.setName("name_template").setDescription("e.g. ticket-{number}").setMaxLength(90))
        .addStringOption((o) => o.setName("close_behavior").setDescription("Move or stay when closed")
          .addChoices({ name: "Move", value: "move" }, { name: "Stay", value: "stay" }))
        .addIntegerOption((o) => o.setName("button_style").setDescription("1 Primary, 2 Secondary, 3 Success, 4 Danger").setMinValue(1).setMaxValue(4))
        .addStringOption((o) => o.setName("form").setDescription("Optional JSON array of modal fields").setMaxLength(4000))
        .addBooleanOption((o) => o.setName("allow_multiple").setDescription("Allow multiple active tickets of this type"))
        .addBooleanOption((o) => o.setName("transcript_on_close").setDescription("Create transcript when closing")))
      .addSubcommand((s) => s.setName("option-remove").setDescription("Remove a panel option")
        .addStringOption((o) => o.setName("panel").setDescription("Panel name or ID").setRequired(true))
        .addStringOption((o) => o.setName("option").setDescription("Option ID").setRequired(true))))
    .setDMPermission(false),
];

function ephemeral(content) {
  return { content, flags: MessageFlags.Ephemeral };
}

async function validateConfiguredRoles(guild, roleIds) {
  for (const roleId of unique(roleIds)) {
    const role = await guild.roles.fetch(roleId).catch(() => null);
    if (!role) throw new Error(`Configured role ${roleId} was not found in this server.`);
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

async function refreshPanelMessage(guild, panel, ui) {
  if (!panel?.channel_id || !panel?.message_id) return;
  const channel = await guild.channels.fetch(panel.channel_id).catch(() => null);
  const message = await channel?.messages.fetch(panel.message_id).catch(() => null);

  if (!message) {
    await updatePanel(panel.id, { channel_id: null, message_id: null }).catch((error) => {
      console.error("[panel-pointer-clear-error]", error);
    });
    return;
  }

  try {
    await message.edit(ui.buildPanelMessage(panel));
  } catch (error) {
    console.error("[panel-refresh-error]", error);
  }
}

async function removeStoredPanelMessage(guild, panel) {
  if (!panel?.channel_id || !panel?.message_id) return;
  const channel = await guild.channels.fetch(panel.channel_id).catch(() => null);
  const message = await channel?.messages.fetch(panel.message_id).catch(() => null);
  await message?.delete("Evix panel removed").catch(() => null);
}

function assertComponentMatchesPanel(panel, componentKind) {
  if (panel.component_mode !== "both" && panel.component_mode !== componentKind) {
    throw new Error(`This panel is configured for ${panel.component_mode} components.`);
  }
}

export async function handleTicketCommand(interaction, service, ui) {
  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand();

  if (group === "panel") return handlePanelCommand(interaction, sub, ui);

  if (["setup", "config", "logs"].includes(sub) && !interaction.memberPermissions?.has(ADMIN)) {
    throw new Error("You need Manage Server to use this command.");
  }

  if (sub === "setup") {
    const current = await getGuildSettings(interaction.guildId) ?? {};
    const saved = await upsertGuildSettings(interaction.guildId, {
      open_category_id: interaction.options.getChannel("open_category")?.id ?? current.open_category_id ?? null,
      closed_category_id: interaction.options.getChannel("closed_category")?.id ?? current.closed_category_id ?? null,
      log_channel_id: interaction.options.getChannel("log_channel")?.id ?? current.log_channel_id ?? null,
      transcript_channel_id: interaction.options.getChannel("transcript_channel")?.id ?? current.transcript_channel_id ?? null,
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
    return interaction.reply(ephemeral([
      `Open category: ${settings?.open_category_id ? `<#${settings.open_category_id}>` : "Not configured"}`,
      `Closed category: ${settings?.closed_category_id ? `<#${settings.closed_category_id}>` : "Not configured"}`,
      `Log channel: ${settings?.log_channel_id ? `<#${settings.log_channel_id}>` : "Not configured"}`,
      `Transcript channel: ${settings?.transcript_channel_id ? `<#${settings.transcript_channel_id}>` : "Not configured"}`,
      `Ticket limit: ${settings?.default_ticket_limit ?? 1}`,
      `Panels: ${panels.length}`,
    ].join("\n")));
  }

  if (sub === "logs") {
    const current = await getGuildSettings(interaction.guildId) ?? {};
    const disableLogs = interaction.options.getBoolean("disable_logs") ?? false;
    const disableTranscripts = interaction.options.getBoolean("disable_transcripts") ?? false;
    const logChannel = interaction.options.getChannel("log_channel");
    const transcriptChannel = interaction.options.getChannel("transcript_channel");

    if (disableLogs && logChannel) {
      throw new Error("Choose either a log channel or disable logs, not both.");
    }
    if (disableTranscripts && transcriptChannel) {
      throw new Error("Choose either a transcript channel or disable transcripts, not both.");
    }

    const saved = await upsertGuildSettings(interaction.guildId, {
      log_channel_id: disableLogs ? null : (logChannel?.id ?? current.log_channel_id ?? null),
      transcript_channel_id: disableTranscripts ? null : (transcriptChannel?.id ?? current.transcript_channel_id ?? null),
    });

    return interaction.reply(ephemeral(
      `Logs: ${saved.log_channel_id ? `<#${saved.log_channel_id}>` : "off"}\nTranscripts: ${saved.transcript_channel_id ? `<#${saved.transcript_channel_id}>` : "off"}`,
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
    case "add": return service.addMember(interaction, ticket, interaction.options.getUser("user", true).id);
    case "remove": return service.removeMember(interaction, ticket, interaction.options.getUser("user", true).id);
    case "rename": return service.rename(interaction, ticket, interaction.options.getString("name", true));
    case "lock": return service.lock(interaction, ticket);
    case "unlock": return service.unlock(interaction, ticket);
    case "delete": return service.requestDelete(interaction, ticket);
    default: throw new Error("Unknown ticket subcommand.");
  }
}

async function handlePanelCommand(interaction, sub, ui) {
  if (!interaction.memberPermissions?.has(ADMIN)) {
    throw new Error("You need Manage Server to manage ticket panels.");
  }

  if (sub === "create") {
    const panel = await createPanel({
      guildId: interaction.guildId,
      name: interaction.options.getString("name", true),
      componentMode: interaction.options.getString("mode", true),
      title: interaction.options.getString("title") || "Evix Support",
      description: interaction.options.getString("description") || "Choose an option below to open a ticket.",
      footer: interaction.options.getString("footer") || "Evix Ticket System",
      accentColor: interaction.options.getInteger("accent_color") ?? 0x5865f2,
    });

    return interaction.reply(ephemeral(
      `Panel created: \`${panel.name}\` (ID ${panel.id}). Add options with \`/ticket panel option-add\`.`,
    ));
  }

  const panelInput = interaction.options.getString("panel", true);
  const panel = await getPanel(interaction.guildId, panelInput);
  if (!panel) throw new Error("Panel not found.");

  if (sub === "delete") {
    await deletePanel(panel.id);
    await removeStoredPanelMessage(interaction.guild, panel);
    return interaction.reply(ephemeral(`Panel \`${panel.name}\` deleted.`));
  }

  if (sub === "reset") {
    const reset = await resetPanel(panel.id);
    await removeStoredPanelMessage(interaction.guild, panel);
    return interaction.reply(ephemeral(`Panel \`${reset.name}\` was reset. Its options were removed.`));
  }

  if (sub === "send") {
    const channel = interaction.options.getChannel("channel", true);
    if (!channel.isTextBased?.() || channel.type !== ChannelType.GuildText) {
      throw new Error("Choose a text channel.");
    }
    assertPanelOptions(panel.options);

    const previous = { channel_id: panel.channel_id, message_id: panel.message_id };
    const message = await channel.send(ui.buildPanelMessage(panel));

    try {
      await updatePanel(panel.id, { channel_id: channel.id, message_id: message.id });
    } catch (error) {
      await message.delete("Evix panel database update failed").catch(() => null);
      throw error;
    }

    if (previous.message_id && previous.message_id !== message.id) {
      await removeStoredPanelMessage(interaction.guild, previous);
    }

    return interaction.reply(ephemeral(`Panel sent to ${channel}.`));
  }

  if (sub === "edit") {
    const patch = {};
    for (const [input, key] of [
      ["name", "name"],
      ["mode", "component_mode"],
      ["title", "title"],
      ["description", "description"],
      ["footer", "footer"],
    ]) {
      const value = interaction.options.getString(input);
      if (value !== null) patch[key] = value;
    }
    const color = interaction.options.getInteger("accent_color");
    if (color !== null) patch.accent_color = color;

    if (patch.component_mode && patch.component_mode !== "both") {
      const incompatible = panel.options.some((option) => option.component_kind !== patch.component_mode);
      if (incompatible) {
        throw new Error("This mode would hide existing panel options. Use both, or edit/remove incompatible options first.");
      }
    }

    const updated = Object.keys(patch).length
      ? await updatePanel(panel.id, patch)
      : panel;

    if (panel.message_id && panel.channel_id) {
      await refreshPanelMessage(interaction.guild, { ...panel, ...updated, options: panel.options }, ui);
    }

    return interaction.reply(ephemeral(`Panel \`${updated.name}\` updated.`));
  }

  const optionInput = interaction.options.getString("option", true);
  let optionId;
  try {
    optionId = BigInt(optionInput);
  } catch {
    throw new Error("Option ID must be a valid numeric ID.");
  }

  const targetOption = await getPanelOption(optionId);
  if (!targetOption || String(targetOption.panel_id) !== String(panel.id)) {
    throw new Error("Panel option not found in this panel.");
  }

  if (sub === "option-remove") {
    await deletePanelOption(optionId);
    const refreshed = await getPanel(interaction.guildId, panel.id);

    if (refreshed?.options?.length) {
      await refreshPanelMessage(interaction.guild, refreshed, ui);
    } else {
      await removeStoredPanelMessage(interaction.guild, panel);
      if (refreshed) await updatePanel(refreshed.id, { message_id: null });
    }

    return interaction.reply(ephemeral("Panel option removed."));
  }

  const action = interaction.options.getString("action");
  const category = interaction.options.getChannel("category");
  const closedCategory = interaction.options.getChannel("closed_category");
  const logChannel = interaction.options.getChannel("log_channel");
  const transcriptChannel = interaction.options.getChannel("transcript_channel");
  const staffRolesInput = interaction.options.getString("staff_roles");
  const pingRolesInput = interaction.options.getString("ping_roles");
  const staffRoles = unique(parseRoleMentions(staffRolesInput || ""));
  const pingRoles = unique(parseRoleMentions(pingRolesInput || ""));
  const formInput = interaction.options.getString("form");
  const modalFields = parseFormInput(formInput);
  const defaults = await getGuildSettings(interaction.guildId);

  if (sub === "option-add") {
    const componentKind = interaction.options.getString("component", true);
    assertComponentMatchesPanel(panel, componentKind);

    const categoryId = category?.id ?? defaults?.open_category_id ?? null;
    if (action === "CREATE_TICKET" && !categoryId) {
      throw new Error("CREATE_TICKET options require a category or a default open category.");
    }

    await validateConfiguredRoles(interaction.guild, [...staffRoles, ...pingRoles]);

    const options = await listPanelOptions(panel.id);
    const option = await addPanelOption({
      panelId: panel.id,
      position: options.length,
      componentKind,
      label: interaction.options.getString("label", true),
      description: interaction.options.getString("description"),
      emoji: interaction.options.getString("emoji"),
      action,
      categoryId,
      closedCategoryId: closedCategory?.id ?? defaults?.closed_category_id ?? null,
      staffRoles,
      pingRoles,
      logChannelId: logChannel?.id ?? defaults?.log_channel_id ?? null,
      transcriptChannelId: transcriptChannel?.id ?? defaults?.transcript_channel_id ?? null,
      welcomeMessage: interaction.options.getString("welcome") || "Thanks for opening a ticket. A member of the team will be with you shortly.",
      ticketNameTemplate: interaction.options.getString("name_template") || "ticket-{number}",
      closeBehavior: interaction.options.getString("close_behavior") || "move",
      transcriptOnClose: interaction.options.getBoolean("transcript_on_close") ?? true,
      allowMultiple: interaction.options.getBoolean("allow_multiple") ?? false,
      buttonStyle: interaction.options.getInteger("button_style") ?? 2,
      modalFields,
    });

    await refreshPanelMessage(interaction.guild, { ...panel, options: [...panel.options, option] }, ui);
    return interaction.reply(ephemeral(`Option created: **${option.label}** (ID ${option.id}).`));
  }

  if (sub === "option-edit") {
    const patch = {};
    for (const [input, key] of [
      ["label", "label"],
      ["component", "component_kind"],
      ["action", "action"],
      ["description", "description"],
      ["emoji", "emoji"],
      ["welcome", "welcome_message"],
      ["name_template", "ticket_name_template"],
    ]) {
      const value = interaction.options.getString(input);
      if (value !== null) patch[key] = value;
    }

    const component = interaction.options.getString("component");
    if (component) assertComponentMatchesPanel(panel, component);
    if (category) patch.category_id = category.id;
    if (closedCategory) patch.closed_category_id = closedCategory.id;
    if (logChannel) patch.log_channel_id = logChannel.id;
    if (transcriptChannel) patch.transcript_channel_id = transcriptChannel.id;

    if (staffRolesInput !== null) {
      await validateConfiguredRoles(interaction.guild, staffRoles);
      patch.staff_roles = staffRoles;
    }
    if (pingRolesInput !== null) {
      await validateConfiguredRoles(interaction.guild, pingRoles);
      patch.ping_roles = pingRoles;
    }

    const closeBehavior = interaction.options.getString("close_behavior");
    const buttonStyle = interaction.options.getInteger("button_style");
    const multi = interaction.options.getBoolean("allow_multiple");
    const transcript = interaction.options.getBoolean("transcript_on_close");
    if (closeBehavior !== null) patch.close_behavior = closeBehavior;
    if (buttonStyle !== null) patch.button_style = buttonStyle;
    if (multi !== null) patch.allow_multiple = multi;
    if (transcript !== null) patch.transcript_on_close = transcript;
    if (formInput !== null) patch.modal_fields = modalFields;

    const effectiveAction = patch.action ?? targetOption.action;
    const effectiveCategory = patch.category_id ?? targetOption.category_id ?? defaults?.open_category_id;
    if (effectiveAction === "CREATE_TICKET" && !effectiveCategory) {
      throw new Error("CREATE_TICKET options require a category or a default open category.");
    }
    if (effectiveAction === "CREATE_TICKET" && !targetOption.category_id && !patch.category_id && defaults?.open_category_id) {
      patch.category_id = defaults.open_category_id;
    }

    const updated = Object.keys(patch).length
      ? await updatePanelOption(optionId, patch)
      : targetOption;

    const refreshed = await getPanel(interaction.guildId, panel.id);
    await refreshPanelMessage(interaction.guild, refreshed, ui);
    return interaction.reply(ephemeral(`Option **${updated.label}** updated.`));
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
    .setCustomId(`evix:add-user:${ticketId}`)
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
    .setCustomId(`evix:rename:${ticketId}`)
    .setTitle("Rename ticket")
    .addLabelComponents(new LabelBuilder().setLabel("New ticket name").setTextInputComponent(input));
}

export function buildTicketModal(option) {
  const fields = validateModalFields(option.modal_fields);
  if (!fields.length) return null;

  const modal = new ModalBuilder()
    .setCustomId(`evix:modal:${option.id}`)
    .setTitle(String(option.label || "Ticket").slice(0, 45));

  for (const field of fields) {
    const input = new TextInputBuilder()
      .setCustomId(field.id)
      .setStyle(field.style === "paragraph" ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(field.required);

    if (field.placeholder) input.setPlaceholder(field.placeholder);
    modal.addLabelComponents(
      new LabelBuilder()
        .setLabel(field.label)
        .setTextInputComponent(input),
    );
  }

  return modal;
}
