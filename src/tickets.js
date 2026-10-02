import { ChannelType, MessageFlags, PermissionFlagsBits } from "discord.js";
import { addTicketEvent, addTicketMember, createTicket, getGuildSettings, getOpenTicketForUser, getTicketByChannel, getTicketById, listTicketMembers, removeTicketMember, updateTicket, withTicketActionLock } from "./db.js";
import { writeTicketLog } from "./logs.js";
import { buildActionResult, buildClaimResult, buildClosedTicketView, buildDeleteConfirmation, buildInfoView, buildTicketView, buildCloseConfirmation } from "./ui.js";
import { buildTranscript, transcriptAttachment } from "./transcript.js";
import { transitionTicket } from "./state.js";
import { categoryCandidates, findTicketCreationCategory, findTicketReopenCategory, moveTicketChannel } from "./routing.js";
import { formatDuration, isStaff, renderTemplate, sanitizeChannelName, unique, validateModalFields } from "./utils.js";

const BOT_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels];

const ticketControlRefreshes = new Map();
const ticketChannelNameChanges = new Map();

function queueTicketChannelName(ticketId, callback) {
  const key = String(ticketId);
  const previous = ticketChannelNameChanges.get(key) ?? Promise.resolve();
  const next = previous.catch(() => null).then(callback);
  ticketChannelNameChanges.set(key, next);
  return next.finally(() => {
    if (ticketChannelNameChanges.get(key) === next) ticketChannelNameChanges.delete(key);
  });
}

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
function statusIsActive(status) { return status === "open"; }
function statusName(status, ticketKey) { return status === "open" ? "ticket-" + ticketKey : status + "-" + ticketKey; }

export class TicketService {
  constructor(client) { this.client = client; }
  withTicketActionLock(ticketId, callback) { return withTicketActionLock(ticketId, callback); }
  queueChannelName(ticketId, callback) { return queueTicketChannelName(ticketId, callback); }

  async getSettings(guildId) {
    return (await getGuildSettings(guildId)) ?? {
      guild_id: guildId, ticket_category_id: null, open_category_id: null, backup_category_id: null, closed_category_id: null,
      ticket_log_channel_id: null, moderation_log_channel_id: null, transcript_log_channel_id: null,
      ticket_logs_enabled: true, moderation_logs_enabled: true, transcript_logs_enabled: true,
      log_channel_id: null, transcript_channel_id: null, default_ticket_limit: 1,
    };
  }
  canManageTicket(member, ticket) { return Boolean(member?.permissions?.has(PermissionFlagsBits.ManageChannels) || isStaff(member, unique(ticket.staff_roles))); }
  assertStaff(member, ticket) { if (!this.canManageTicket(member, ticket)) throw new Error("You are not authorized to manage this ticket."); }
  canClose(member, ticket) { return member?.id === ticket.owner_id || this.canManageTicket(member, ticket); }

  async getFreshTicket(interaction, ticket) {
    const latest = await getTicketById(interaction.guildId, ticket.id);
    if (!latest) throw new Error("This ticket no longer exists.");
    return latest;
  }

  async getTicket(interaction, ticketId = null) {
    let ticket = await getTicketByChannel(interaction.guildId, interaction.channelId);
    if (!ticket && ticketId !== null) {
      const candidate = await getTicketById(interaction.guildId, ticketId);
      if (candidate && String(candidate.channel_id) === String(interaction.channelId)) {
        ticket = candidate;
      }
    }
    if (!ticket) throw new Error("This channel is not an Evix ticket.");
    if (ticketId !== null && String(ticket.id) !== String(ticketId)) {
      throw new Error("This ticket is not available in the current channel.");
    }
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

    const limit = Number(settings.default_ticket_limit ?? 1);

    const optionFields = validateModalFields(option.modal_fields ?? []);
    const formText = Object.entries(formValues).filter(([, value]) => String(value ?? "").trim()).map(([fieldId, value]) => {
      const field = optionFields.find((entry) => entry.id === fieldId);
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
        ticketLimit: limit, welcomeMessage: storedWelcome, closeBehavior: option.close_behavior || "move",
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
    view.allowedMentions = { parse: [], roles: unique(pingRoles), users: unique([interaction.user.id]) };
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

  async refreshControlMessage(interaction, ticket, { closed = false, welcomeOverride = null, closedBy = null, replace = false, fallbackToKnownState = false } = {}) {
    return queueTicketControlRefresh(ticket.id, async () => {
      let latest;
      try {
        latest = await this.getFreshTicket(interaction, ticket);
      } catch (error) {
        if (!fallbackToKnownState) throw error;
        console.error("[evix-ticket-control-fresh-read-fallback]", error);
        latest = ticket;
      }
      if (latest.status === "deleted") return latest;

      const renderClosed = latest.status === "closed";
      const payload = renderClosed
        ? buildClosedTicketView({ ...latest, closed_by: closedBy || latest.closed_by })
        : buildTicketView(latest, { welcome_message: welcomeOverride ?? latest.welcome_message ?? "Thanks for opening a ticket. A member of the team will be with you shortly." });
      const channel = await interaction.guild.channels.fetch(latest.channel_id).catch(() => null);
      if (!channel?.isTextBased?.()) return latest;

      const oldMessageId = latest.control_message_id;
      const message = oldMessageId ? await channel.messages.fetch(oldMessageId).catch(() => null) : null;

      if (message && !replace) {
        try {
          await message.edit(payload);
          return latest;
        } catch (error) {
          console.error("[evix-ticket-control-edit-error]", error);
        }
      }

      try {
        const newMessage = await channel.send(payload);
        const next = await updateTicket(latest.id, { control_message_id: newMessage.id });
        if (!next) {
          await newMessage.delete("Evix ticket control state persistence failed").catch(() => null);
          throw new Error("Ticket control message state could not be persisted.");
        }

        if (oldMessageId && oldMessageId !== newMessage.id) {
          try {
            await channel.messages.delete(oldMessageId, "Evix replaced ticket control view");
          } catch (error) {
            console.error("[evix-ticket-control-old-message-delete-error]", error);
            if (message) {
              await message.edit(payload).catch((fallbackError) => {
                console.error("[evix-ticket-control-old-message-disable-error]", fallbackError);
              });
            }
          }
        }
        return next;
      } catch (error) {
        console.error("[evix-ticket-control-send-error]", error);

        // Never leave a stale public control view when the replacement path fails.
        if (message) {
          try {
            await message.edit(payload);
            return latest;
          } catch (fallbackError) {
            console.error("[evix-ticket-control-fallback-edit-error]", fallbackError);
          }
        }
        return latest;
      }
    });
  }
  async setParticipantPermissions(interaction, ticket, { view = true, send = true, rollbackTo = { view: true, send: true }, bestEffort = false } = {}) {
    const memberIds = unique([ticket.owner_id, ...(await listTicketMembers(ticket.id))]);
    const results = await Promise.all(memberIds.map(async (userId) => {
      try {
        const member = await interaction.guild.members.fetch(userId).catch(() => null);
        const keepStaffVisible = !view && this.canManageTicket(member, ticket);
        await interaction.channel.permissionOverwrites.edit(userId, {
          ViewChannel: view || keepStaffVisible,
          SendMessages: send,
          ReadMessageHistory: view || keepStaffVisible,
        });
        return { userId, ok: true };
      } catch (error) {
        return { userId, ok: false, error };
      }
    }));

    const changed = results.filter((result) => result.ok).map((result) => result.userId);
    const failed = results
      .filter((result) => !result.ok)
      .map(({ userId, error }) => ({ userId, error }));

    if (failed.length && !bestEffort) {
      await Promise.all(
        changed.map((userId) =>
          interaction.channel.permissionOverwrites.edit(userId, {
            ViewChannel: rollbackTo.view,
            SendMessages: rollbackTo.send,
            ReadMessageHistory: rollbackTo.view,
          }).catch(() => null),
        ),
      );
      throw failed[0].error;
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
    ticket = await this.getFreshTicket(interaction, ticket);
    this.assertStaff(interaction.member, ticket);
    if (ticket.status !== "open") throw new Error("Only open tickets can be claimed.");
    if (ticket.claimed_by === interaction.user.id) return respond(interaction, buildActionResult("Ticket Claimed", "You already have this ticket claimed."));
    if (ticket.claimed_by) throw new Error("This ticket is already claimed by <@" + ticket.claimed_by + ">.");
    const next = await updateTicket(ticket.id, { claimed_by: interaction.user.id, claimed_at: new Date() }, { statuses: ["open"], claimedBy: null });
    if (!next) throw new Error("This ticket was changed by another staff member. Please try again.");
    await respond(interaction, buildClaimResult(next));
    void addTicketEvent(ticket.id, "TICKET_CLAIMED", interaction.user.id)
      .catch((error) => console.error("[evix-ticket-claim-event-error]", error));
    void this.refreshControlMessage(interaction, next, { fallbackToKnownState: true })
      .catch((error) => console.error("[evix-ticket-refresh-after-claim-error]", error));
    void writeTicketLog(interaction.guild, next, "TICKET_CLAIMED", interaction.user.id)
      .catch((error) => console.error("[evix-ticket-claim-log-error]", error));
    return next;
  }

  async unclaim(interaction, ticket) {
    ticket = await this.getFreshTicket(interaction, ticket);
    this.assertStaff(interaction.member, ticket);
    if (!ticket.claimed_by) return respond(interaction, buildActionResult("Ticket Unclaimed", "This ticket is not currently claimed."));
    const next = await updateTicket(ticket.id, { claimed_by: null, claimed_at: null }, { statuses: ["open"], claimedBy: ticket.claimed_by });
    if (!next) throw new Error("This ticket was changed by another staff member. Please try again.");
    await respond(interaction, buildActionResult("Ticket Unclaimed", "The ticket is available for another staff member to claim."));
    void addTicketEvent(ticket.id, "TICKET_UNCLAIMED", interaction.user.id, { previous_claim: ticket.claimed_by })
      .catch((error) => console.error("[evix-ticket-unclaim-event-error]", error));
    void this.refreshControlMessage(interaction, next, { fallbackToKnownState: true })
      .catch((error) => console.error("[evix-ticket-refresh-after-unclaim-error]", error));
    void writeTicketLog(interaction.guild, next, "TICKET_UNCLAIMED", interaction.user.id)
      .catch((error) => console.error("[evix-ticket-unclaim-log-error]", error));
    return next;
  }

  async requestClose(interaction, ticket) {
    ticket = await this.getFreshTicket(interaction, ticket);
    if (!this.canClose(interaction.member, ticket)) throw new Error("Only the ticket owner or configured staff can close this ticket.");
    if (ticket.status === "closed") {
      await this.refreshControlMessage(interaction, ticket, { closed: true, closedBy: ticket.closed_by });
      return respond(interaction, buildActionResult("Ticket Already Closed", "This ticket is already closed. Use the controls on the closed ticket message."));
    }
    if (ticket.status === "deleted") throw new Error("This ticket has been deleted.");
    return respond(interaction, buildCloseConfirmation(ticket));
  }

  async close(interaction, ticket, { reply = true, closedBy = null, background = false } = {}) {
    ticket = await this.getFreshTicket(interaction, ticket);
    if (!this.canClose(interaction.member, ticket)) throw new Error("Only the ticket owner or configured staff can close this ticket.");
    if (ticket.status === "closed") {
      await this.refreshControlMessage(interaction, ticket, { closed: true, closedBy: ticket.closed_by, fallbackToKnownState: true });
      if (background) {
        return { started: false, alreadyClosed: true, ticket };
      }
      if (reply) {
        await respond(interaction, buildActionResult("Ticket Already Closed", "This ticket is already closed. Use the controls on the closed ticket message."));
      }
      return ticket;
    }
    if (ticket.status === "deleted") throw new Error("This ticket has been deleted.");
    transitionTicket(ticket.status, "close");

    const next = await updateTicket(ticket.id, {
      status: "closed",
      closed_at: new Date(),
      closed_by: closedBy || interaction.user.id,
      claimed_by: null,
      claimed_at: null,
    }, { statuses: ["open"] });
    if (!next) throw new Error("This ticket was already closed by another action.");

    const finishClose = async () => {
      let current = next;

      try {
        await this.refreshControlMessage(
          interaction,
          current,
          {
            closed: true,
            closedBy: closedBy || interaction.user.id,
            replace: true,
            fallbackToKnownState: true,
            requireSuccess: true,
            ticketIsFresh: true,
          },
        );
      } catch (error) {
        await updateTicket(
          ticket.id,
          {
            status: ticket.status,
            closed_at: null,
            closed_by: ticket.closed_by,
            claimed_by: ticket.claimed_by,
            claimed_at: ticket.claimed_at,
          },
          { statuses: ["closed"] },
        ).catch(() => null);
        await this.refreshControlMessage(
          interaction,
          ticket,
          {
            replace: true,
            fallbackToKnownState: true,
            ticketIsFresh: true,
          },
        ).catch((refreshError) => {
          console.error("[evix-ticket-close-rollback-control-error]", refreshError);
        });
        throw new Error("Ticket close failed: " + (error?.message || "closed control update failed"));
      }

      try {
        await this.setParticipantPermissions(interaction, current, {
          view: false,
          send: false,
          rollbackTo: { view: true, send: true },
        });
      } catch (error) {
        const reopened = await updateTicket(
          ticket.id,
          {
            status: ticket.status,
            closed_at: null,
            closed_by: ticket.closed_by,
            claimed_by: ticket.claimed_by,
            claimed_at: ticket.claimed_at,
          },
          { statuses: ["closed"] },
        ).catch(() => null);

        if (reopened) {
          await this.refreshControlMessage(
            interaction,
            reopened,
            {
              replace: true,
              fallbackToKnownState: true,
              ticketIsFresh: true,
            },
          ).catch((refreshError) => {
            console.error("[evix-ticket-close-rollback-control-error]", refreshError);
          });
        }

        throw new Error("Ticket close failed: " + (error?.message || "permission update failed"));
      }

      let currentCategoryId = interaction.channel.parentId || current.current_category_id || current.category_id;
      if (current.closed_category_id && current.close_behavior !== "stay") {
        try {
          const moved = await moveTicketChannel(interaction.channel, current.closed_category_id);
          if (moved) {
            currentCategoryId = moved.id;
            current = await updateTicket(current.id, { current_category_id: moved.id }, { statuses: ["closed"] }) ?? current;
          }
        } catch (error) {
          console.error("[evix-close-category-error]", error);
        }
      }

      void this.queueChannelName(current.id, () => interaction.channel.setName(statusName("closed", current.ticket_key))).catch((error) => {
        console.error("[evix-close-channel-rename-error]", error);
      });

      await addTicketEvent(current.id, "TICKET_CLOSED", interaction.user.id, {
        duration: formatDuration(ticket.created_at),
        category: currentCategoryId,
      }).catch((error) => console.error("[evix-close-event-error]", error));
      await writeTicketLog(interaction.guild, current, "TICKET_CLOSED", interaction.user.id, {
        duration: formatDuration(ticket.created_at),
        category: currentCategoryId,
      }).catch((error) => console.error("[evix-close-log-error]", error));
      return current;
    };

    if (background) return { started: true, ticket: next, completion: finishClose() };

    const closed = await finishClose();
    if (reply) {
      await respond(interaction, buildActionResult(
        "Ticket Closed",
        "This ticket has been closed by <@" + (closedBy || interaction.user.id) + ">.",
      ));
    }
    return closed;
  }

  async reopen(interaction, ticket) {
    ticket = await this.getFreshTicket(interaction, ticket);
    this.assertStaff(interaction.member, ticket);
    if (statusIsActive(ticket.status)) return respond(interaction, buildActionResult("Ticket Already Open", "This ticket is already active."));
    if (ticket.status === "deleted") throw new Error("This ticket has been deleted.");
    transitionTicket(ticket.status, "reopen");

    const settings = await this.getSettings(interaction.guildId);
    const candidates = categoryCandidates(
      ticket.category_id || settings.ticket_category_id || settings.open_category_id,
      settings.backup_category_id,
    );
    const previousCategoryId = interaction.channel.parentId || ticket.current_category_id || ticket.category_id || null;

    const [targetResult, permissionsResult] = await Promise.allSettled([
      findTicketReopenCategory(interaction.guild, candidates, previousCategoryId),
      this.setParticipantPermissions(interaction, ticket, {
        view: true,
        send: true,
        rollbackTo: { view: false, send: false },
      }),
    ]);

    if (targetResult.status === "rejected" || permissionsResult.status === "rejected") {
      if (permissionsResult.status === "fulfilled" && permissionsResult.value.changed.length) {
        await Promise.all(
          permissionsResult.value.changed.map((userId) =>
            interaction.channel.permissionOverwrites.edit(userId, {
              ViewChannel: false,
              SendMessages: false,
              ReadMessageHistory: false,
            }).catch(() => null),
          ),
        );
      }

      const failure = targetResult.status === "rejected" ? targetResult.reason : permissionsResult.reason;
      const prefix = targetResult.status === "rejected" ? "Ticket reopen routing failed: " : "Ticket reopen failed: ";
      throw new Error(prefix + (failure?.message || "ticket state could not be restored"));
    }

    const target = targetResult.value;
    const permissions = permissionsResult.value;

    try {
      await moveTicketChannel(interaction.channel, target.category.id);
    } catch (error) {
      if (permissions.changed.length) {
        await Promise.all(
          permissions.changed.map((userId) =>
            interaction.channel.permissionOverwrites.edit(userId, {
              ViewChannel: false,
              SendMessages: false,
              ReadMessageHistory: false,
            }).catch(() => null),
          ),
        );
      }
      throw new Error("Ticket reopen routing failed: " + (error?.message || "ticket category unavailable"));
    }

    let next;
    try {
      next = await updateTicket(
        ticket.id,
        {
          status: "open",
          reopened_at: new Date(),
          closed_at: null,
          closed_by: null,
          claimed_by: null,
          claimed_at: null,
          current_category_id: target.category.id,
        },
        { statuses: ["closed"] },
      );
    } catch (error) {
      if (String(target.category.id) !== String(previousCategoryId || "")) {
        await moveTicketChannel(interaction.channel, previousCategoryId).catch(() => null);
      }
      if (permissions.changed.length) {
        await Promise.all(
          permissions.changed.map((userId) =>
            interaction.channel.permissionOverwrites.edit(userId, {
              ViewChannel: false,
              SendMessages: false,
              ReadMessageHistory: false,
            }).catch(() => null),
          ),
        );
      }
      throw error;
    }

    if (!next) {
      if (String(target.category.id) !== String(previousCategoryId || "")) {
        await moveTicketChannel(interaction.channel, previousCategoryId).catch(() => null);
      }
      if (permissions.changed.length) {
        await Promise.all(
          permissions.changed.map((userId) =>
            interaction.channel.permissionOverwrites.edit(userId, {
              ViewChannel: false,
              SendMessages: false,
              ReadMessageHistory: false,
            }).catch(() => null),
          ),
        );
      }
      throw new Error("This ticket was changed by another action. Please try again.");
    }

    void this.queueChannelName(next.id, () => interaction.channel.setName(statusName("open", next.ticket_key))).catch((error) => {
      console.error("[evix-reopen-channel-rename-error]", error);
    });
    await respond(interaction, buildActionResult("Ticket Reopened", "This ticket is open again and ready for handling."));

    void addTicketEvent(next.id, "TICKET_REOPENED", interaction.user.id, { category: target.category.id })
      .catch((error) => console.error("[evix-ticket-reopen-event-error]", error));
    void this.refreshControlMessage(interaction, next, { welcomeOverride: "This ticket has been reopened.", replace: true, fallbackToKnownState: true })
      .catch((error) => console.error("[evix-ticket-refresh-after-reopen-error]", error));
    void writeTicketLog(interaction.guild, next, "TICKET_REOPENED", interaction.user.id, { category: target.category.id })
      .catch((error) => console.error("[evix-ticket-log-after-reopen-error]", error));
    return next;
  }

  async rename(interaction, ticket, name) {
    ticket = await this.getFreshTicket(interaction, ticket);
    this.assertStaff(interaction.member, ticket);
    if (ticket.status === "deleted") throw new Error("This ticket has been deleted.");
    const safe = sanitizeChannelName(name);
    if (!safe) throw new Error("The ticket name cannot be empty.");
    const finalName = statusName(ticket.status, safe);
    await this.queueChannelName(ticket.id, () => interaction.channel.setName(finalName));
    await respond(interaction, buildActionResult("Ticket Renamed", "The ticket channel is now `" + finalName + "`."));
    void addTicketEvent(ticket.id, "TICKET_RENAMED", interaction.user.id, { name: safe })
      .catch((error) => console.error("[evix-ticket-rename-event-error]", error));
    void writeTicketLog(interaction.guild, ticket, "TICKET_RENAMED", interaction.user.id, { name: safe })
      .catch((error) => console.error("[evix-ticket-rename-log-error]", error));
  }

  async addMember(interaction, ticket, userId) {
    ticket = await this.getFreshTicket(interaction, ticket);
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
    ticket = await this.getFreshTicket(interaction, ticket);
    this.assertStaff(interaction.member, ticket);
    if (ticket.status === "deleted") throw new Error("This ticket has been deleted.");
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
    ticket = await this.getFreshTicket(interaction, ticket);
    this.assertStaff(interaction.member, ticket);
    if (ticket.status === "deleted") throw new Error("This ticket has been deleted.");
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
    ticket = await this.getFreshTicket(interaction, ticket);
    if (!this.canClose(interaction.member, ticket)) throw new Error("Only the ticket owner or configured staff can view this ticket.");
    if (ticket.status === "deleted") throw new Error("This ticket has been deleted.");
    const members = await listTicketMembers(ticket.id);
    const displayTicket = interaction.channel?.parentId
      ? { ...ticket, current_category_id: interaction.channel.parentId }
      : ticket;
    await respond(interaction, buildInfoView(displayTicket, members));
  }

  async requestDelete(interaction, ticket) {
    ticket = await this.getFreshTicket(interaction, ticket);
    this.assertStaff(interaction.member, ticket);
    if (ticket.status === "deleted") {
      if (background) return { started: false, alreadyDeleted: true, ticket };
      return respond(interaction, buildActionResult("Ticket Deleted", "This ticket is already deleted."));
    }
    return respond(interaction, buildDeleteConfirmation(ticket));
  }

  async delete(interaction, ticket) {
    ticket = await this.getFreshTicket(interaction, ticket);
    this.assertStaff(interaction.member, ticket);
    if (ticket.status === "deleted") return respond(interaction, buildActionResult("Ticket Deleted", "This ticket is already deleted."));

    const previousStatus = ticket.status;
    transitionTicket(ticket.status, "delete");

    const deleted = await updateTicket(
      ticket.id,
      { status: "deleted", deleted_at: new Date() },
      { statuses: ["open", "closed"] },
    );
    if (!deleted) throw new Error("This ticket was changed by another action.");

    try {
      await interaction.channel.delete("Evix ticket deleted");
    } catch (error) {
      await updateTicket(
        ticket.id,
        { status: previousStatus, deleted_at: null },
        { statuses: ["deleted"] },
      ).catch(() => null);
      throw new Error("Ticket deletion failed: " + (error?.message || "channel deletion failed"));
    }

    void addTicketEvent(ticket.id, "TICKET_DELETED", interaction.user.id)
      .catch((error) => console.error("[evix-ticket-delete-event-error]", error));
    void writeTicketLog(interaction.guild, deleted, "TICKET_DELETED", interaction.user.id)
      .catch((error) => console.error("[evix-ticket-delete-log-error]", error));
  }

  async handleChannelDelete(channel) {
    if (!channel?.guildId || !channel?.id) return false;
    const ticket = await getTicketByChannel(channel.guildId, channel.id).catch(() => null);
    if (!ticket || ticket.status === "deleted") return false;

    const deleted = await updateTicket(
      ticket.id,
      { status: "deleted", deleted_at: new Date() },
      { statuses: ["open", "closed"] },
    );
    if (!deleted) return false;

    void addTicketEvent(ticket.id, "TICKET_DELETED", null, { reason: "channel_deleted_externally" })
      .catch((error) => console.error("[evix-ticket-external-delete-event-error]", error));
    void writeTicketLog(channel.guild, deleted, "TICKET_DELETED", null, { reason: "channel_deleted_externally" })
      .catch((error) => console.error("[evix-ticket-external-delete-log-error]", error));
    return true;
  }

  async sendTranscript(interaction, ticket) {
    ticket = await this.getFreshTicket(interaction, ticket);
    this.assertStaff(interaction.member, ticket);
    if (ticket.status === "deleted") throw new Error("This ticket has been deleted.");
    const channel = await interaction.guild.channels.fetch(ticket.channel_id).catch(() => null);
    if (!channel?.isTextBased?.()) throw new Error("The ticket channel is no longer available.");
    const transcript = await buildTranscript(channel, ticket);
    await respond(interaction, { ...buildActionResult("Transcript Ready", "Transcript generated for `" + ticket.ticket_key + "`."), files: [transcriptAttachment(transcript.buffer, transcript.fileName)], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
    void addTicketEvent(ticket.id, "TRANSCRIPT_CREATED", interaction.user.id, {
      messages: transcript.messageCount,
      channel: interaction.channel.id,
    }).catch((error) => console.error("[evix-ticket-transcript-event-error]", error));
    void writeTicketLog(interaction.guild, ticket, "TRANSCRIPT_CREATED", interaction.user.id, { messages: transcript.messageCount })
      .catch((error) => console.error("[evix-ticket-transcript-log-error]", error));
  }
}
