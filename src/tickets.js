import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";
import {
  addTicketEvent,
  addTicketMember,
  countOpenTickets,
  createTicket,
  getGuildSettings,
  getOpenTicketForUser,
  getTicketByChannel,
  listTicketMembers,
  removeTicketMember,
  updateTicket,
} from "./db.js";
import { writeTicketLog } from "./logs.js";
import { buildClosedTicketView, buildTicketView } from "./ui.js";
import { buildTranscript, transcriptAttachment } from "./transcript.js";
import { transitionTicket } from "./state.js";
import {
  formatDuration,
  isStaff,
  renderTemplate,
  sanitizeChannelName,
  unique,
} from "./utils.js";

const BOT_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.ManageChannels,
];

async function respond(interaction, payload) {
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
  return interaction.reply(payload);
}

function ephemeral(content) {
  return { content, flags: MessageFlags.Ephemeral };
}

export class TicketService {
  constructor(client) {
    this.client = client;
  }

  async getSettings(guildId) {
    return (await getGuildSettings(guildId)) ?? {
      guild_id: guildId,
      open_category_id: null,
      closed_category_id: null,
      log_channel_id: null,
      transcript_channel_id: null,
      default_ticket_limit: 1,
    };
  }

  assertStaff(member, ticket) {
    if (!isStaff(member, unique(ticket.staff_roles))) {
      throw new Error("You are not authorized to manage this ticket.");
    }
  }

  canClose(member, ticket) {
    return member?.id === ticket.owner_id || isStaff(member, unique(ticket.staff_roles));
  }

  async getTicket(interaction, ticketId) {
    const ticket = await getTicketByChannel(interaction.guildId, interaction.channelId);
    if (!ticket || String(ticket.id) !== String(ticketId)) {
      throw new Error("This ticket is not available in the current channel.");
    }
    return ticket;
  }

  async createFromOption(interaction, option, formValues = {}) {
    if (option.action === "NOTHING") {
      await respond(interaction, ephemeral("Selection acknowledged. No ticket was created."));
      return null;
    }

    const settings = await this.getSettings(interaction.guildId);
    const categoryId = option.category_id || settings.open_category_id;
    if (!categoryId) throw new Error("This ticket type has no open-ticket category configured.");

    if (!option.allow_multiple) {
      const existing = await getOpenTicketForUser(interaction.guildId, interaction.user.id, option.id);
      if (existing) {
        await respond(interaction, ephemeral(
          `You already have an open ${option.label} ticket: <#${existing.channel_id}>`,
        ));
        return existing;
      }
    }

    const limit = Number(settings.default_ticket_limit ?? 1);
    if (!option.allow_multiple && await countOpenTickets(interaction.guildId, interaction.user.id) >= limit) {
      throw new Error(`You have reached the open ticket limit (${limit}).`);
    }

    const category = await interaction.guild.channels.fetch(categoryId).catch(() => null);
    if (!category || category.type !== ChannelType.GuildCategory) {
      throw new Error("The configured ticket category no longer exists.");
    }

    const me = interaction.guild.members.me ?? await interaction.guild.members.fetchMe();
    const permissions = category.permissionsFor(me);
    if (!permissions?.has(BOT_PERMISSIONS)) {
      throw new Error("Evix is missing View Channels, Send Messages, Read Message History, or Manage Channels in the ticket category.");
    }

    const staffRoles = unique(option.staff_roles);
    const pingRoles = unique(option.ping_roles);
    for (const roleId of [...staffRoles, ...pingRoles]) {
      if (!await interaction.guild.roles.fetch(roleId).catch(() => null)) {
        throw new Error(`Configured role ${roleId} no longer exists.`);
      }
    }

    const roleOverwrites = staffRoles.map((roleId) => ({
      id: roleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
      ],
    }));

    const channel = await interaction.guild.channels.create({
      name: "creating-ticket",
      type: ChannelType.GuildText,
      parent: category.id,
      reason: `Evix ticket for ${interaction.user.tag} (${option.label})`,
      permissionOverwrites: [
        { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        {
          id: interaction.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.EmbedLinks,
          ],
        },
        ...roleOverwrites,
        {
          id: me.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.ManageMessages,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.EmbedLinks,
          ],
        },
      ],
    });

    let ticket;
    try {
      ticket = await createTicket({
        guildId: interaction.guildId,
        panelId: option.panel_id,
        optionId: option.id,
        channelId: channel.id,
        ownerId: interaction.user.id,
        typeLabel: option.label,
        categoryId,
        closedCategoryId: option.closed_category_id || settings.closed_category_id,
        staffRoles,
        pingRoles,
        dedupeKey: option.allow_multiple ? null : `${interaction.guildId}:${interaction.user.id}:${option.id}`,
        logChannelId: option.log_channel_id || settings.log_channel_id,
        transcriptChannelId: option.transcript_channel_id || settings.transcript_channel_id,
        closeBehavior: option.close_behavior || "move",
        transcriptOnClose: option.transcript_on_close !== false,
      });
    } catch (error) {
      await channel.delete("Evix ticket creation compensation").catch(() => null);
      if (error?.code === "23505") {
        const existing = await getOpenTicketForUser(interaction.guildId, interaction.user.id, option.id);
        if (existing) {
          await respond(interaction, ephemeral(
            `You already have an open ${option.label} ticket: <#${existing.channel_id}>`,
          ));
          return existing;
        }
      }
      throw error;
    }

    const finalName = sanitizeChannelName(renderTemplate(option.ticket_name_template, {
      number: ticket.ticket_key,
      user: interaction.user.id,
      username: interaction.user.username,
      type: option.label,
    }));
    await channel.setName(finalName).catch(() => null);

    await addTicketEvent(ticket.id, "TICKET_CREATED", interaction.user.id, {
      type: option.label,
      channel: channel.id,
      form: formValues,
    });

    const formText = Object.entries(formValues)
      .filter(([, value]) => String(value ?? "").trim())
      .map(([key, value]) => `**${key}:** ${String(value).slice(0, 1000)}`)
      .join("\n");

    const welcome = [
      pingRoles.length ? pingRoles.map((id) => `<@&${id}>`).join(" ") : "",
      option.welcome_message || "Thanks for opening a ticket. A member of the team will be with you shortly.",
      formText ? `\n**Request details**\n${formText}` : "",
    ].filter(Boolean).join("\n");

    const view = buildTicketView(ticket, { ...option, welcome_message: welcome });
    view.allowedMentions = {
      parse: [],
      roles: pingRoles,
      users: [interaction.user.id],
    };

    try {
      await channel.send(view);
    } catch (error) {
      await updateTicket(ticket.id, { status: "deleted", deleted_at: new Date() }).catch(() => null);
      await addTicketEvent(ticket.id, "TICKET_CREATE_FAILED", interaction.user.id, {
        stage: "welcome_message",
      }).catch(() => null);
      await channel.delete("Evix ticket creation compensation").catch(() => null);
      throw new Error(`Ticket channel was created but the welcome message failed: ${error?.message || "unknown error"}`);
    }

    await respond(interaction, ephemeral(`Your ticket has been created: ${channel}`));
    await writeTicketLog(interaction.guild, ticket, "TICKET_CREATED", interaction.user.id, {
      channel: `<#${channel.id}>`,
    });
    return ticket;
  }

  async claim(interaction, ticket) {
    this.assertStaff(interaction.member, ticket);
    if (ticket.status !== "open") throw new Error("Only open tickets can be claimed.");
    if (ticket.claimed_by === interaction.user.id) return respond(interaction, ephemeral("You already have this ticket claimed."));
    if (ticket.claimed_by) throw new Error(`This ticket is already claimed by <@${ticket.claimed_by}>.`);

    const next = await updateTicket(ticket.id, { claimed_by: interaction.user.id });
    await addTicketEvent(ticket.id, "TICKET_CLAIMED", interaction.user.id);
    await respond(interaction, ephemeral("Ticket claimed."));
    await writeTicketLog(interaction.guild, next, "TICKET_CLAIMED", interaction.user.id);
    return next;
  }

  async unclaim(interaction, ticket) {
    this.assertStaff(interaction.member, ticket);
    if (!ticket.claimed_by) return respond(interaction, ephemeral("This ticket is not claimed."));
    if (ticket.claimed_by !== interaction.user.id && !interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
      throw new Error("Only the current claimer or a manager can unclaim this ticket.");
    }

    const next = await updateTicket(ticket.id, { claimed_by: null });
    await addTicketEvent(ticket.id, "TICKET_UNCLAIMED", interaction.user.id);
    await respond(interaction, ephemeral("Ticket unclaimed."));
    await writeTicketLog(interaction.guild, next, "TICKET_UNCLAIMED", interaction.user.id);
    return next;
  }

  async close(interaction, ticket, { reply = true } = {}) {
    if (!this.canClose(interaction.member, ticket)) {
      throw new Error("Only the ticket owner or configured staff can close this ticket.");
    }
    if (ticket.status === "closed") {
      if (reply) await respond(interaction, ephemeral("This ticket is already closed."));
      return ticket;
    }
    if (ticket.status === "deleted") throw new Error("This ticket has been deleted.");

    transitionTicket(ticket.status, "close");

    const transcriptUrl = ticket.transcript_on_close !== false
      ? (ticket.transcript_url || await this.createTranscript(interaction, ticket, true))
      : null;

    const next = await updateTicket(ticket.id, {
      status: "closed",
      closed_at: new Date(),
      claimed_by: null,
      transcript_url: transcriptUrl,
    });

    await interaction.channel.permissionOverwrites.edit(ticket.owner_id, {
      ViewChannel: false,
      SendMessages: false,
    }).catch(() => null);

    const closedCategory = ticket.closed_category_id
      ? await interaction.guild.channels.fetch(ticket.closed_category_id).catch(() => null)
      : null;
    if (closedCategory?.type === ChannelType.GuildCategory && ticket.close_behavior !== "stay") {
      await interaction.channel.setParent(closedCategory.id, { lockPermissions: false }).catch(() => null);
    }

    await interaction.channel.send(buildClosedTicketView(next));
    await addTicketEvent(ticket.id, "TICKET_CLOSED", interaction.user.id, {
      duration: formatDuration(ticket.created_at),
      transcript: transcriptUrl || "not created",
    });

    if (reply) await respond(interaction, ephemeral("Ticket closed."));
    await writeTicketLog(interaction.guild, next, "TICKET_CLOSED", interaction.user.id, {
      transcript: transcriptUrl || "not created",
    });
    return next;
  }

  async reopen(interaction, ticket) {
    this.assertStaff(interaction.member, ticket);
    if (ticket.status === "open" || ticket.status === "locked") {
      await respond(interaction, ephemeral("This ticket is already open."));
      return ticket;
    }
    if (ticket.status === "deleted") throw new Error("This ticket has been deleted.");

    transitionTicket(ticket.status, "reopen");
    const next = await updateTicket(ticket.id, {
      status: "open",
      reopened_at: new Date(),
      closed_at: null,
    });

    await interaction.channel.permissionOverwrites.edit(ticket.owner_id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
    }).catch(() => null);

    if (ticket.category_id) {
      const category = await interaction.guild.channels.fetch(ticket.category_id).catch(() => null);
      if (category?.type === ChannelType.GuildCategory) {
        await interaction.channel.setParent(category.id, { lockPermissions: false }).catch(() => null);
      }
    }

    await interaction.channel.send(buildTicketView(next, { welcome_message: "This ticket has been reopened." }));
    await addTicketEvent(ticket.id, "TICKET_REOPENED", interaction.user.id);
    await respond(interaction, ephemeral("Ticket reopened."));
    await writeTicketLog(interaction.guild, next, "TICKET_REOPENED", interaction.user.id);
    return next;
  }

  async lock(interaction, ticket) {
    this.assertStaff(interaction.member, ticket);
    if (ticket.status === "locked") return respond(interaction, ephemeral("This ticket is already locked."));
    if (ticket.status !== "open") throw new Error("Only open tickets can be locked.");

    transitionTicket(ticket.status, "lock");
    let next;
    try {
      await interaction.channel.permissionOverwrites.edit(ticket.owner_id, { SendMessages: false });
      next = await updateTicket(ticket.id, { status: "locked" });
    } catch (error) {
      await updateTicket(ticket.id, { status: "open" }).catch(() => null);
      throw new Error(`Ticket lock failed: ${error?.message || "permission update failed"}`);
    }
    await addTicketEvent(ticket.id, "TICKET_LOCKED", interaction.user.id);
    await respond(interaction, ephemeral("Ticket locked."));
    await writeTicketLog(interaction.guild, next, "TICKET_LOCKED", interaction.user.id);
    return next;
  }

  async unlock(interaction, ticket) {
    this.assertStaff(interaction.member, ticket);
    if (ticket.status !== "locked") {
      if (ticket.status === "open") return respond(interaction, ephemeral("This ticket is already unlocked."));
      throw new Error("Only locked tickets can be unlocked.");
    }

    transitionTicket(ticket.status, "unlock");
    let next;
    try {
      await interaction.channel.permissionOverwrites.edit(ticket.owner_id, { SendMessages: true });
      next = await updateTicket(ticket.id, { status: "open" });
    } catch (error) {
      await updateTicket(ticket.id, { status: "locked" }).catch(() => null);
      throw new Error(`Ticket unlock failed: ${error?.message || "permission update failed"}`);
    }
    await addTicketEvent(ticket.id, "TICKET_UNLOCKED", interaction.user.id);
    await respond(interaction, ephemeral("Ticket unlocked."));
    await writeTicketLog(interaction.guild, next, "TICKET_UNLOCKED", interaction.user.id);
    return next;
  }

  async rename(interaction, ticket, name) {
    this.assertStaff(interaction.member, ticket);
    const safe = sanitizeChannelName(name);
    await interaction.channel.setName(safe);
    await addTicketEvent(ticket.id, "TICKET_RENAMED", interaction.user.id, { name: safe });
    await respond(interaction, ephemeral(`Ticket renamed to \`${safe}\`.`));
    await writeTicketLog(interaction.guild, ticket, "TICKET_RENAMED", interaction.user.id, { name: safe });
  }

  async addMember(interaction, ticket, userId) {
    this.assertStaff(interaction.member, ticket);
    const member = await interaction.guild.members.fetch(userId).catch(() => null);
    if (!member) throw new Error("User was not found in this server.");
    if (userId === ticket.owner_id) throw new Error("The ticket owner is already a member.");

    await interaction.channel.permissionOverwrites.edit(userId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      AttachFiles: true,
      EmbedLinks: true,
    });
    await addTicketMember(ticket.id, userId, interaction.user.id);
    await addTicketEvent(ticket.id, "MEMBER_ADDED", interaction.user.id, { user: userId });
    await respond(interaction, ephemeral(`Added <@${userId}> to the ticket.`));
    await writeTicketLog(interaction.guild, ticket, "MEMBER_ADDED", interaction.user.id, { user: userId });
  }

  async removeMember(interaction, ticket, userId) {
    this.assertStaff(interaction.member, ticket);
    if (userId === ticket.owner_id) throw new Error("The ticket owner cannot be removed.");
    await interaction.channel.permissionOverwrites.delete(userId).catch(() => null);
    await removeTicketMember(ticket.id, userId);
    await addTicketEvent(ticket.id, "MEMBER_REMOVED", interaction.user.id, { user: userId });
    await respond(interaction, ephemeral(`Removed <@${userId}> from the ticket.`));
    await writeTicketLog(interaction.guild, ticket, "MEMBER_REMOVED", interaction.user.id, { user: userId });
  }

  async info(interaction, ticket) {
    if (!this.canClose(interaction.member, ticket)) {
      throw new Error("Only the ticket owner or configured staff can view this ticket.");
    }
    const members = await listTicketMembers(ticket.id);
    await respond(interaction, {
      content: [
        `Ticket: ${ticket.ticket_key}`,
        `Type: ${ticket.type_label}`,
        `Owner: <@${ticket.owner_id}>`,
        `Status: ${ticket.status}`,
        `Claimed: ${ticket.claimed_by ? `<@${ticket.claimed_by}>` : "Unclaimed"}`,
        `Created: <t:${Math.floor(new Date(ticket.created_at).getTime() / 1000)}:F>`,
        `Added users: ${members.length ? members.map((id) => `<@${id}>`).join(", ") : "None"}`,
      ].join("\n"),
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }

  async delete(interaction, ticket) {
    this.assertStaff(interaction.member, ticket);
    if (ticket.status === "deleted") {
      await respond(interaction, ephemeral("This ticket is already deleted."));
      return;
    }
    if (ticket.status !== "closed") {
      ticket = await this.close(interaction, ticket, { reply: false });
    }

    await transitionTicket(ticket.status, "delete");
    await updateTicket(ticket.id, { status: "deleted", deleted_at: new Date() });
    await addTicketEvent(ticket.id, "TICKET_DELETED", interaction.user.id);
    await writeTicketLog(interaction.guild, ticket, "TICKET_DELETED", interaction.user.id);
    await respond(interaction, ephemeral("Deleting ticket…"));
    await interaction.channel.delete("Evix ticket deleted").catch((error) => {
      console.error("[evix-ticket-delete-error]", error);
    });
  }

  async createTranscript(interaction, ticket, silent = false) {
    const transcript = await buildTranscript(interaction.channel, ticket);
    if (!ticket.transcript_channel_id) {
      if (!silent) await interaction.followUp(ephemeral("Transcript channel is not configured.")).catch(() => null);
      return null;
    }

    const destination = await interaction.guild.channels.fetch(ticket.transcript_channel_id).catch(() => null);
    if (!destination?.isTextBased?.()) {
      if (!silent) await interaction.followUp(ephemeral("The configured transcript channel is unavailable.")).catch(() => null);
      return null;
    }

    const message = await destination.send({
      content: `Transcript — ${ticket.ticket_key} · ${transcript.messageCount} messages`,
      files: [transcriptAttachment(transcript.buffer, transcript.fileName)],
      allowedMentions: { parse: [] },
    });
    return message.url;
  }

  async sendTranscript(interaction, ticket) {
    this.assertStaff(interaction.member, ticket);
    const transcript = await buildTranscript(interaction.channel, ticket);
    await respond(interaction, {
      content: `Transcript generated for ${ticket.ticket_key}.`,
      files: [transcriptAttachment(transcript.buffer, transcript.fileName)],
      flags: MessageFlags.Ephemeral,
    });
    await addTicketEvent(ticket.id, "TRANSCRIPT_CREATED", interaction.user.id, {
      messages: transcript.messageCount,
    });
  }
}
