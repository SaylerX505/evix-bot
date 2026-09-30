import { ContainerBuilder, SeparatorBuilder, SeparatorSpacingSize, TextDisplayBuilder, MessageFlags } from "discord.js";
import { truncate } from "./utils.js";

export async function writeTicketLog(guild, ticket, eventType, actorId, details = {}) {
  try {
    const channelId = ticket.log_channel_id || null;
    if (!channelId) return false;

    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased?.()) return false;

  const lines = [
    `# ${eventType.replaceAll("_", " ")}`,
    `**Ticket:** \`${ticket.ticket_key}\``,
    `**Type:** ${truncate(ticket.type_label, 100)}`,
    `**Actor:** ${actorId ? `<@${actorId}>` : "System"}`,
  ];

  const detailEntries = Object.entries(details);
  if (detailEntries.length) {
    lines.push("", ...detailEntries.map(([key, value]) => `**${key}:** ${truncate(value, 500)}`));
  }

  const container = new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n")))
    .addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
    )
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("-# Evix Audit Log"));

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
