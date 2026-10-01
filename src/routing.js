import { ChannelType, PermissionFlagsBits } from "discord.js";
import { unique } from "./utils.js";

const BOT_CATEGORY_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.ManageChannels,
];

export async function getCategory(guild, categoryId) {
  if (!categoryId) return null;
  const category = await guild.channels.fetch(categoryId).catch(() => null);
  return category?.type === ChannelType.GuildCategory ? category : null;
}

export async function findTicketCreationCategory(guild, categoryIds) {
  const me = guild.members.me ?? await guild.members.fetchMe();
  const failures = [];
  for (const categoryId of unique(categoryIds)) {
    const category = await getCategory(guild, categoryId);
    if (!category) {
      failures.push({ categoryId, reason: "Category not found." });
      continue;
    }
    const permissions = category.permissionsFor(me);
    if (!permissions?.has(BOT_CATEGORY_PERMISSIONS)) {
      failures.push({ categoryId, reason: "Evix is missing the required category permissions." });
      continue;
    }
    return { category, failures };
  }
  const error = new Error(
    failures.length
      ? failures.map((item) => item.reason + (item.categoryId ? " (" + item.categoryId + ")" : "")).join(" ")
      : "No ticket category is configured.",
  );
  error.code = "EVIX_NO_TICKET_CATEGORY";
  throw error;
}

export async function moveTicketChannel(channel, categoryId) {
  const category = await getCategory(channel.guild, categoryId);
  if (!category) return null;
  if (channel.parentId === category.id) return category;
  await channel.setParent(category.id, { lockPermissions: false });
  return category;
}

export function categoryCandidates(primary, backup) {
  return unique([primary, backup]);
}
