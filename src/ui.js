import {
  ActionRowBuilder,
  ButtonBuilder,
  EmbedBuilder,
  ButtonStyle,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
} from "discord.js";
import { MAX_COMPONENT_OPTIONS, parseEmoji, truncate } from "./utils.js";

const DEFAULT_ACCENT = 0x5865f2;

function selectFromOptions(options, placeholder, panelId, disabled = false) {
  const menuOptions = options.slice(0, MAX_COMPONENT_OPTIONS).map((option) => {
    const item = { label: truncate(option.label, 100), value: String(option.id) };
    if (option.description) item.description = truncate(option.description, 100);
    const emoji = parseEmoji(option.emoji);
    if (emoji) item.emoji = emoji;
    return item;
  });
  const menu = new StringSelectMenuBuilder()
    .setCustomId("evix:p:" + panelId + ":select")
    .setMinValues(1)
    .setMaxValues(1)
    .setDisabled(disabled)
    .addOptions(menuOptions);
  if (placeholder) menu.setPlaceholder(truncate(placeholder, 150));
  return menu;
}

export function v2Message(components, extra = {}) {
  return {
    ...extra,
    components,
    allowedMentions: extra.allowedMentions ?? { parse: [] },
    flags: MessageFlags.IsComponentsV2 | (extra.flags ?? 0),
  };
}

function timestamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : "<t:" + Math.floor(date.getTime() / 1000) + ":F>";
}

function ticketStatusLabel(status) {
  return String(status || "open").replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function ticketControls(ticket) {
  const controls = [];
  if (ticket.claimed_by) {
    controls.push(new ButtonBuilder().setCustomId("evix:t:" + ticket.id + ":unclaim").setLabel("Unclaim Ticket").setStyle(ButtonStyle.Secondary));
  } else if (ticket.status === "open") {
    controls.push(new ButtonBuilder().setCustomId("evix:t:" + ticket.id + ":claim").setLabel("Claim").setStyle(ButtonStyle.Secondary));
  }
  if (ticket.status !== "closed") {
    controls.push(new ButtonBuilder().setCustomId("evix:t:" + ticket.id + ":waiting").setLabel(ticket.status === "waiting" ? "Resume" : "Waiting").setStyle(ButtonStyle.Secondary));
    controls.push(new ButtonBuilder().setCustomId("evix:t:" + ticket.id + ":close").setLabel("Close Ticket").setStyle(ButtonStyle.Danger));
  }
  controls.push(new ButtonBuilder().setCustomId("evix:t:" + ticket.id + ":info").setLabel("Info").setStyle(ButtonStyle.Secondary));
  return controls;
}

function containerWithText(title, lines, accent = DEFAULT_ACCENT) {
  const container = new ContainerBuilder().setAccentColor(accent).addTextDisplayComponents(
    new TextDisplayBuilder().setContent("# " + title),
    new TextDisplayBuilder().setContent(lines.join("\n\n")),
  );
  return container;
}

export function buildPanelMessage(panel, _botUser = null, { preview = false } = {}) {
  const options = Array.isArray(panel.options) ? panel.options.filter((option) => ["CREATE_TICKET", "NOTHING"].includes(option.action ?? "CREATE_TICKET")) : [];
  if (options.length > MAX_COMPONENT_OPTIONS) throw new Error("Panel exceeds the Discord select-menu option limit.");
  if (!options.length && !preview) throw new Error("Panel has no ticket options.");

  const container = new ContainerBuilder();
  if (Number.isInteger(Number(panel.accent_color))) container.setAccentColor(Number(panel.accent_color));
  const hasMedia = Boolean(panel.image_url);
  const title = truncate(panel.title || "", 256);
  const description = truncate(panel.description || "", 4000);

  if (hasMedia) {
    container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(String(panel.image_url))));
  }
  const topText = [];
  if (title) topText.push("# " + title);
  if (description) topText.push(description);
  if (topText.length) {
    if (hasMedia) container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(topText.join("\n\n")));
  }
  if (hasMedia || topText.length) container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  if (options.length) {
    container.addActionRowComponents(new ActionRowBuilder().addComponents(selectFromOptions(options, panel.placeholder, panel.id, preview)));
  } else {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent("No ticket options configured yet."));
  }
  return v2Message([container]);
}

export function buildTicketView(ticket, option = {}) {
  const status = ticketStatusLabel(ticket.status);
  const lines = [
    "**Ticket ID**\n`" + ticket.ticket_key + "`",
    "**Status**\n" + status,
    "**Ticket Owner**\n<@" + ticket.owner_id + ">",
  ];
  if (ticket.claimed_by) {
    lines.push(
      "**Claimed by**\n> <@" + ticket.claimed_by + ">",
      "**Claimed at**\n> " + timestamp(ticket.claimed_at || ticket.updated_at || new Date()),
      "**Status**\n> This ticket has been assigned to a staff member for handling.",
    );
  }

  const container = containerWithText(ticket.claimed_by ? "Ticket Claimed" : (ticket.type_label || "Ticket"), lines);
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    truncate(option.welcome_message || "Thanks for opening a ticket. A member of the team will be with you shortly.", 4000),
  ));
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));

  const controls = ticketControls(ticket);
  for (let index = 0; index < controls.length; index += 5) {
    container.addActionRowComponents(new ActionRowBuilder().addComponents(controls.slice(index, index + 5)));
  }
  return v2Message([container], {
    allowedMentions: {
      parse: [],
      users: [String(ticket.owner_id), ...(ticket.claimed_by ? [String(ticket.claimed_by)] : [])],
    },
  });
}

export function buildCloseConfirmation(ticket) {
  const container = containerWithText(
    "Close Ticket Confirmation",
    [
      "Are you sure you want to close this ticket?",
      "**This action will:**\n> • Remove the ticket creator's access\n> • Rename the channel to `closed-" + ticket.ticket_key + "`\n> • Mark the ticket as closed in the system",
    ],
    0xed4245,
  );
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  container.addActionRowComponents(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("evix:confirm:" + ticket.id + ":close").setLabel("Yes, Close Ticket").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("evix:confirm:" + ticket.id + ":keep-open").setLabel("No, Keep Open").setStyle(ButtonStyle.Secondary),
  ));
  return v2Message([container], { flags: MessageFlags.Ephemeral });
}

export function buildClosedTicketView(ticket) {
  const container = containerWithText(
    "Ticket Closed",
    [
      "This ticket has been closed by <@" + String(ticket.closed_by || "unknown") + ">.",
      "**Ticket ID**\n`" + ticket.ticket_key + "`",
    ],
    0x747f8d,
  );
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  container.addActionRowComponents(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("evix:t:" + ticket.id + ":transcript").setLabel("Get Transcript").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("evix:t:" + ticket.id + ":reopen").setLabel("Reopen").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("evix:t:" + ticket.id + ":delete").setLabel("Delete Ticket").setStyle(ButtonStyle.Danger),
  ));
  return v2Message([container], {
    allowedMentions: { parse: [], users: ticket.closed_by ? [String(ticket.closed_by)] : [] },
  });
}

export function buildInfoView(ticket, members = []) {
  const lines = [
    "**Ticket ID**\n`" + ticket.ticket_key + "`",
    "**Type**\n" + (ticket.type_label || "Unknown"),
    "**Owner**\n<@" + ticket.owner_id + ">",
    "**Status**\n" + ticketStatusLabel(ticket.status),
    "**Claimed by**\n" + (ticket.claimed_by ? "<@" + ticket.claimed_by + ">" : "Unclaimed"),
    "**Category**\n" + (ticket.current_category_id ? "<#" + ticket.current_category_id + ">" : "None"),
    "**Created**\n" + timestamp(ticket.created_at),
    "**Added members**\n" + (members.length ? members.map((id) => "<@" + id + ">").join(", ") : "None"),
  ];
  const container = containerWithText("Ticket Information", lines);
  return v2Message([container], {
    allowedMentions: { parse: [], users: [String(ticket.owner_id), ...(ticket.claimed_by ? [String(ticket.claimed_by)] : []), ...members.map(String)] },
  });
}

export function buildAdminEmbed(title, description, color = DEFAULT_ACCENT) {
  return {
    embeds: [new EmbedBuilder().setTitle(title).setDescription(description).setColor(color).setFooter({ text: "Powered by Evix team" })],
    allowedMentions: { parse: [] },
  };
}

export function buildErrorResult(error) {
  const description = [String(error?.message || "Something went wrong."), "", "-# Code: " + String(error?.code || "EVIX_ERROR") + " · Reference: " + String(error?.reference || "unknown")].join("\n");
  return buildAdminEmbed("Evix Error", description, 0xed4245);
}

export function buildActionResult(title, description, accent = DEFAULT_ACCENT) {
  return v2Message([containerWithText(title, [description], accent)]);
}

export function buildDeleteConfirmation(ticket) {
  const container = containerWithText(
    "Delete Ticket Confirmation",
    ["This will permanently delete `" + ticket.ticket_key + "`. This action cannot be undone."],
    0xed4245,
  );
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  container.addActionRowComponents(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("evix:confirm:" + ticket.id + ":delete").setLabel("Confirm Delete").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("evix:confirm:" + ticket.id + ":cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary),
  ));
  return v2Message([container], { flags: MessageFlags.Ephemeral });
}

export function buildSetupSummary(settings) {
  const lines = [
    "**Tickets category:** " + (settings?.ticket_category_id || settings?.open_category_id ? "<#" + (settings.ticket_category_id || settings.open_category_id) + ">" : "Not configured"),
    "**Backup tickets category:** " + (settings?.backup_category_id ? "<#" + settings.backup_category_id + ">" : "Not configured"),
    "**Waiting category:** " + (settings?.waiting_category_id ? "<#" + settings.waiting_category_id + ">" : "Not configured"),
    "**Closed tickets category:** " + (settings?.closed_category_id ? "<#" + settings.closed_category_id + ">" : "Not configured"),
    "**Ticket logs:** " + (settings?.ticket_logs_enabled === false || !(settings?.ticket_log_channel_id || settings?.log_channel_id) ? "off" : "<#" + (settings.ticket_log_channel_id || settings.log_channel_id) + ">"),
    "**Moderation logs:** " + (settings?.moderation_logs_enabled === false ? "off" : (settings?.moderation_log_channel_id ? "<#" + settings.moderation_log_channel_id + ">" : ((settings?.ticket_logs_enabled !== false && (settings?.ticket_log_channel_id || settings?.log_channel_id)) ? "fallback → <#" + (settings.ticket_log_channel_id || settings.log_channel_id) + ">" : "off"))),
    "**Transcript logs:** " + (settings?.transcript_logs_enabled === false || !(settings?.transcript_log_channel_id || settings?.transcript_channel_id) ? "off" : "<#" + (settings.transcript_log_channel_id || settings.transcript_channel_id) + ">"),
    "**Ticket limit:** " + (settings?.default_ticket_limit ?? 1),
  ];
  const container = containerWithText("Evix Ticket Configuration", lines);
  return v2Message([container]);
}
