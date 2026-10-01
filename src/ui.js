import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  MessageFlags,
} from "discord.js";
import { MAX_BUTTONS_PER_ROW, MAX_COMPONENT_OPTIONS, truncate } from "./utils.js";

const DEFAULT_ACCENT = 0x5865f2;
const MAX_PANEL_BUTTONS = 20;

function buttonFromOption(option) {
  const style = [1, 2, 3, 4].includes(Number(option.button_style))
    ? Number(option.button_style)
    : ButtonStyle.Secondary;
  const button = new ButtonBuilder()
    .setCustomId(`evix:p:${option.panel_id}:o:${option.id}`)
    .setLabel(truncate(option.label, 80))
    .setStyle(style);
  if (option.emoji) {
    try { button.setEmoji(option.emoji); } catch {}
  }
  return button;
}

function selectFromOptions(options, placeholder, panelId) {
  const menuOptions = options.slice(0, MAX_COMPONENT_OPTIONS).map((option) => {
    const item = {
      label: truncate(option.label, 100),
      value: String(option.id),
    };
    if (option.description) item.description = truncate(option.description, 100);
    if (option.emoji) {
      try { item.emoji = { name: option.emoji }; } catch {}
    }
    return item;
  });

  return new StringSelectMenuBuilder()
    .setCustomId(`evix:p:${panelId}:select`)
    .setPlaceholder(truncate(placeholder || "Select a ticket type", 150))
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(menuOptions);
}

export function v2Message(components, extra = {}) {
  return {
    ...extra,
    components,
    allowedMentions: extra.allowedMentions ?? { parse: [] },
    flags: MessageFlags.IsComponentsV2,
  };
}

export function buildPanelMessage(panel) {
  const options = Array.isArray(panel.options) ? panel.options : [];
  if (!options.length) throw new Error("Panel has no options.");
  if (options.length > MAX_COMPONENT_OPTIONS) {
    throw new Error("Panel exceeds the Discord select-menu option limit.");
  }

  const container = new ContainerBuilder()
    .setAccentColor(Number(panel.accent_color) || DEFAULT_ACCENT)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# ${panel.title || "Evix Support"}`),
      new TextDisplayBuilder().setContent(
        truncate(panel.description || "Choose an option below to open a ticket.", 4000),
      ),
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
    );

  const mode = ["buttons", "dropdown", "both"].includes(panel.component_mode)
    ? panel.component_mode
    : "dropdown";
  const buttons = mode === "dropdown" ? [] : options.filter((o) => o.component_kind === "button");
  const selectOptions = mode === "buttons" ? [] : options.filter((o) => o.component_kind === "dropdown");

  if (buttons.length > MAX_PANEL_BUTTONS) {
    throw new Error(`A panel can contain at most ${MAX_PANEL_BUTTONS} buttons.`);
  }

  const actionRowCount = Math.ceil(buttons.length / MAX_BUTTONS_PER_ROW) + (selectOptions.length ? 1 : 0);
  if (actionRowCount > 5) {
    throw new Error("This panel exceeds Discord's action-row limit. Reduce its buttons/options or use a separate panel.");
  }

  if (buttons.length) {
    for (let i = 0; i < buttons.length; i += MAX_BUTTONS_PER_ROW) {
      container.addActionRowComponents(
        new ActionRowBuilder().addComponents(
          buttons.slice(i, i + MAX_BUTTONS_PER_ROW).map(buttonFromOption),
        ),
      );
    }
  }

  if (selectOptions.length) {
    container.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        selectFromOptions(selectOptions, panel.placeholder, panel.id),
      ),
    );
  }

  container
    .addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# ${truncate(panel.footer || "Evix Ticket System", 1000)}`),
    );

  return v2Message([container]);
}

export function buildTicketView(ticket, option) {
  const claimed = ticket.claimed_by ? `<@${ticket.claimed_by}>` : "Unclaimed";
  const lockAction = ticket.status === "locked" ? "unlock" : "lock";
  const lockLabel = ticket.status === "locked" ? "Unlock" : "Lock";

  const container = new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# ${ticket.type_label}`),
      new TextDisplayBuilder().setContent([
        `**Ticket:** \`${ticket.ticket_key}\``,
        `**Owner:** <@${ticket.owner_id}>`,
        `**Status:** \`${ticket.status}\``,
        `**Claimed:** ${claimed}`,
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
        new ButtonBuilder().setCustomId(`evix:t:${ticket.id}:claim`).setLabel("Claim").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`evix:t:${ticket.id}:unclaim`).setLabel("Unclaim").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`evix:t:${ticket.id}:${lockAction}`).setLabel(lockLabel).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`evix:t:${ticket.id}:close`).setLabel("Close").setStyle(ButtonStyle.Danger),
      ),
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`evix:t:${ticket.id}:add`).setLabel("Add User").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`evix:t:${ticket.id}:rename`).setLabel("Rename").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`evix:t:${ticket.id}:info`).setLabel("Info").setStyle(ButtonStyle.Secondary),
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
      new TextDisplayBuilder().setContent(`# Delete ${ticket.ticket_key}?`),
      new TextDisplayBuilder().setContent("This will permanently delete the ticket channel. This action cannot be undone."),
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`evix:confirm:${ticket.id}:delete`).setLabel("Confirm Delete").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`evix:confirm:${ticket.id}:cancel`).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
      ),
    );

  return v2Message([container]);
}
export function buildClosedTicketView(ticket) {
  const container = new ContainerBuilder()
    .setAccentColor(0x747f8d)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# ${ticket.ticket_key} — Closed`),
      new TextDisplayBuilder().setContent(
        "This ticket is closed. It can be reopened by an authorized staff member.",
      ),
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`evix:t:${ticket.id}:reopen`).setLabel("Reopen").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`evix:t:${ticket.id}:transcript`).setLabel("Transcript").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`evix:t:${ticket.id}:delete`).setLabel("Delete").setStyle(ButtonStyle.Danger),
      ),
    );
  return v2Message([container]);
}

export function buildSetupSummary(settings) {
  const lines = [
    `**Open category:** ${settings?.open_category_id ? `<#${settings.open_category_id}>` : "Not configured"}`,
    `**Closed category:** ${settings?.closed_category_id ? `<#${settings.closed_category_id}>` : "Not configured"}`,
    `**Log channel:** ${settings?.log_channel_id ? `<#${settings.log_channel_id}>` : "Not configured"}`,
    `**Transcript channel:** ${settings?.transcript_channel_id ? `<#${settings.transcript_channel_id}>` : "Not configured"}`,
    `**Default ticket limit:** ${settings?.default_ticket_limit ?? 1}`,
  ];

  const container = new ContainerBuilder()
    .setAccentColor(DEFAULT_ACCENT)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("# Evix Ticket Configuration"),
      new TextDisplayBuilder().setContent(lines.join("\n")),
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("-# Evix 1.0.1"),
    );

  return v2Message([container]);
}
