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
import { buildClosedTicketView, buildDeleteConfirmation, buildTicketView } from "./ui.js";
import { buildTranscript, transcriptAttachment } from "./transcript.js";
import { transitionTicket } from "./state.js";
import { categoryCandidates, findTicketCreationCategory, moveTicketChannel } from "./routing.js";
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

function statusIsActive(status) {
  return ["open", "locked", "waiting"].includes(status);
}

export class TicketService {
  constructor(client) {
    this.client = client;
  }

  async getSettings(guildId) {
    return (await getGuildSettings(guildId)) ?? {
      guild_id: guildId,
      ticket_category_id: null,
      open_category_id: null,
      backup_category_id: null,
      waiting_category_id: null,
      closed_category_id: null,
      ticket_log_channel_id: null,
      moderation_log_channel_id: null,
      transcript_log_channel_id: null,
      log_channel_id: null,
      transcript_channel_id: null,
      default_ticket_limit: 1,
    };
  }

  canManageTicket(member, ticket) {
    return Boolean(
      member?.permissions?.has(PermissionFlagsBits.ManageChannels)
      || isStaff(member, unique(ticket.staff_roles)),
    );
  }

  assertStaff(member, ticket) {
    if (!this.canManageTicket(member, ticket)) {
      throw new Error("You are not authorized to manage this ticket.");
    }
  }

  canClose(member, ticket) {
    return member?.id === ticket.owner_id || this.canManageTicket(member, ticket);
  }

  async getTicket(interaction, ticketId = null) {
    const ticket = await getTicketByChannel(interaction.guildId, interaction.channelId);
    if (!ticket) throw new Error("This channel is not an Evix ticket.");
    if (ticketId !== null && String(ticket.id) !== String(ticketId)) {
      throw new Error("This ticket is not available in the current channel.");
    }
    return ticket;
  }

  async findCategoryForCreate(guild, categoryIds) {
    const failures = [];
    for (const categoryId of unique(categoryIds)) {
      try {
        const result = await findTicketCreationCategory(guild, [categoryId]);
        return { ...result, failures };
      } catch (error) {
        failures.push({ categoryId, reason: error?.message || "Unavailable." });
      }
    }
    const error = new Error(
      failures.length ? failures.map((item) => item.reason).join(" ") : "No ticket category is configured.",
    );
    error.code = "EVIX_NO_TICKET_CATEGORY";
    throw error;
  }

  async createFromOption(interaction, option, formValues = {}) {
    const settings = await this.getSettings(interaction.guildId);
    const primaryCategory = option.category_id || settings.ticket_category_id || settings.open_category_id;
    const categoryIds = categoryCandidates(primaryCategory, settings.backup_category_id);

    if (!primaryCategory) throw new Error("Configure the main Tickets category with /ticket setup before opening tickets.");

    if (!option.allow_multiple) {
      const existing = await getOpenTicketForUser(interaction.guildId, interaction.user.id, option.id);
      if (existing) {
        await respond(interaction, ephemeral(
          "You already have an open " + option.label + " ticket: <#" + existing.channel_id + ">",
        ));
        return existing;
      }
    }

    const limit = Number(settings.default_ticket_limit ?? 1);
    if (await countOpenTickets(interaction.guildId, interaction.user.id) >= limit) {
      throw new Error("You have reached the open ticket limit (" + limit + ").");
    }

    const formText = Object.entries(formValues)
      .filter(([, value]) => String(value ?? "").trim())
      .map(([fieldId, value]) => {
        const field = (option.modal_fields ?? []).find((entry) => entry.id === fieldId);
        return "**" + (field?.label || fieldId) + ":** " + String(value).slice(0, 1000);
      })
      .join("\n");

    const storedWelcome = [
      option.welcome_message || "Thanks for opening a ticket. A member of the team will be with you shortly.",
      formText ? "\n**Request details**\n" + formText : "",
    ].filter(Boolean).join("\n");

    const me = interaction.guild.members.me ?? await interaction.guild.members.fetchMe();
    const staffRoles = unique(option.staff_roles);
    const pingRoles = unique(option.ping_roles);
    for (const roleId of [...staffRoles, ...pingRoles]) {
      if (!await interaction.guild.roles.fetch(roleId).catch(() => null)) {
        throw new Error("Configured role " + roleId + " no longer exists.");
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

    let channel = null;
    let category = null;
    let categoryFailures = [];
    let lastCreateError = null;

    for (const categoryId of categoryIds) {
      let found;
      try {
        found = await this.findCategoryForCreate(interaction.guild, [categoryId]);
      } catch (error) {
        categoryFailures.push({ categoryId, reason: error?.message || "Category unavailable." });
        continue;
      }

      category = found.category;
      try {
        channel = await interaction.guild.channels.create({
          name: "creating-ticket",
          type: ChannelType.GuildText,
          parent: category.id,
          reason: "Evix ticket for " + interaction.user.tag + " (" + option.label + ")",
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
        break;
      } catch (error) {
        lastCreateError = error;
        categoryFailures.push({ categoryId, reason: error?.message || "Channel creation failed." });
        channel = null;
      }
    }

    if (!channel || !category) {
      throw new Error(
        lastCreateError?.message || categoryFailures.map((item) => item.reason).join(" ") || "Evix could not create the ticket channel.",
      );
    }

    const actualCategoryId = category.id;
    const usedBackup = String(actualCategoryId) !== String(primaryCategory);

    let ticket;
    try {
      ticket = await createTicket({
        guildId: interaction.guildId,
        panelId: option.panel_id,
        optionId: option.id,
        channelId: channel.id,
        ownerId: interaction.user.id,
        typeLabel: option.label,
        categoryId: actualCategoryId,
        closedCategoryId: option.closed_category_id || settings.closed_category_id,
        staffRoles,
        pingRoles,
        dedupeKey: option.allow_multiple ? null : interaction.guildId + ":" + interaction.user.id + ":" + option.id,
        logChannelId: option.log_channel_id || settings.ticket_log_channel_id || settings.log_channel_id,
        moderationLogChannelId: option.moderation_log_channel_id || settings.moderation_log_channel_id,
        transcriptChannelId: option.transcript_channel_id || settings.transcript_log_channel_id || settings.transcript_channel_id,
        ticketLimit: limit,
        welcomeMessage: storedWelcome,
        closeBehavior: option.close_behavior || "move",
        transcriptOnClose: option.transcript_on_close !== false,
      });
    } catch (error) {
      await channel.delete("Evix ticket creation compensation").catch(() => null);
      if (error?.code === "EVIX_TICKET_LIMIT") throw error;
      if (error?.code === "23505") {
        const existing = await getOpenTicketForUser(interaction.guildId, interaction.user.id, option.id);
        if (existing) {
          await respond(interaction, ephemeral(
            "You already have an open " + option.label + " ticket: <#" + existing.channel_id + ">",
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
      category: actualCategoryId,
      backup: usedBackup,
      form: formValues,
    });

    if (usedBackup) {
      await addTicketEvent(ticket.id, "TICKET_CATEGORY_FALLBACK", interaction.user.id, {
        primary_category: primaryCategory,
        category: actualCategoryId,
      });
    }

    const welcome = [
      pingRoles.length ? pingRoles.map((id) => "<@&" + id + ">").join(" ") : "",
      storedWelcome,
    ].filter(Boolean).join("\n");

    const view = buildTicketView(ticket, { ...option, welcome_message: welcome });
    view.allowedMentions = {
      parse: [],
      roles: pingRoles,
      users: [interaction.user.id],
    };

    try {
      const controlMessage = await channel.send(view);
      const withControl = await updateTicket(ticket.id, { control_message_id: controlMessage.id });
      if (!withControl) throw new Error("Ticket control message could not be persisted.");
    } catch (error) {
      await updateTicket(ticket.id, { status: "deleted", deleted_at: new Date() }).catch(() => null);
      await addTicketEvent(ticket.id, "TICKET_CREATE_FAILED", interaction.user.id, {
        stage: "welcome_message",
      }).catch(() => null);
      await channel.delete("Evix ticket creation compensation").catch(() => null);
      throw new Error("Ticket channel was created but the welcome message failed: " + (error?.message || "unknown error"));
    }

    await respond(interaction, ephemeral("Your ticket " + ticket.ticket_key + " has been created: " + channel));
    await writeTicketLog(interaction.guild, ticket, "TICKET_CREATED", interaction.user.id, {
      category: actualCategoryId,
      backup: usedBackup ? "yes" : "no",
    });
    return ticket;
  }

  async refreshControlMessage(interaction, ticket, { closed = false, welcomeOverride = null } = {}) {
    const payload = closed
      ? buildClosedTicketView(ticket)
      : buildTicketView(ticket, {
        welcome_message: welcomeOverride ?? ticket.welcome_message
          ?? "Thanks for opening a ticket. A member of the team will be with you shortly.",
      });

    const channel = await interaction.guild.channels.fetch(ticket.channel_id).catch(() => null);
    if (!channel?.isTextBased?.()) return ticket;

    const oldMessageId = ticket.control_message_id;
    const message = oldMessageId
      ? await channel.messages.fetch(oldMessageId).catch(() => null)
      : null;

    if (message) {
      try {
        await message.edit(payload);
        return ticket;
      } catch (error) {
        console.error("[evix-ticket-control-edit-error]", error);
      }
    }

    try {
      const newMessage = await channel.send(payload);
      const next = await updateTicket(ticket.id, { control_message_id: newMessage.id });
      if (oldMessageId && oldMessageId !== newMessage.id) {
        await channel.messages.delete(oldMessageId, "Evix stale ticket control").catch(() => null);
      }
      return next ?? { ...ticket, control_message_id: newMessage.id };
    } catch (error) {
      console.error("[evix-ticket-control-send-error]", error);
      return ticket;
    }
  }

  async setParticipantPermissions(
    interaction,
    ticket,
    { view = true, send = true, rollbackTo = { view: true, send: true }, bestEffort = false } = {},
  ) {
    const memberIds = unique([ticket.owner_id, ...(await listTicketMembers(ticket.id))]);
    const changed = [];
    const failed = [];

    for (const userId of memberIds) {
      try {
        await interaction.channel.permissionOverwrites.edit(userId, {
          ViewChannel: view,
          SendMessages: send,
          ReadMessageHistory: view,
        });
        changed.push(userId);
      } catch (error) {
        failed.push({ userId, error });
        if (!bestEffort) {
          for (const changedUserId of changed) {
            await interaction.channel.permissionOverwrites.edit(changedUserId, {
              ViewChannel: rollbackTo.view,
              SendMessages: rollbackTo.send,
              ReadMessageHistory: rollbackTo.view,
            }).catch(() => null);
          }
          throw error;
        }
      }
    }

    if (failed.length) {
      console.error("[evix-participant-permission-failures]", failed.map(({ userId, error }) => ({
        userId,
        message: error?.message || "unknown error",
      })));
    }

    return { changed, failed };
  }

  async claim(interaction, ticket) {
    this.assertStaff(interaction.member, ticket);
    if (ticket.status !== "open") throw new Error("Only open tickets can be claimed.");
    if (ticket.claimed_by === interaction.user.id) {
      return respond(interaction, ephemeral("You already have this ticket claimed."));
    }
    if (ticket.claimed_by) throw new Error("This ticket is already claimed by <@" + ticket.claimed_by + ">.");

    const next = await updateTicket(
      ticket.id,
      { claimed_by: interaction.user.id },
      { statuses: ["open"], claimedBy: null },
    );
    if (!next) throw new Error("This ticket was changed by another staff member. Please try again.");

    await addTicketEvent(ticket.id, "TICKET_CLAIMED", interaction.user.id);
    await respond(interaction, ephemeral("Ticket claimed."));
    await this.refreshControlMessage(interaction, next);
    await writeTicketLog(interaction.guild, next, "TICKET_CLAIMED", interaction.user.id);
    return next;
  }

  async unclaim(interaction, ticket) {
    this.assertStaff(interaction.member, ticket);
    if (!ticket.claimed_by) return respond(interaction, ephemeral("This ticket is not claimed."));

    const next = await updateTicket(
      ticket.id,
      { claimed_by: null },
      { statuses: ["open", "locked", "waiting"], claimedBy: ticket.claimed_by },
    );
    if (!next) throw new Error("This ticket was changed by another staff member. Please try again.");

    await addTicketEvent(ticket.id, "TICKET_UNCLAIMED", interaction.user.id);
    await respond(interaction, ephemeral("Ticket unclaimed."));
    await this.refreshControlMessage(interaction, next);
    await writeTicketLog(interaction.guild, next, "TICKET_UNCLAIMED", interaction.user.id);
    return next;
  }

  async waiting(interaction, ticket) {
    this.assertStaff(interaction.member, ticket);
    if (ticket.status === "closed" || ticket.status === "deleted") {
      throw new Error("Only active tickets can be moved to waiting.");
    }

    const nextStatus = transitionTicket(ticket.status, "waiting");
    const settings = await this.getSettings(interaction.guildId);
    let currentCategoryId = ticket.current_category_id || ticket.category_id;
    let routingWarning = null;

    try {
      await this.setParticipantPermissions(interaction, ticket, {
        view: true,
        send: true,
        rollbackTo: { view: ticket.status !== "closed", send: ticket.status !== "locked" },
      });
    } catch (error) {
      throw new Error("Ticket waiting transition failed: " + (error?.message || "permission update failed"));
    }

    if (nextStatus === "waiting" && settings.waiting_category_id) {
      try {
        const moved = await moveTicketChannel(interaction.channel, settings.waiting_category_id);
        if (moved) currentCategoryId = moved.id;
      } catch (error) {
        routingWarning = error?.message || "Waiting category could not be used.";
      }
    } else if (nextStatus === "open") {
      const candidates = categoryCandidates(
        ticket.category_id || settings.ticket_category_id || settings.open_category_id,
        settings.backup_category_id,
      );
      try {
        const target = await this.findCategoryForCreate(interaction.guild, candidates);
        const moved = await moveTicketChannel(interaction.channel, target.category.id);
        if (moved) currentCategoryId = moved.id;
      } catch (error) {
        routingWarning = error?.message || "The ticket category could not be restored.";
      }
    }

    const next = await updateTicket(
      ticket.id,
      {
        status: nextStatus,
        waiting_at: nextStatus === "waiting" ? new Date() : null,
        current_category_id: currentCategoryId,
        claimed_by: nextStatus === "waiting" ? ticket.claimed_by : ticket.claimed_by,
      },
      { statuses: statusIsActive(ticket.status) ? [ticket.status] : [] },
    );

    if (!next) throw new Error("This ticket was changed by another action. Please try again.");

    await addTicketEvent(ticket.id, "TICKET_WAITING", interaction.user.id, {
      status: nextStatus,
      category: currentCategoryId,
      warning: routingWarning || "none",
    });
    await this.refreshControlMessage(interaction, next);
    const message = nextStatus === "waiting" ? "Ticket marked as waiting." : "Ticket resumed.";
    await respond(interaction, ephemeral(routingWarning ? message + " " + routingWarning : message));
    await writeTicketLog(interaction.guild, next, "TICKET_WAITING", interaction.user.id, {
      status: nextStatus,
      category: currentCategoryId,
      warning: routingWarning || "none",
    });
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

    let next = await updateTicket(
      ticket.id,
      { status: "closed", closed_at: new Date(), claimed_by: null },
      { statuses: ["open", "locked", "waiting"] },
    );

    if (!next) {
      if (reply) await respond(interaction, ephemeral("This ticket was already closed by another action."));
      return (await getTicketByChannel(interaction.guildId, interaction.channelId)) ?? ticket;
    }

    let transcriptUrl = next.transcript_url || null;
    if (next.transcript_on_close !== false && !transcriptUrl) {
      try {
        transcriptUrl = await this.createTranscript(interaction, next, true);
        if (transcriptUrl) {
          next = await updateTicket(next.id, { transcript_url: transcriptUrl }, { statuses: ["closed"] })
            ?? { ...next, transcript_url: transcriptUrl };
        }
      } catch (error) {
        console.error("[evix-close-transcript-error]", error);
      }
    }

    try {
      await this.setParticipantPermissions(interaction, next, {
        view: false,
        send: false,
        rollbackTo: { view: true, send: true },
      });
    } catch (error) {
      await updateTicket(
        ticket.id,
        { status: ticket.status, closed_at: null, claimed_by: ticket.claimed_by, waiting_at: ticket.waiting_at },
        { statuses: ["closed"] },
      ).catch((rollbackError) => console.error("[evix-close-state-rollback-error]", rollbackError));
      throw new Error("Ticket close failed: " + (error?.message || "permission update failed"));
    }

    let currentCategoryId = next.current_category_id || next.category_id;
    if (next.closed_category_id && next.close_behavior !== "stay") {
      try {
        const moved = await moveTicketChannel(interaction.channel, next.closed_category_id);
        if (moved) {
          currentCategoryId = moved.id;
          next = await updateTicket(next.id, { current_category_id: moved.id }, { statuses: ["closed"] }) ?? next;
        }
      } catch (error) {
        console.error("[evix-close-category-error]", error);
      }
    }

    next = await this.refreshControlMessage(interaction, next, { closed: true }) ?? next;

    await addTicketEvent(next.id, "TICKET_CLOSED", interaction.user.id, {
      duration: formatDuration(ticket.created_at),
      transcript: transcriptUrl || "not created",
      category: currentCategoryId,
    });

    if (reply) await respond(interaction, ephemeral("Ticket closed."));
    await writeTicketLog(interaction.guild, next, "TICKET_CLOSED", interaction.user.id, {
      transcript: transcriptUrl || "not created",
      category: currentCategoryId,
    });
    return next;
  }

  async reopen(interaction, ticket) {
    this.assertStaff(interaction.member, ticket);
    if (ticket.status === "open" || ticket.status === "locked" || ticket.status === "waiting") {
      await respond(interaction, ephemeral("This ticket is already active."));
      return ticket;
    }
    if (ticket.status === "deleted") throw new Error("This ticket has been deleted.");

    transitionTicket(ticket.status, "reopen");

    try {
      await this.setParticipantPermissions(interaction, ticket, {
        view: true,
        send: true,
        rollbackTo: { view: false, send: false },
      });
    } catch (error) {
      throw new Error("Ticket reopen failed: " + (error?.message || "permission update failed"));
    }

    const settings = await this.getSettings(interaction.guildId);
    const candidates = categoryCandidates(
      ticket.category_id || settings.ticket_category_id || settings.open_category_id,
      settings.backup_category_id,
    );

    let target;
    try {
      target = await this.findCategoryForCreate(interaction.guild, candidates);
      await moveTicketChannel(interaction.channel, target.category.id);
    } catch (error) {
      await this.setParticipantPermissions(interaction, ticket, {
        view: false,
        send: false,
        bestEffort: true,
      });
      throw new Error("Ticket reopen routing failed: " + (error?.message || "ticket category unavailable"));
    }

    let next = await updateTicket(
      ticket.id,
      {
        status: "open",
        reopened_at: new Date(),
        closed_at: null,
        waiting_at: null,
        current_category_id: target.category.id,
      },
      { statuses: ["closed"] },
    );

    if (!next) {
      await this.setParticipantPermissions(interaction, ticket, { view: false, send: false, bestEffort: true });
      await moveTicketChannel(interaction.channel, ticket.current_category_id).catch(() => null);
      throw new Error("This ticket was changed by another action. Please try again.");
    }

    next = await this.refreshControlMessage(interaction, next, {
      welcomeOverride: "This ticket has been reopened.",
    }) ?? next;

    await addTicketEvent(next.id, "TICKET_REOPENED", interaction.user.id, { category: target.category.id });
    await respond(interaction, ephemeral("Ticket reopened."));
    await writeTicketLog(interaction.guild, next, "TICKET_REOPENED", interaction.user.id, { category: target.category.id });
    return next;
  }

  async lock(interaction, ticket) {
    this.assertStaff(interaction.member, ticket);
    if (ticket.status === "locked") return respond(interaction, ephemeral("This ticket is already locked."));
    if (ticket.status !== "open") throw new Error("Only open tickets can be locked.");

    transitionTicket(ticket.status, "lock");
    try {
      await this.setParticipantPermissions(interaction, ticket, {
        view: true,
        send: false,
        rollbackTo: { view: true, send: true },
      });
    } catch (error) {
      throw new Error("Ticket lock failed: " + (error?.message || "permission update failed"));
    }

    const next = await updateTicket(ticket.id, { status: "locked" }, { statuses: ["open"] });
    if (!next) {
      await this.setParticipantPermissions(interaction, ticket, { view: true, send: true, bestEffort: true });
      throw new Error("This ticket was changed by another action. Please try again.");
    }

    await addTicketEvent(ticket.id, "TICKET_LOCKED", interaction.user.id);
    await this.refreshControlMessage(interaction, next);
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
    try {
      await this.setParticipantPermissions(interaction, ticket, {
        view: true,
        send: true,
        rollbackTo: { view: true, send: false },
      });
    } catch (error) {
      throw new Error("Ticket unlock failed: " + (error?.message || "permission update failed"));
    }

    const next = await updateTicket(ticket.id, { status: "open" }, { statuses: ["locked"] });
    if (!next) {
      await this.setParticipantPermissions(interaction, ticket, { view: true, send: false, bestEffort: true });
      throw new Error("This ticket was changed by another action. Please try again.");
    }

    await addTicketEvent(ticket.id, "TICKET_UNLOCKED", interaction.user.id);
    await this.refreshControlMessage(interaction, next);
    await respond(interaction, ephemeral("Ticket unlocked."));
    await writeTicketLog(interaction.guild, next, "TICKET_UNLOCKED", interaction.user.id);
    return next;
  }

  async rename(interaction, ticket, name) {
    this.assertStaff(interaction.member, ticket);
    const safe = sanitizeChannelName(name);
    await interaction.channel.setName(safe);
    await addTicketEvent(ticket.id, "TICKET_RENAMED", interaction.user.id, { name: safe });
    await respond(interaction, ephemeral("Ticket renamed to `" + safe + "`."));
    await writeTicketLog(interaction.guild, ticket, "TICKET_RENAMED", interaction.user.id, { name: safe });
  }

  async addMember(interaction, ticket, userId) {
    this.assertStaff(interaction.member, ticket);
    if (ticket.status === "deleted") throw new Error("This ticket has been deleted.");

    const member = await interaction.guild.members.fetch(userId).catch(() => null);
    if (!member) throw new Error("User was not found in this server.");
    if (userId === ticket.owner_id) throw new Error("The ticket owner is already a member.");

    const members = await listTicketMembers(ticket.id);
    if (members.includes(String(userId))) throw new Error("That user is already a member of this ticket.");

    await interaction.channel.permissionOverwrites.edit(userId, {
      ViewChannel: true,
      SendMessages: ticket.status !== "closed",
      ReadMessageHistory: true,
      AttachFiles: true,
      EmbedLinks: true,
    });

    try {
      await addTicketMember(ticket.id, userId, interaction.user.id);
    } catch (error) {
      await interaction.channel.permissionOverwrites.delete(userId).catch(() => null);
      throw error;
    }

    await addTicketEvent(ticket.id, "MEMBER_ADDED", interaction.user.id, { user: userId });
    await respond(interaction, ephemeral("Added <@" + userId + "> to the ticket."));
    await writeTicketLog(interaction.guild, ticket, "MEMBER_ADDED", interaction.user.id, { user: userId });
  }

  async removeMember(interaction, ticket, userId) {
    this.assertStaff(interaction.member, ticket);
    if (userId === ticket.owner_id) throw new Error("The ticket owner cannot be removed.");

    const members = await listTicketMembers(ticket.id);
    if (!members.includes(String(userId))) throw new Error("That user is not an added member of this ticket.");

    await interaction.channel.permissionOverwrites.delete(userId);
    try {
      await removeTicketMember(ticket.id, userId);
    } catch (error) {
      await interaction.channel.permissionOverwrites.edit(userId, {
        ViewChannel: ticket.status !== "closed",
        SendMessages: ticket.status !== "closed",
        ReadMessageHistory: ticket.status !== "closed",
        AttachFiles: true,
        EmbedLinks: true,
      }).catch(() => null);
      throw error;
    }

    await addTicketEvent(ticket.id, "MEMBER_REMOVED", interaction.user.id, { user: userId });
    await respond(interaction, ephemeral("Removed <@" + userId + "> from the ticket."));
    await writeTicketLog(interaction.guild, ticket, "MEMBER_REMOVED", interaction.user.id, { user: userId });
  }

  async info(interaction, ticket) {
    if (!this.canClose(interaction.member, ticket)) {
      throw new Error("Only the ticket owner or configured staff can view this ticket.");
    }
    const members = await listTicketMembers(ticket.id);
    await respond(interaction, {
      content: [
        "Ticket ID: " + ticket.ticket_key,
        "Type: " + ticket.type_label,
        "Owner: <@" + ticket.owner_id + ">",
        "Status: " + ticket.status,
        "Claimed: " + (ticket.claimed_by ? "<@" + ticket.claimed_by + ">" : "Unclaimed"),
        "Category: " + (ticket.current_category_id ? "<#" + ticket.current_category_id + ">" : "None"),
        "Created: <t:" + Math.floor(new Date(ticket.created_at).getTime() / 1000) + ":F>",
        "Added users: " + (members.length ? members.map((id) => "<@" + id + ">").join(", ") : "None"),
      ].join("\n"),
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }

  async requestDelete(interaction, ticket) {
    this.assertStaff(interaction.member, ticket);
    if (ticket.status === "deleted") {
      await respond(interaction, ephemeral("This ticket is already deleted."));
      return ticket;
    }
    await respond(interaction, buildDeleteConfirmation(ticket));
    return ticket;
  }

  async delete(interaction, ticket) {
    this.assertStaff(interaction.member, ticket);
    if (ticket.status === "deleted") {
      await respond(interaction, ephemeral("This ticket is already deleted."));
      return;
    }

    if (ticket.status !== "closed") ticket = await this.close(interaction, ticket, { reply: false });

    transitionTicket(ticket.status, "delete");

    const deleted = await updateTicket(
      ticket.id,
      { status: "deleted", deleted_at: new Date() },
      { statuses: ["closed"] },
    );

    if (!deleted) {
      const current = await getTicketByChannel(interaction.guildId, interaction.channelId);
      if (!current || current.status === "deleted") {
        await respond(interaction, ephemeral("This ticket has already been deleted."));
        return;
      }
      throw new Error("This ticket was changed by another action. Please try again.");
    }

    try {
      await interaction.channel.delete("Evix ticket deleted");
    } catch (error) {
      await updateTicket(
        ticket.id,
        { status: "closed", deleted_at: null },
        { statuses: ["deleted"] },
      ).catch((rollbackError) => console.error("[evix-ticket-delete-rollback-error]", rollbackError));
      throw new Error("Ticket deletion failed: " + (error?.message || "channel deletion failed"));
    }

    await addTicketEvent(ticket.id, "TICKET_DELETED", interaction.user.id);
    await writeTicketLog(interaction.guild, deleted, "TICKET_DELETED", interaction.user.id);
    await respond(interaction, ephemeral("Ticket deleted."));
  }

  async createTranscript(interaction, ticket, silent = false) {
    const transcript = await buildTranscript(interaction.channel, ticket);
    const destinationId = ticket.transcript_log_channel_id || ticket.transcript_channel_id;
    if (!destinationId) {
      if (!silent) await interaction.followUp(ephemeral("Transcript channel is not configured.")).catch(() => null);
      return null;
    }

    const destination = await interaction.guild.channels.fetch(destinationId).catch(() => null);
    if (!destination?.isTextBased?.()) {
      if (!silent) await interaction.followUp(ephemeral("The configured transcript channel is unavailable.")).catch(() => null);
      return null;
    }

    const message = await destination.send({
      content: "Transcript — " + ticket.ticket_key + " · " + transcript.messageCount + " messages",
      files: [transcriptAttachment(transcript.buffer, transcript.fileName)],
      allowedMentions: { parse: [] },
    });
    await addTicketEvent(ticket.id, "TRANSCRIPT_CREATED", null, {
      messages: transcript.messageCount,
      channel: destination.id,
    }).catch(() => null);
    return message.url;
  }

  async sendTranscript(interaction, ticket) {
    this.assertStaff(interaction.member, ticket);
    const transcript = await buildTranscript(interaction.channel, ticket);
    await respond(interaction, {
      content: "Transcript generated for " + ticket.ticket_key + ".",
      files: [transcriptAttachment(transcript.buffer, transcript.fileName)],
      flags: MessageFlags.Ephemeral,
    });
    await addTicketEvent(ticket.id, "TRANSCRIPT_CREATED", interaction.user.id, {
      messages: transcript.messageCount,
      channel: interaction.channel.id,
    });
    await writeTicketLog(interaction.guild, ticket, "TRANSCRIPT_CREATED", interaction.user.id, {
      messages: transcript.messageCount,
    });
  }
}
