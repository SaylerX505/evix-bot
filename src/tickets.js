import { ChannelType, MessageFlags, PermissionFlagsBits } from "discord.js";
import { addTicketEvent, addTicketMember, countOpenTickets, createTicket, getGuildSettings, getOpenTicketForUser, getTicketByChannel, listTicketMembers, removeTicketMember, updateTicket, withTicketActionLock } from "./db.js";
import { writeTicketLog } from "./logs.js";
import { buildActionResult, buildClosedTicketView, buildDeleteConfirmation, buildInfoView, buildTicketView, buildCloseConfirmation } from "./ui.js";
import { buildTranscript, transcriptAttachment } from "./transcript.js";
import { transitionTicket } from "./state.js";
import { categoryCandidates, findTicketCreationCategory, moveTicketChannel } from "./routing.js";
import { formatDuration, isStaff, renderTemplate, sanitizeChannelName, unique } from "./utils.js";

const BOT_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels];

const ticketControlRefreshes = new Map();

function queueTicketControlRefresh(ticketId, callback) {
  const key = String(ticketId);
  const previous = ticketControlRefreshes.get(key) ?? Promise.resolve();
  const next = previous.catch(() => null).then(callback);
  ticketControlRefreshes.set(key, next);
  return next.finally(() => {
    if (ticketControlRefreshes.get(key) === next) ticketControlRefreshes.delete(key);
  });
}

async function respond(interaction, payload) {
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
  return interaction.reply(payload);
}
function ephemeral(content) { return { content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }; }
function statusIsActive(status) { return ["open", "waiting"].includes(status); }
function statusName(status, ticketKey) { return status === "open" ? "ticket-" + ticketKey : status + "-" + ticketKey; }

export class TicketService {
  constructor(client) { this.client = client; }
  withTicketActionLock(ticketId, callback) { return withTicketActionLock(ticketId, callback); }

  async getSettings(guildId) {
    return (await getGuildSettings(guildId)) ?? {
      guild_id: guildId, ticket_category_id: null, open_category_id: null, backup_category_id: null, waiting_category_id: null, closed_category_id: null,
      ticket_log_channel_id: null, moderation_log_channel_id: null, transcript_log_channel_id: null,
      ticket_logs_enabled: true, moderation_logs_enabled: true, transcript_logs_enabled: true,
      log_channel_id: null, transcript_channel_id: null, default_ticket_limit: 1,
    };
  }
  canManageTicket(member, ticket) { return Boolean(member?.permissions?.has(PermissionFlagsBits.ManageChannels) || isStaff(member, unique(ticket.staff_roles))); }
  assertStaff(member, ticket) { if (!this.canManageTicket(member, ticket)) throw new Error("You are not authorized to manage this ticket."); }
  canClose(member, ticket) { return member?.id === ticket.owner_id || this.canManageTicket(member, ticket); }

  async getTicket(interaction, ticketId = null) {
    const ticket = await getTicketByChannel(interaction.guildId, interaction.channelId);
    if (!ticket) throw new Error("This channel is not an Evix ticket.");
    if (ticketId !== null && String(ticket.id) !== String(ticketId)) throw new Error("This ticket is not available in the current channel.");
    return ticket;
  }

  async findCategoryForCreate(guild, categoryIds) {
    const failures = [];
    for (const categoryId of unique(categoryIds)) {
      try { return { ...(await findTicketCreationCategory(guild, [categoryId])), failures }; }
      catch (error) { failures.push({ categoryId, reason: error?.message || "Unavailable." }); }
    }
    const error = new Error(failures.length ? failures.map((item) => item.reason).join(" ") : "No ticket category is configured.");
    error.code = "EVIX_NO_TICKET_CATEGORY";
    throw error;
  }

  async createFromOption(interaction, option, formValues = {}) {
    if (option.action === "NOTHING") throw new Error("This option does not create a ticket.");
    const settings = await this.getSettings(interaction.guildId);
    const primaryCategory = option.category_id || settings.ticket_category_id || settings.open_category_id;
    const categoryIds = categoryCandidates(primaryCategory, settings.backup_category_id);
    if (!primaryCategory) throw new Error("Configure the main Tickets category with /ticket setup before opening tickets.");

    if (!option.allow_multiple) {
      const existing = await getOpenTicketForUser(interaction.guildId, interaction.user.id, option.id);
      if (existing) return respond(interaction, ephemeral("You already have an open " + option.label + " ticket: <#" + existing.channel_id + ">"));
    }
    const limit = Number(settings.default_ticket_limit ?? 1);
    if (await countOpenTickets(interaction.guildId, interaction.user.id) >= limit) throw new Error("You have reached the open ticket limit (" + limit + ").");

    const formText = Object.entries(formValues).filter(([, value]) => String(value ?? "").trim()).map(([fieldId, value]) => {
      const field = (option.modal_fields ?? []).find((entry) => entry.id === fieldId);
      return "**" + (field?.label || fieldId) + ":** " + String(value).slice(0, 1000);
    }).join("\n");
    const storedWelcome = [option.welcome_message || "Thanks for opening a ticket. A member of the team will be with you shortly.", formText ? "\n**Request details**\n" + formText : ""].filter(Boolean).join("\n");

    const me = interaction.guild.members.me ?? await interaction.guild.members.fetchMe();
    const staffRoles = unique(option.staff_roles);
    const pingRoles = unique(option.ping_roles);
    for (const roleId of [...staffRoles, ...pingRoles]) {
      const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
      if (!role) throw new Error("Configured role " + roleId + " no longer exists.");
      if (role.id === interaction.guild.id) throw new Error("The @everyone role cannot be used as a staff or ping role.");
    }
    const roleOverwrites = staffRoles.map((roleId) => ({ id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks] }));

    let channel = null;
    let category = null;
    let lastCreateError = null;
    for (const categoryId of categoryIds) {
      try { ({ category } = await this.findCategoryForCreate(interaction.guild, [categoryId])); }
      catch (error) { lastCreateError = error; continue; }
      try {
        channel = await interaction.guild.channels.create({
          name: "creating-ticket", type: ChannelType.GuildText, parent: category.id,
          reason: "Evix ticket for " + interaction.user.tag + " (" + option.label + ")",
          permissionOverwrites: [
            { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks] },
            ...roleOverwrites,
            { id: me.id, allow: [...BOT_PERMISSIONS, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks] },
          ],
        });
        break;
      } catch (error) { lastCreateError = error; channel = null; }
    }
    if (!channel || !category) throw new Error(lastCreateError?.message || "Evix could not create the ticket channel.");

    const actualCategoryId = category.id;
    const usedBackup = String(actualCategoryId) !== String(primaryCategory);
    let ticket;
    try {
      ticket = await createTicket({
        guildId: interaction.guildId, panelId: option.panel_id, optionId: option.id, channelId: channel.id, ownerId: interaction.user.id,
        typeLabel: option.label, categoryId: actualCategoryId, closedCategoryId: option.closed_category_id || settings.closed_category_id,
        staffRoles, pingRoles, dedupeKey: option.allow_multiple ? null : interaction.guildId + ":" + interaction.user.id + ":" + option.id,
        logChannelId: option.log_channel_id || settings.ticket_log_channel_id || settings.log_channel_id,
        moderationLogChannelId: option.moderation_log_channel_id || settings.moderation_log_channel_id,
        transcriptChannelId: option.transcript_channel_id || settings.transcript_log_channel_id || settings.transcript_channel_id,
        ticketLogsEnabled: settings.ticket_logs_enabled !== false, moderationLogsEnabled: settings.moderation_logs_enabled !== false, transcriptLogsEnabled: settings.transcript_logs_enabled !== false,
        ticketLimit: limit, welcomeMessage: storedWelcome, closeBehavior: option.close_behavior || "move", transcriptOnClose: false,
      });
    } catch (error) {
      await channel.delete("Evix ticket creation compensation").catch(() => null);
      if (error?.code === "EVIX_TICKET_LIMIT") throw error;
      if (error?.code === "23505") {
        const existing = await getOpenTicketForUser(interaction.guildId, interaction.user.id, option.id);
        if (existing) return respond(interaction, ephemeral("You already have an open " + option.label + " ticket: <#" + existing.channel_id + ">"));
      }
      throw error;
    }

    const finalName = sanitizeChannelName(renderTemplate(option.ticket_name_template, { number: ticket.ticket_key, user: interaction.user.id, username: interaction.user.username, type: option.label }));
    await channel.setName(finalName).catch(() => null);

    const welcome = [pingRoles.length ? pingRoles.map((id) => "<@&" + id + ">").join(" ") : "", storedWelcome].filter(Boolean).join("\n");
    const view = buildTicketView(ticket, { ...option, welcome_message: welcome });
    view.allowedMentions = { parse: [], roles: pingRoles, users: [interaction.user.id] };
    try {
      const controlMessage = await channel.send(view);
      const withControl = await updateTicket(ticket.id, { control_message_id: controlMessage.id });
      if (!withControl) throw new Error("Ticket control message could not be persisted.");
    } catch (error) {
      await updateTicket(ticket.id, { status: "deleted", deleted_at: new Date() }).catch(() => null);
      await addTicketEvent(ticket.id, "TICKET_CREATE_FAILED", interaction.user.id, { stage: "welcome_message" }).catch(() => null);
      await channel.delete("Evix ticket creation compensation").catch(() => null);
      throw new Error("Ticket channel was created but the welcome message failed: " + (error?.message || "unknown error"));
    }
    await respond(interaction, buildActionResult("Ticket Created", "Your ticket `" + ticket.ticket_key + "` has been created: " + channel));
    void addTicketEvent(ticket.id, "TICKET_CREATED", interaction.user.id, {
      type: option.label,
      channel: channel.id,
      category: actualCategoryId,
      backup: usedBackup,
      form: formValues,
    }).catch((error) => console.error("[evix-ticket-create-event-error]", error));
    if (usedBackup) {
      void addTicketEvent(ticket.id, "TICKET_CATEGORY_FALLBACK", interaction.user.id, {
        primary_category: primaryCategory,
        category: actualCategoryId,
      }).catch((error) => console.error("[evix-ticket-category-fallback-event-error]", error));
    }
    void writeTicketLog(interaction.guild, ticket, "TICKET_CREATED", interaction.user.id, {
      category: actualCategoryId,
      backup: usedBackup ? "yes" : "no",
    }).catch((error) => console.error("[evix-ticket-create-log-error]", error));
    return ticket;
  }

  async refreshControlMessage(interaction, ticket, { closed = false, welcomeOverride = null, closedBy = null, replace = false } = {}) {
    return queueTicketControlRefresh(ticket.id, async () => {
      const latest = (await getTicketByChannel(interaction.guildId, ticket.channel_id).catch(() => null)) || ticket;
      const renderClosed = latest.status === "closed";
      const payload = renderClosed
        ? buildClosedTicketView({ ...latest, closed_by: closedBy || latest.closed_by })
        : buildTicketView(latest, { welcome_message: welcomeOverride ?? latest.welcome_message ?? "Thanks for opening a ticket. A member of the team will be with you shortly." });
      const channel = await interaction.guild.channels.fetch(latest.channel_id).catch(() => null);
      if (!channel?.isTextBased?.()) return latest;
      const oldMessageId = latest.control_message_id;
      const message = oldMessageId ? await channel.messages.fetch(oldMessageId).catch(() => null) : null;
      if (message && !replace) {
        try { await message.edit(payload); return latest; } catch (error) { console.error("[evix-ticket-control-edit-error]", error); }
      }
      try {
        const newMessage = await channel.send(payload);
        const next = await updateTicket(latest.id, { control_message_id: newMessage.id });
        if (!next) {
          await newMessage.delete("Evix ticket control state persistence failed").catch(() => null);
          throw new Error("Ticket control message state could not be persisted.");
        }
        if (oldMessageId && oldMessageId !== newMessage.id) {
          await channel.messages.delete(oldMessageId, "Evix replaced ticket control view").catch((error) => {
            console.error("[evix-ticket-control-old-message-delete-error]", error);
          });
        }
        return next;
      } catch (error) { console.error("[evix-ticket-control-send-error]", error); return latest; }
    });
  }
  async setParticipantPermissions(interaction, ticket, { view = true, send = true, rollbackTo = { view: true, send: true }, bestEffort = false } = {}) {
    const memberIds = unique([ticket.owner_id, ...(await listTicketMembers(ticket.id))]);
    const changed = [];
    const failed = [];
    for (const userId of memberIds) {
      try { await interaction.channel.permissionOverwrites.edit(userId, { ViewChannel: view, SendMessages: send, ReadMessageHistory: view }); changed.push(userId); }
      catch (error) {
        failed.push({ userId, error });
        if (!bestEffort) {
          for (const changedUserId of changed) await interaction.channel.permissionOverwrites.edit(changedUserId, { ViewChannel: rollbackTo.view, SendMessages: rollbackTo.send, ReadMessageHistory: rollbackTo.view }).catch(() => null);
          throw error;
        }
      }
    }
    if (failed.length) console.error("[evix-participant-permission-failures]", failed.map(({ userId, error }) => ({ userId, message: error?.message || "unknown error" })));
    return { changed, failed };
  }

  async claim(interaction, ticket) {
    this.assertStaff(interaction.member, ticket);
    if (ticket.status !== "open") throw new Error("Only open tickets can be claimed.");
    if (ticket.claimed_by === interaction.user.id) return respond(interaction, buildActionResult("Ticket Claimed", "You already have this ticket claimed."));
    if (ticket.claimed_by) throw new Error("This ticket is already claimed by <@" + ticket.claimed_by + ">.");
    const next = await updateTicket(ticket.id, { claimed_by: interaction.user.id, claimed_at: new Date() }, { statuses: ["open"], claimedBy: null });
    if (!next) throw new Error("This ticket was changed by another staff member. Please try again.");
    await respond(interaction, buildActionResult("Ticket Claimed", "This ticket has been claimed by <@" + interaction.user.id + ">."));
    void addTicketEvent(ticket.id, "TICKET_CLAIMED", interaction.user.id)
      .catch((error) => console.error("[evix-ticket-claim-event-error]", error));
    void this.refreshControlMessage(interaction, next)
      .catch((error) => console.error("[evix-ticket-refresh-after-claim-error]", error));
    void writeTicketLog(interaction.guild, next, "TICKET_CLAIMED", interaction.user.id)
      .catch((error) => console.error("[evix-ticket-claim-log-error]", error));
    return next;
  }

  async unclaim(interaction, ticket) {
    this.assertStaff(interaction.member, ticket);
    if (!ticket.claimed_by) return respond(interaction, buildActionResult("Ticket Unclaimed", "This ticket is not currently claimed."));
    const next = await updateTicket(ticket.id, { claimed_by: null, claimed_at: null }, { statuses: ["open", "waiting"], claimedBy: ticket.claimed_by });
    if (!next) throw new Error("This ticket was changed by another staff member. Please try again.");
    await respond(interaction, buildActionResult("Ticket Unclaimed", "The ticket is available for another staff member to claim."));
    void addTicketEvent(ticket.id, "TICKET_UNCLAIMED", interaction.user.id, { previous_claim: ticket.claimed_by })
      .catch((error) => console.error("[evix-ticket-unclaim-event-error]", error));
    void this.refreshControlMessage(interaction, next)
      .catch((error) => console.error("[evix-ticket-refresh-after-unclaim-error]", error));
    void writeTicketLog(interaction.guild, next, "TICKET_UNCLAIMED", interaction.user.id)
      .catch((error) => console.error("[evix-ticket-unclaim-log-error]", error));
    return next;
  }

  async waiting(interaction, ticket) {
    this.assertStaff(interaction.member, ticket);
    if (ticket.status === "closed" || ticket.status === "deleted") throw new Error("Only active tickets can be moved to waiting.");
    const previousStatus = ticket.status;
    const nextStatus = transitionTicket(previousStatus, "waiting");
    const settings = await this.getSettings(interaction.guildId);
    const originalCategoryId = ticket.current_category_id || ticket.category_id || interaction.channel.parentId || null;
    let currentCategoryId = originalCategoryId;
    let routingWarning = null;

    if (nextStatus === "waiting" && settings.waiting_category_id) {
      try { const moved = await moveTicketChannel(interaction.channel, settings.waiting_category_id); if (moved) currentCategoryId = moved.id; }
      catch (error) { routingWarning = error?.message || "Waiting category could not be used."; }
    } else if (nextStatus === "open") {
      try {
        const target = await this.findCategoryForCreate(interaction.guild, categoryCandidates(ticket.category_id || settings.ticket_category_id || settings.open_category_id, settings.backup_category_id));
        const moved = await moveTicketChannel(interaction.channel, target.category.id); if (moved) currentCategoryId = moved.id;
      } catch (error) { routingWarning = error?.message || "The ticket category could not be restored."; }
    }

    let next = await updateTicket(ticket.id, { status: nextStatus, waiting_at: nextStatus === "waiting" ? new Date() : null, current_category_id: currentCategoryId }, { statuses: [previousStatus] });
    if (!next) {
      if (String(currentCategoryId || "") !== String(originalCategoryId || "")) await moveTicketChannel(interaction.channel, originalCategoryId).catch(() => null);
      throw new Error("This ticket was changed by another action. Please try again.");
    }
    await interaction.channel.setName(statusName(nextStatus, next.ticket_key)).catch(() => null);
    const eventType = nextStatus === "waiting" ? "TICKET_WAITING" : "TICKET_RESUMED";
    const actionMessage = routingWarning
      ? (nextStatus === "waiting" ? "The ticket was moved to waiting. " : "The ticket was resumed. ") + routingWarning
      : (nextStatus === "waiting" ? "The ticket is now waiting for staff handling." : "The ticket is active again.");

    // Button interactions that change ticket state update the public control message
    // directly. Slash commands still receive their normal interaction response.
    if (interaction.isButton?.()) {
      await this.refreshControlMessage(interaction, next);
    } else {
      await respond(
        interaction,
        buildActionResult(
          nextStatus === "waiting" ? "Ticket Waiting" : "Ticket Resumed",
          actionMessage,
        ),
      );
      void this.refreshControlMessage(interaction, next)
        .catch((error) => console.error("[evix-ticket-refresh-after-waiting-error]", error));
    }

    void addTicketEvent(ticket.id, eventType, interaction.user.id, {
      status: nextStatus,
      category: currentCategoryId,
      warning: routingWarning || "none",
    }).catch((error) => console.error("[evix-ticket-event-after-waiting-error]", error));
    void writeTicketLog(interaction.guild, next, eventType, interaction.user.id, {
      status: nextStatus,
      category: currentCategoryId,
    }).catch((error) => console.error("[evix-ticket-log-after-waiting-error]", error));
    return next;
  }

  async resume(interaction, ticket) {
    this.assertStaff(interaction.member, ticket);
    if (ticket.status !== "waiting") {
      if (statusIsActive(ticket.status)) {
        if (interaction.isButton?.()) {
          await this.refreshControlMessage(interaction, ticket);
          return ticket;
        }
        return respond(interaction, buildActionResult("Ticket Already Open", "This ticket is already active."));
      }
      throw new Error("Only waiting tickets can be resumed.");
    }
    transitionTicket(ticket.status, "waiting");

    const previousCategoryId = ticket.current_category_id || interaction.channel.parentId || ticket.category_id || null;
    const next = await updateTicket(
      ticket.id,
      {
        status: "open",
        waiting_at: null,
        current_category_id: previousCategoryId,
      },
      { statuses: ["waiting"] },
    );
    if (!next) throw new Error("This ticket was changed by another action. Please try again.");

    await interaction.channel.setName(statusName("open", next.ticket_key)).catch(() => null);

    // Update the public control message immediately. Category routing can be slower
    // and must not hold the user-facing Resume action hostage.
    await this.refreshControlMessage(interaction, next, {
      welcomeOverride: next.welcome_message || "This ticket has been resumed.",
    });

    let routed = next;
    let routingWarning = null;
    try {
      const settings = await this.getSettings(interaction.guildId);
      const candidates = categoryCandidates(
        ticket.category_id || settings.ticket_category_id || settings.open_category_id,
        settings.backup_category_id,
      );
      const target = await this.findCategoryForCreate(interaction.guild, candidates);
      const moved = await moveTicketChannel(interaction.channel, target.category.id);
      if (moved) {
        routed = await updateTicket(next.id, { current_category_id: moved.id }, { statuses: ["open"] }) ?? {
          ...next,
          current_category_id: moved.id,
        };
        if (String(moved.id) !== String(previousCategoryId || "")) {
          await this.refreshControlMessage(interaction, routed);
        }
      }
    } catch (error) {
      routingWarning = error?.message || "The ticket category could not be restored.";
      console.error("[evix-ticket-resume-routing-error]", error);
    }

    const finalTicket = routed;
    void addTicketEvent(finalTicket.id, "TICKET_RESUMED", interaction.user.id, {
      status: finalTicket.status,
      category: finalTicket.current_category_id,
      warning: routingWarning || "none",
    }).catch((error) => console.error("[evix-ticket-resume-event-error]", error));
    void writeTicketLog(interaction.guild, finalTicket, "TICKET_RESUMED", interaction.user.id, {
      status: finalTicket.status,
      category: finalTicket.current_category_id,
      warning: routingWarning || "none",
    }).catch((error) => console.error("[evix-ticket-resume-log-error]", error));

    return finalTicket;
  }

  async requestClose(interaction, ticket) {
    if (!this.canClose(interaction.member, ticket)) throw new Error("Only the ticket owner or configured staff can close this ticket.");
    if (ticket.status === "closed") {
      await this.refreshControlMessage(interaction, ticket, { closed: true, closedBy: ticket.closed_by });
      return respond(interaction, buildActionResult("Ticket Already Closed", "This ticket is already closed. Use the controls on the closed ticket message."));
    }
    if (ticket.status === "deleted") throw new Error("This ticket has been deleted.");
    return respond(interaction, buildCloseConfirmation(ticket));
  }

  async close(interaction, ticket, { reply = true, closedBy = null, backgroundSideEffects = true } = {}) {
    if (!this.canClose(interaction.member, ticket)) throw new Error("Only the ticket owner or configured staff can close this ticket.");
    if (ticket.status === "closed") return ticket;
    if (ticket.status === "deleted") throw new Error("This ticket has been deleted.");
    transitionTicket(ticket.status, "close");

    let next = await updateTicket(ticket.id, {
      status: "closed",
      closed_at: new Date(),
      closed_by: closedBy || interaction.user.id,
      claimed_by: null,
      claimed_at: null,
    }, { statuses: ["open", "locked", "waiting"] });
    if (!next) throw new Error("This ticket was already closed by another action.");

    try {
      await this.setParticipantPermissions(interaction, next, {
        view: false,
        send: false,
        rollbackTo: { view: true, send: true },
      });
    } catch (error) {
      await updateTicket(
        ticket.id,
        {
          status: ticket.status,
          closed_at: null,
          closed_by: ticket.closed_by,
          claimed_by: ticket.claimed_by,
          claimed_at: ticket.claimed_at,
          waiting_at: ticket.waiting_at,
        },
        { statuses: ["closed"] },
      ).catch(() => null);
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

    await interaction.channel.setName(statusName("closed", next.ticket_key)).catch(() => null);

    if (reply) {
      await respond(interaction, buildActionResult(
        "Ticket Closed",
        "This ticket has been closed by <@" + (closedBy || interaction.user.id) + ">.",
      ));
    }

    // The public control message must become the closed-ticket view immediately.
    // Do this before transcript generation, which can be much slower.
    if (backgroundSideEffects) {
      await this.refreshControlMessage(
        interaction,
        next,
        { closed: true, closedBy: closedBy || interaction.user.id, replace: true },
      );
    }

    const finishSideEffects = async () => {
      await addTicketEvent(next.id, "TICKET_CLOSED", interaction.user.id, {
        duration: formatDuration(ticket.created_at),
        category: currentCategoryId,
      }).catch((error) => console.error("[evix-close-event-error]", error));
      await writeTicketLog(interaction.guild, next, "TICKET_CLOSED", interaction.user.id, {
        duration: formatDuration(ticket.created_at),
        category: currentCategoryId,
      }).catch((error) => console.error("[evix-close-log-error]", error));
      return next;
    };

    if (backgroundSideEffects) {
      void finishSideEffects().catch((error) => console.error("[evix-close-side-effects-error]", error));
      return next;
    }

    return finishSideEffects();
  }
  
  async reopen(interaction, ticket) {
    this.assertStaff(interaction.member, ticket);
    if (statusIsActive(ticket.status)) return respond(interaction, buildActionResult("Ticket Already Open", "This ticket is already active."));
    if (ticket.status === "deleted") throw new Error("This ticket has been deleted.");
    transitionTicket(ticket.status, "reopen");

    const settings = await this.getSettings(interaction.guildId);
    const candidates = categoryCandidates(ticket.category_id || settings.ticket_category_id || settings.open_category_id, settings.backup_category_id);
    const previousCategoryId = ticket.current_category_id || interaction.channel.parentId || null;
    let target;
    try {
      target = await this.findCategoryForCreate(interaction.guild, candidates);
      await moveTicketChannel(interaction.channel, target.category.id);
    } catch (error) {
      throw new Error("Ticket reopen routing failed: " + (error?.message || "ticket category unavailable"));
    }

    const next = await updateTicket(
      ticket.id,
      {
        status: "open",
        reopened_at: new Date(),
        closed_at: null,
        closed_by: null,
        waiting_at: null,
        current_category_id: target.category.id,
      },
      { statuses: ["closed"] },
    );
    if (!next) {
      if (String(target.category.id) !== String(previousCategoryId || "")) await moveTicketChannel(interaction.channel, previousCategoryId).catch(() => null);
      throw new Error("This ticket was changed by another action. Please try again.");
    }

    try {
      await this.setParticipantPermissions(interaction, next, {
        view: true,
        send: true,
        rollbackTo: { view: false, send: false },
      });
    } catch (error) {
      await updateTicket(
        ticket.id,
        {
          status: "closed",
          closed_at: ticket.closed_at,
          closed_by: ticket.closed_by,
          reopened_at: ticket.reopened_at,
          waiting_at: ticket.waiting_at,
          current_category_id: previousCategoryId,
        },
        { statuses: ["open"] },
      ).catch(() => null);
      if (String(target.category.id) !== String(previousCategoryId || "")) await moveTicketChannel(interaction.channel, previousCategoryId).catch(() => null);
      throw new Error("Ticket reopen failed: " + (error?.message || "participant permissions could not be restored"));
    }

    await interaction.channel.setName(statusName("open", next.ticket_key)).catch(() => null);
    await respond(interaction, buildActionResult("Ticket Reopened", "This ticket is open again and ready for handling."));

    void addTicketEvent(next.id, "TICKET_REOPENED", interaction.user.id, { category: target.category.id })
      .catch((error) => console.error("[evix-ticket-reopen-event-error]", error));
    void this.refreshControlMessage(interaction, next, { welcomeOverride: "This ticket has been reopened.", replace: true })
      .catch((error) => console.error("[evix-ticket-refresh-after-reopen-error]", error));
    void writeTicketLog(interaction.guild, next, "TICKET_REOPENED", interaction.user.id, { category: target.category.id })
      .catch((error) => console.error("[evix-ticket-log-after-reopen-error]", error));
    return next;
  }

  async rename(interaction, ticket, name) {
    this.assertStaff(interaction.member, ticket);
    const safe = sanitizeChannelName(name);
    if (!safe) throw new Error("The ticket name cannot be empty.");
    const finalName = statusName(ticket.status, safe);
    await interaction.channel.setName(finalName);
    await respond(interaction, buildActionResult("Ticket Renamed", "The ticket channel is now `" + finalName + "`."));
    void addTicketEvent(ticket.id, "TICKET_RENAMED", interaction.user.id, { name: safe })
      .catch((error) => console.error("[evix-ticket-rename-event-error]", error));
    void writeTicketLog(interaction.guild, ticket, "TICKET_RENAMED", interaction.user.id, { name: safe })
      .catch((error) => console.error("[evix-ticket-rename-log-error]", error));
  }

  async addMember(interaction, ticket, userId) {
    this.assertStaff(interaction.member, ticket);
    if (ticket.status === "deleted") throw new Error("This ticket has been deleted.");
    const member = await interaction.guild.members.fetch(userId).catch(() => null);
    if (!member) throw new Error("User was not found in this server.");
    if (userId === ticket.owner_id) throw new Error("The ticket owner is already a member.");
    const members = await listTicketMembers(ticket.id);
    if (members.includes(String(userId))) throw new Error("That user is already a member of this ticket.");
    await interaction.channel.permissionOverwrites.edit(userId, { ViewChannel: true, SendMessages: ticket.status !== "closed", ReadMessageHistory: true, AttachFiles: true, EmbedLinks: true });
    try { await addTicketMember(ticket.id, userId, interaction.user.id); }
    catch (error) { await interaction.channel.permissionOverwrites.delete(userId).catch(() => null); throw error; }
    await respond(interaction, buildActionResult("User Added", "<@" + interaction.user.id + "> added <@" + userId + "> successfully."));
    void addTicketEvent(ticket.id, "MEMBER_ADDED", interaction.user.id, { user: userId })
      .catch((error) => console.error("[evix-ticket-member-add-event-error]", error));
    void writeTicketLog(interaction.guild, ticket, "MEMBER_ADDED", interaction.user.id, { user: userId })
      .catch((error) => console.error("[evix-ticket-member-add-log-error]", error));
  }

  async addRole(interaction, ticket, roleId) {
    this.assertStaff(interaction.member, ticket);
    const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
    if (!role) throw new Error("Role was not found in this server.");
    if (role.id === interaction.guild.id) throw new Error("The @everyone role cannot be added to a ticket.");
    await interaction.channel.permissionOverwrites.edit(role.id, { ViewChannel: true, SendMessages: ticket.status !== "closed", ReadMessageHistory: true, AttachFiles: true, EmbedLinks: true });
    await respond(interaction, buildActionResult("Role Added", "<@" + interaction.user.id + "> added <@&" + role.id + "> successfully."));
    void addTicketEvent(ticket.id, "ROLE_ADDED", interaction.user.id, { role: role.id })
      .catch((error) => console.error("[evix-ticket-role-add-event-error]", error));
    void writeTicketLog(interaction.guild, ticket, "ROLE_ADDED", interaction.user.id, { role: role.id })
      .catch((error) => console.error("[evix-ticket-role-add-log-error]", error));
  }

  async removeMember(interaction, ticket, userId) {
    this.assertStaff(interaction.member, ticket);
    if (userId === ticket.owner_id) throw new Error("The ticket owner cannot be removed.");
    const members = await listTicketMembers(ticket.id);
    if (!members.includes(String(userId))) throw new Error("That user is not an added member of this ticket.");
    await interaction.channel.permissionOverwrites.delete(userId);
    try { await removeTicketMember(ticket.id, userId); }
    catch (error) {
      await interaction.channel.permissionOverwrites.edit(userId, {
        ViewChannel: true,
        SendMessages: ticket.status !== "closed",
        ReadMessageHistory: true,
        AttachFiles: true,
        EmbedLinks: true,
      }).catch(() => null);
      throw error;
    }
    await respond(interaction, buildActionResult("User Removed", "<@" + interaction.user.id + "> removed <@" + userId + "> successfully."));
    void addTicketEvent(ticket.id, "MEMBER_REMOVED", interaction.user.id, { user: userId })
      .catch((error) => console.error("[evix-ticket-member-remove-event-error]", error));
    void writeTicketLog(interaction.guild, ticket, "MEMBER_REMOVED", interaction.user.id, { user: userId })
      .catch((error) => console.error("[evix-ticket-member-remove-log-error]", error));
  }

  async info(interaction, ticket) {
    if (!this.canClose(interaction.member, ticket)) throw new Error("Only the ticket owner or configured staff can view this ticket.");
    const members = await listTicketMembers(ticket.id);
    await respond(interaction, buildInfoView(ticket, members));
  }

  async requestDelete(interaction, ticket) {
    this.assertStaff(interaction.member, ticket);
    if (ticket.status === "deleted") return respond(interaction, buildActionResult("Ticket Deleted", "This ticket is already deleted."));
    return respond(interaction, buildDeleteConfirmation(ticket));
  }

  async delete(interaction, ticket) {
    this.assertStaff(interaction.member, ticket);
    if (ticket.status === "deleted") return respond(interaction, buildActionResult("Ticket Deleted", "This ticket is already deleted."));
    if (ticket.status !== "closed") ticket = await this.close(interaction, ticket, { reply: false, closedBy: interaction.user.id, backgroundSideEffects: false });
    transitionTicket(ticket.status, "delete");
    const deleted = await updateTicket(ticket.id, { status: "deleted", deleted_at: new Date() }, { statuses: ["closed"] });
    if (!deleted) throw new Error("This ticket was changed by another action. Please try again.");
    try { await interaction.channel.delete("Evix ticket deleted"); }
    catch (error) {
      await updateTicket(ticket.id, { status: "closed", deleted_at: null }, { statuses: ["deleted"] }).catch(() => null);
      throw new Error("Ticket deletion failed: " + (error?.message || "channel deletion failed"));
    }
    void addTicketEvent(ticket.id, "TICKET_DELETED", interaction.user.id)
      .catch((error) => console.error("[evix-ticket-delete-event-error]", error));
    void writeTicketLog(interaction.guild, deleted, "TICKET_DELETED", interaction.user.id)
      .catch((error) => console.error("[evix-ticket-delete-log-error]", error));
  }

  async sendTranscript(interaction, ticket) {
    this.assertStaff(interaction.member, ticket);
    const transcript = await buildTranscript(interaction.channel, ticket);
    await respond(interaction, { ...buildActionResult("Transcript Ready", "Transcript generated for `" + ticket.ticket_key + "`."), files: [transcriptAttachment(transcript.buffer, transcript.fileName)], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
    void addTicketEvent(ticket.id, "TRANSCRIPT_CREATED", interaction.user.id, {
      messages: transcript.messageCount,
      channel: interaction.channel.id,
    }).catch((error) => console.error("[evix-ticket-transcript-event-error]", error));
    void writeTicketLog(interaction.guild, ticket, "TRANSCRIPT_CREATED", interaction.user.id, { messages: transcript.messageCount })
      .catch((error) => console.error("[evix-ticket-transcript-log-error]", error));
  }
}
