import { ContainerBuilder, MessageFlags, SectionBuilder, SeparatorBuilder, SeparatorSpacingSize, TextDisplayBuilder, ThumbnailBuilder } from "discord.js";
import { truncate } from "./utils.js";

const LOG_EVENT_LABELS = new Map([
  ["TICKET_CREATED", "Open"],
  ["TICKET_CLAIMED", "Claimed"],
  ["TICKET_CLOSED", "Closed"],
  ["TICKET_DELETED", "Deleted"],
  ["TRANSCRIPT_CREATED", "Transcript"],
]);

function routeFor(eventType) {
  if (eventType === "TRANSCRIPT_CREATED") return "transcript";
  return "ticket";
}

function channelCandidates(ticket, route) {
  if (route === "transcript") {
    const candidates = [ticket.transcript_log_channel_id, ticket.transcript_channel_id];
    if (ticket.ticket_logs_enabled !== false) {
      candidates.push(ticket.ticket_log_channel_id, ticket.log_channel_id);
    }
    return candidates;
  }
  if (route === "moderation") {
    const candidates = [ticket.moderation_log_channel_id];
    if (ticket.ticket_logs_enabled !== false) {
      candidates.push(ticket.ticket_log_channel_id, ticket.log_channel_id);
    }
    return candidates;
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

export async function writeTicketLog(guild, ticket, eventType, actorId, details = {}, files = []) {
  try {
    const label = LOG_EVENT_LABELS.get(eventType);
    if (!label) return false;

    const route = routeFor(eventType);
    if (route === "ticket" && ticket.ticket_logs_enabled === false) return false;
    if (route === "moderation" && ticket.moderation_logs_enabled === false) return false;
    if (route === "transcript" && ticket.transcript_logs_enabled === false) return false;
    const channelIds = [...new Set(channelCandidates(ticket, route).filter(Boolean).map(String))];
    if (!channelIds.length) return false;

    const lines = [
      "# " + label,
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

    for (const channelId of channelIds) {
      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (!channel?.isTextBased?.()) continue;
      try {
        await channel.send({
          components: [container],
          flags: MessageFlags.IsComponentsV2,
          allowedMentions: { parse: [] },
          ...(Array.isArray(files) && files.length ? { files } : {}),
        });
        return true;
      } catch (error) {
        console.error("[evix-ticket-log-channel-send-error]", { channelId, error });
      }
    }
    return false;
  } catch (error) {
    console.error("[evix-ticket-log-error]", error);
    return false;
  }
}
