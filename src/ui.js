import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
} from "discord.js";
import { MAX_COMPONENT_OPTIONS, parseEmoji, truncate } from "./utils.js";

const DEFAULT_ACCENT = 0x5865f2;

function selectFromOptions(options, placeholder, panelId, disabled = false) {
  const menuOptions = options.slice(0, MAX_COMPONENT_OPTIONS).map((option) => {
    const item = {
      label: truncate(option.label, 100),
      value: String(option.id),
    };
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

function botAvatar(botUser) {
  if (!botUser) return null;
  if (typeof botUser.displayAvatarURL === "function") {
    return botUser.displayAvatarURL({ extension: "png", size: 128 });
  }
  return botUser.avatarURL || botUser.avatar_url || null;
}

function panelFooter(panel, botUser) {
  const footerText = truncate(panel.footer || "", 1000);
  const showBot = panel.footer_show_bot === true;
  if (!footerText && !showBot) return null;

  const texts = [];
  if (showBot) texts.push("**" + truncate(botUser?.username || botUser?.tag || "Evix", 80) + "**");
  if (footerText) texts.push(footerText);

  const section = new SectionBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(texts.join("\n")),
  );

  const avatar = showBot ? botAvatar(botUser) : null;
  if (avatar) section.setThumbnailAccessory(new ThumbnailBuilder().setURL(avatar));
  return section;
}

export function v2Message(components, extra = {}) {
  return {
    ...extra,
    components,
    allowedMentions: extra.allowedMentions ?? { parse: [] },
    flags: MessageFlags.IsComponentsV2 | (extra.flags ?? 0),
  };
}

export function buildPanelMessage(panel, botUser = null, { preview = false } = {}) {
  const options = Array.isArray(panel.options)
    ? panel.options.filter((option) => option.action === "CREATE_TICKET")
    : [];

  if (options.length > MAX_COMPONENT_OPTIONS) {
    throw new Error("Panel exceeds the Discord select-menu option limit.");
  }
  if (!options.length && !preview) {
    throw new Error("Panel has no ticket options.");
  }

  const container = new ContainerBuilder();
  if (Number.isInteger(Number(panel.accent_color))) {
    container.setAccentColor(Number(panel.accent_color));
  }

  const hasMedia = Boolean(panel.image_url);
  const title = truncate(panel.title || "", 256);
  const description = truncate(panel.description || "", 4000);

  if (hasMedia) {
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder().setURL(String(panel.image_url)),
      ),
    );
  }

  const topText = [];
  if (title) topText.push("# " + title);
  if (description) topText.push(description);

  if (topText.length) {
    if (hasMedia) {
      container.addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
      );
    }
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(topText.join("\n\n")));
  }

  if (hasMedia || topText.length) {
    container.addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
    );
  }

  if (options.length) {
    container.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        selectFromOptions(options, panel.placeholder, panel.id, preview),
      ),
    );
  } else {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent("No ticket options configured yet."),
    );
  }

  const footer = panelFooter(panel, botUser);
  if (footer) {
    container
      .addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
      )
      .addSectionComponents(footer);
  }

  return v2Message([container]);
}

export function buildTicketView(ticket, option) {
  const claimed = ticket.claimed_by ? "<@" + ticket.claimed_by + ">" : "Unclaimed";
  const lockAction = ticket.status === "locked" ? "unlock" : "lock";
  const lockLabel = ticket.status === "locked" ? "Unlock" : "Lock";
  const waitingLabel = ticket.status === "waiting" ? "Resume" : "Waiting";

  const container = new ContainerBuilder()
    .setAccentColor(DEFAULT_ACCENT)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("# " + ticket.type_label),
      new TextDisplayBuilder().setContent([
        "**Ticket ID:** `" + ticket.ticket_key + "`",
        "**Owner:** <@" + ticket.owner_id + ">",
        "**Status:** `" + ticket.status + "`",
        "**Claimed:** " + claimed,
      ].join("\n")),
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        truncate(option?.welcome_message || "Thanks for opening a ticket. A member of the team will be with you shortly.", 4000),
      ),
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("evix:t:" + ticket.id + ":claim").setLabel("Claim").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("evix:t:" + ticket.id + ":unclaim").setLabel("Unclaim").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("evix:t:" + ticket.id + ":" + lockAction).setLabel(lockLabel).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("evix:t:" + ticket.id + ":waiting").setLabel(waitingLabel).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("evix:t:" + ticket.id + ":close").setLabel("Close").setStyle(ButtonStyle.Danger),
      ),
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("evix:t:" + ticket.id + ":add").setLabel("Add User").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("evix:t:" + ticket.id + ":rename").setLabel("Rename").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("evix:t:" + ticket.id + ":info").setLabel("Info").setStyle(ButtonStyle.Secondary),
      ),
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
    )
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("-# Evix Ticket System"));

  return v2Message([container], {
    allowedMentions: {
      parse: [],
      users: [String(ticket.owner_id), ...(ticket.claimed_by ? [String(ticket.claimed_by)] : [])],
    },
  });
}

export function buildDeleteConfirmation(ticket) {
  const container = new ContainerBuilder()
    .setAccentColor(0xed4245)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("# Delete " + ticket.ticket_key + "?"),
      new TextDisplayBuilder().setContent("This will permanently delete the ticket channel. This action cannot be undone."),
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("evix:confirm:" + ticket.id + ":delete").setLabel("Confirm Delete").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("evix:confirm:" + ticket.id + ":cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary),
      ),
    );
  return v2Message([container]);
}

export function buildClosedTicketView(ticket) {
  const container = new ContainerBuilder()
    .setAccentColor(0x747f8d)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("# " + ticket.ticket_key + " — Closed"),
      new TextDisplayBuilder().setContent(
        "This ticket is closed. It can be reopened by an authorized staff member.",
      ),
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("evix:t:" + ticket.id + ":reopen").setLabel("Reopen").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("evix:t:" + ticket.id + ":transcript").setLabel("Transcript").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("evix:t:" + ticket.id + ":delete").setLabel("Delete").setStyle(ButtonStyle.Danger),
      ),
    );
  return v2Message([container]);
}

export function buildSetupSummary(settings) {
  const lines = [
    "**Tickets category:** " + (settings?.ticket_category_id || settings?.open_category_id ? "<#" + (settings.ticket_category_id || settings.open_category_id) + ">" : "Not configured"),
    "**Backup tickets category:** " + (settings?.backup_category_id ? "<#" + settings.backup_category_id + ">" : "Not configured"),
    "**Waiting category:** " + (settings?.waiting_category_id ? "<#" + settings.waiting_category_id + ">" : "Not configured"),
    "**Closed tickets category:** " + (settings?.closed_category_id ? "<#" + settings.closed_category_id + ">" : "Not configured"),
    "**Ticket logs:** " + (settings?.ticket_log_channel_id || settings?.log_channel_id ? "<#" + (settings.ticket_log_channel_id || settings.log_channel_id) + ">" : "off"),
    "**Moderation logs:** " + (settings?.moderation_log_channel_id ? "<#" + settings.moderation_log_channel_id + ">" : "off"),
    "**Transcript logs:** " + (settings?.transcript_log_channel_id || settings?.transcript_channel_id ? "<#" + (settings.transcript_log_channel_id || settings.transcript_channel_id) + ">" : "off"),
    "**Ticket limit:** " + (settings?.default_ticket_limit ?? 1),
  ];
  if (settings?.panels_count !== undefined) lines.push("**Panels:** " + settings.panels_count);

  const container = new ContainerBuilder()
    .setAccentColor(DEFAULT_ACCENT)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("# Evix Ticket Configuration"),
      new TextDisplayBuilder().setContent(lines.join("\n")),
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
    )
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("-# Evix 1.0.2"));

  return v2Message([container]);
}
