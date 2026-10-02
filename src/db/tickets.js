import { unique } from "../utils.js";
import { query, withTransaction } from "./connection.js";
import { MemoryCache, getCached } from "./cache.js";

const TICKET_CHANNEL_HINT_CACHE = new MemoryCache({
  name: "ticket-channel-hints",
  maxEntries: 2_048,
  ttlMs: 10_000,
});

const ticketActionLocks = new Map();

export async function withTicketActionLock(ticketId, callback) {
  const key = String(ticketId);
  const previous = ticketActionLocks.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => null).then(callback);

  ticketActionLocks.set(key, operation);

  try {
    return await operation;
  } finally {
    if (ticketActionLocks.get(key) === operation) ticketActionLocks.delete(key);
  }
}

function channelKey(guildId, channelId) {
  return String(guildId) + ":" + String(channelId);
}

function rememberTicket(ticket) {
  if (!ticket?.guild_id || !ticket?.channel_id) return;

  TICKET_CHANNEL_HINT_CACHE.deleteWhere((value, key) => (
    key !== channelKey(ticket.guild_id, ticket.channel_id)
    && String(value?.id) === String(ticket.id)
  ));

  TICKET_CHANNEL_HINT_CACHE.set(channelKey(ticket.guild_id, ticket.channel_id), ticket, 10_000);
}

export function getCachedTicketByChannel(guildId, channelId) {
  return TICKET_CHANNEL_HINT_CACHE.get(channelKey(guildId, channelId)) ?? null;
}

export function clearTicketMemory() {
  TICKET_CHANNEL_HINT_CACHE.clear();
  ticketActionLocks.clear();
}

export async function getTicketByChannel(guildId, channelId) {
  const { rows } = await query(
    "SELECT * FROM tickets WHERE guild_id=$1 AND channel_id=$2",
    [guildId, channelId],
  );
  const ticket = rows[0] ?? null;
  if (ticket) rememberTicket(ticket);
  return ticket;
}

export async function getOpenTicketForUser(guildId, ownerId, optionId) {
  const { rows } = await query(
    "SELECT * FROM tickets WHERE guild_id=$1 AND owner_id=$2 AND option_id=$3 AND status='open' ORDER BY created_at DESC, id DESC LIMIT 1",
    [guildId, ownerId, optionId],
  );
  const ticket = rows[0] ?? null;
  if (ticket) rememberTicket(ticket);
  return ticket;
}

export async function allocateTicketId() {
  const { rows } = await query(
    "SELECT nextval(pg_get_serial_sequence('tickets', 'id'))::bigint AS id",
  );
  const id = rows[0]?.id;
  if (id === undefined || id === null) throw new Error("Ticket ID allocation failed.");
  return Number(id);
}

export async function createTicket(data) {
  const explicitId = data.id == null ? null : Number(data.id);
  if (explicitId !== null && (!Number.isSafeInteger(explicitId) || explicitId <= 0)) {
    throw new Error("Ticket ID must be a positive integer.");
  }

  const ticket = await withTransaction(async (client) => {
    const lockKey = "ticket-limit:" + data.guildId + ":" + data.ownerId;
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [lockKey],
    );

    if (Number.isInteger(data.ticketLimit) && data.ticketLimit > 0) {
      const { rows: countRows } = await client.query(
        "SELECT COUNT(*)::int AS count FROM tickets WHERE guild_id=$1 AND owner_id=$2 AND status='open'",
        [data.guildId, data.ownerId],
      );
      if (Number(countRows[0]?.count ?? 0) >= data.ticketLimit) {
        const error = new Error("You have reached the open ticket limit (" + data.ticketLimit + ").");
        error.code = "EVIX_TICKET_LIMIT";
        throw error;
      }
    }

    const { rows } = await client.query(
      "WITH next_id AS (SELECT COALESCE($1::bigint, nextval(pg_get_serial_sequence('tickets', 'id'))) AS id) " +
      "INSERT INTO tickets (id,guild_id,panel_id,option_id,ticket_key,channel_id,owner_id,type_label,status,category_id,current_category_id,closed_category_id,staff_roles,ping_roles,dedupe_key,ticket_log_channel_id,moderation_log_channel_id,transcript_log_channel_id,ticket_logs_enabled,moderation_logs_enabled,transcript_logs_enabled,control_message_id,welcome_message,close_behavior) " +
      "SELECT id,$2,$3,$4,'EVX-' || LPAD(id::text,6,'0'),$5,$6,$7,'open',$8,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21 FROM next_id RETURNING *",
      [
        explicitId,
        data.guildId,
        data.panelId,
        data.optionId,
        data.id != null ? "EVX-" + String(data.id).padStart(6, "0") : null,
        data.channelId,
        data.ownerId,
        data.typeLabel,
        data.categoryId,
        data.closedCategoryId,
        JSON.stringify(unique(data.staffRoles ?? [])),
        JSON.stringify(unique(data.pingRoles ?? [])),
        data.dedupeKey ?? null,
        data.logChannelId ?? null,
        data.moderationLogChannelId ?? null,
        data.transcriptChannelId ?? null,
        data.ticketLogsEnabled !== false,
        data.moderationLogsEnabled !== false,
        data.transcriptLogsEnabled !== false,
        data.controlMessageId ?? null,
        data.welcomeMessage || "Thanks for opening a ticket. A member of the team will be with you shortly.",
        data.closeBehavior || "move",
      ],
    );
    return rows[0];
  });

  if (ticket) rememberTicket(ticket);
  return ticket;
}

export async function updateTicket(ticketId, patch, conditions = {}) {
  const allowed = [
    "status",
    "claimed_by",
    "claimed_at",
    "closed_by",
    "transcript_url",
    "closed_at",
    "reopened_at",
    "deleted_at",
    "channel_id",
    "ticket_key",
    "control_message_id",
    "welcome_message",
    "current_category_id",
  ];
  const keys = Object.keys(patch).filter((key) => allowed.includes(key));
  if (!keys.length) throw new Error("No editable ticket fields were provided.");

  const values = keys.map((key) => patch[key]);
  const assignments = keys.map((key, index) => key + "=$" + (index + 2)).join(",");
  const where = ["id=$1"];

  if (conditions.statuses?.length) {
    values.push(conditions.statuses);
    where.push("status = ANY($" + (values.length + 1) + "::text[])");
  }

  if (Object.hasOwn(conditions, "claimedBy")) {
    values.push(conditions.claimedBy);
    where.push("claimed_by IS NOT DISTINCT FROM $" + (values.length + 1));
  }

  const { rows } = await query(
    "UPDATE tickets SET " + assignments + " WHERE " + where.join(" AND ") + " RETURNING *",
    [ticketId, ...values],
  );
  const ticket = rows[0] ?? null;
  if (ticket) rememberTicket(ticket);
  return ticket;
}

export async function getTicketById(guildId, ticketId) {
  const { rows } = await query(
    "SELECT * FROM tickets WHERE guild_id=$1 AND id=$2",
    [guildId, ticketId],
  );
  const ticket = rows[0] ?? null;
  if (ticket) rememberTicket(ticket);
  return ticket;
}
