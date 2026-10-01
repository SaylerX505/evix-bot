import { ContainerBuilder, MessageFlags, SectionBuilder, SeparatorBuilder, SeparatorSpacingSize, TextDisplayBuilder, ThumbnailBuilder } from "discord.js";
import { truncate } from "./utils.js";

const MODERATION_EVENTS = new Set([
  "TICKET_DELETED",
  "MEMBER_ADDED",
  "MEMBER_REMOVED",
  "TICKET_LOCKED",
  "TICKET_UNLOCKED",
]);

function routeFor(eventType) {
  if (eventType === "TRANSCRIPT_CREATED") return "transcript";
  if (MODERATION_EVENTS.has(eventType)) return "moderation";
  return "ticket";
}

function channelCandidates(ticket, route) {
  if (route === "transcript") {
    return [ticket.transcript_log_channel_id, ticket.transcript_channel_id];
  }
  if (route === "moderation") {
    return [ticket.moderation_log_channel_id, ticket.ticket_log_channel_id, ticket.log_channel_id];
  }
  return [ticket.ticket_log_channel_id, ticket.log_channel_id];
}

function valueText(value) {
  if (value === null || value === undefined) return "None";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function footer(guild) {
  const bot = guild.client?.user;
  const name = truncate(bot?.username || "Evix", 80);
  const section = new SectionBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent("-# " + name + " • Evix Audit Log"),
  );
  const avatar = typeof bot?.displayAvatarURL === "function"
    ? bot.displayAvatarURL({ extension: "png", size: 64 })
    : null;
  if (avatar) section.setThumbnailAccessory(new ThumbnailBuilder().setURL(avatar));
  return section;
}

export async function writeTicketLog(guild, ticket, eventType, actorId, details = {}) {
  try {
    const route = routeFor(eventType);
    if (route === "ticket" && ticket.ticket_logs_enabled === false) return false;
    if (route === "moderation" && ticket.moderation_logs_enabled === false) return false;
    if (route === "transcript" && ticket.transcript_logs_enabled === false) return false;
    const channelId = channelCandidates(ticket, route).find(Boolean);
    if (!channelId) return false;

    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased?.()) return false;

    const lines = [
      "# " + eventType.replaceAll("_", " "),
      "**Ticket ID:** " + truncate(ticket.ticket_key, 100),
      "**Type:** " + truncate(ticket.type_label, 100),
      "**Channel:** <#" + ticket.channel_id + ">",
      "**Status:** " + truncate(ticket.status, 50),
      "**Actor:** " + (actorId ? "<@" + actorId + ">" : "System"),
    ];

    const detailEntries = Object.entries(details);
    if (detailEntries.length) {
      lines.push("", ...detailEntries.map(([key, value]) => "**" + key + ":** " + truncate(valueText(value), 800)));
    }

    const container = new ContainerBuilder()
      .setAccentColor(0x5865f2)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n")))
      .addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
      )
      .addSectionComponents(footer(guild));

    await channel.send({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
    });
    return true;
  } catch (error) {
    console.error("[evix-ticket-log-error]", error);
    return false;
  }
}
