import pg from "pg";
import { unique } from "./utils.js";

const { Pool } = pg;
let pool;

export function getPool() {
  if (!pool) throw new Error("Database has not been initialized.");
  return pool;
}

export async function initDatabase(databaseUrl) {
  pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  });

  await pool.query("SELECT 1");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS guild_ticket_settings (
      guild_id TEXT PRIMARY KEY,
      open_category_id TEXT,
      ticket_category_id TEXT,
      backup_category_id TEXT,
      waiting_category_id TEXT,
      closed_category_id TEXT,
      log_channel_id TEXT,
      ticket_log_channel_id TEXT,
      moderation_log_channel_id TEXT,
      transcript_channel_id TEXT,
      transcript_log_channel_id TEXT,
      default_ticket_limit INTEGER NOT NULL DEFAULT 1 CHECK (default_ticket_limit BETWEEN 1 AND 25),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ticket_panels (
      id BIGSERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      name TEXT NOT NULL,
      channel_id TEXT,
      message_id TEXT,
      component_mode TEXT NOT NULL DEFAULT 'dropdown',
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      image_url TEXT,
      accent_color INTEGER NOT NULL DEFAULT 5793266,
      placeholder TEXT NOT NULL DEFAULT '',
      footer TEXT NOT NULL DEFAULT '',
      footer_show_bot BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (guild_id, name)
    );

    CREATE TABLE IF NOT EXISTS ticket_panel_options (
      id BIGSERIAL PRIMARY KEY,
      panel_id BIGINT NOT NULL REFERENCES ticket_panels(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0,
      component_kind TEXT NOT NULL DEFAULT 'dropdown',
      label TEXT NOT NULL,
      description TEXT,
      emoji TEXT,
      action TEXT NOT NULL DEFAULT 'CREATE_TICKET',
      category_id TEXT,
      closed_category_id TEXT,
      staff_roles JSONB NOT NULL DEFAULT '[]'::jsonb,
      ping_roles JSONB NOT NULL DEFAULT '[]'::jsonb,
      log_channel_id TEXT,
      moderation_log_channel_id TEXT,
      transcript_channel_id TEXT,
      welcome_message TEXT NOT NULL DEFAULT '',
      ticket_name_template TEXT NOT NULL DEFAULT 'ticket-{number}',
      close_behavior TEXT NOT NULL DEFAULT 'move' CHECK (close_behavior IN ('move', 'stay')),
      transcript_on_close BOOLEAN NOT NULL DEFAULT TRUE,
      allow_multiple BOOLEAN NOT NULL DEFAULT FALSE,
      button_style INTEGER NOT NULL DEFAULT 2 CHECK (button_style BETWEEN 1 AND 4),
      modal_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id BIGSERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      panel_id BIGINT REFERENCES ticket_panels(id) ON DELETE SET NULL,
      option_id BIGINT REFERENCES ticket_panel_options(id) ON DELETE SET NULL,
      ticket_key TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      type_label TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      claimed_by TEXT,
      category_id TEXT,
      current_category_id TEXT,
      closed_category_id TEXT,
      staff_roles JSONB NOT NULL DEFAULT '[]'::jsonb,
      ping_roles JSONB NOT NULL DEFAULT '[]'::jsonb,
      dedupe_key TEXT,
      log_channel_id TEXT,
      ticket_log_channel_id TEXT,
      moderation_log_channel_id TEXT,
      transcript_channel_id TEXT,
      transcript_log_channel_id TEXT,
      ticket_logs_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      moderation_logs_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      transcript_logs_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      transcript_url TEXT,
      control_message_id TEXT,
      welcome_message TEXT NOT NULL DEFAULT 'Thanks for opening a ticket. A member of the team will be with you shortly.',
      close_behavior TEXT NOT NULL DEFAULT 'move',
      transcript_on_close BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at TIMESTAMPTZ,
      reopened_at TIMESTAMPTZ,
      waiting_at TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ,
      UNIQUE (guild_id, channel_id)
    );

    CREATE INDEX IF NOT EXISTS tickets_guild_status_idx ON tickets (guild_id, status);
    CREATE INDEX IF NOT EXISTS tickets_owner_idx ON tickets (guild_id, owner_id);

    CREATE TABLE IF NOT EXISTS ticket_members (
      ticket_id BIGINT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      added_by TEXT NOT NULL,
      added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (ticket_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS ticket_events (
      id BIGSERIAL PRIMARY KEY,
      ticket_id BIGINT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      actor_id TEXT,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS panels_guild_idx ON ticket_panels (guild_id);
    CREATE INDEX IF NOT EXISTS panel_options_panel_idx ON ticket_panel_options (panel_id);
    CREATE INDEX IF NOT EXISTS ticket_members_ticket_idx ON ticket_members (ticket_id);
    CREATE INDEX IF NOT EXISTS ticket_events_ticket_idx ON ticket_events (ticket_id, created_at);
  `);

  await pool.query(`
    ALTER TABLE guild_ticket_settings ADD COLUMN IF NOT EXISTS ticket_category_id TEXT;
    ALTER TABLE guild_ticket_settings ADD COLUMN IF NOT EXISTS backup_category_id TEXT;
    ALTER TABLE guild_ticket_settings ADD COLUMN IF NOT EXISTS waiting_category_id TEXT;
    ALTER TABLE guild_ticket_settings ADD COLUMN IF NOT EXISTS ticket_log_channel_id TEXT;
    ALTER TABLE guild_ticket_settings ADD COLUMN IF NOT EXISTS moderation_log_channel_id TEXT;
    ALTER TABLE guild_ticket_settings ADD COLUMN IF NOT EXISTS transcript_log_channel_id TEXT;
    ALTER TABLE guild_ticket_settings ADD COLUMN IF NOT EXISTS ticket_logs_enabled BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE guild_ticket_settings ADD COLUMN IF NOT EXISTS moderation_logs_enabled BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE guild_ticket_settings ADD COLUMN IF NOT EXISTS transcript_logs_enabled BOOLEAN NOT NULL DEFAULT TRUE;

    ALTER TABLE ticket_panels ADD COLUMN IF NOT EXISTS image_url TEXT;
    ALTER TABLE ticket_panels ADD COLUMN IF NOT EXISTS footer_show_bot BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE ticket_panels ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '';
    ALTER TABLE ticket_panels ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
    ALTER TABLE ticket_panels ADD COLUMN IF NOT EXISTS footer TEXT NOT NULL DEFAULT '';
    ALTER TABLE ticket_panels ADD COLUMN IF NOT EXISTS placeholder TEXT NOT NULL DEFAULT '';

    ALTER TABLE ticket_panel_options ADD COLUMN IF NOT EXISTS moderation_log_channel_id TEXT;

    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS current_category_id TEXT;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ticket_log_channel_id TEXT;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS moderation_log_channel_id TEXT;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS transcript_log_channel_id TEXT;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS waiting_at TIMESTAMPTZ;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ticket_logs_enabled BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS moderation_logs_enabled BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS transcript_logs_enabled BOOLEAN NOT NULL DEFAULT TRUE;

    UPDATE guild_ticket_settings
    SET ticket_category_id = COALESCE(ticket_category_id, open_category_id),
        ticket_log_channel_id = COALESCE(ticket_log_channel_id, log_channel_id),
        transcript_log_channel_id = COALESCE(transcript_log_channel_id, transcript_channel_id)
    WHERE ticket_category_id IS NULL
       OR ticket_log_channel_id IS NULL
       OR transcript_log_channel_id IS NULL;

    UPDATE ticket_panels SET component_mode = 'dropdown' WHERE component_mode <> 'dropdown';

    UPDATE tickets
    SET ticket_key = 'EVX-' || LPAD(id::text, 6, '0')
    WHERE ticket_key IS DISTINCT FROM ('EVX-' || LPAD(id::text, 6, '0'));
    UPDATE ticket_panel_options
    SET component_kind = 'dropdown', action = 'CREATE_TICKET'
    WHERE component_kind <> 'dropdown' OR action <> 'CREATE_TICKET';

    UPDATE tickets
    SET current_category_id = COALESCE(current_category_id, category_id),
        ticket_log_channel_id = COALESCE(ticket_log_channel_id, log_channel_id),
        transcript_log_channel_id = COALESCE(transcript_log_channel_id, transcript_channel_id)
    WHERE current_category_id IS NULL
       OR ticket_log_channel_id IS NULL
       OR transcript_log_channel_id IS NULL;

    DROP INDEX IF EXISTS tickets_one_active_dedupe_idx;
    DROP INDEX IF EXISTS tickets_one_active_per_type;
    CREATE UNIQUE INDEX IF NOT EXISTS tickets_one_active_dedupe_idx
      ON tickets (guild_id, owner_id, option_id, dedupe_key)
      WHERE status IN ('open','locked','waiting') AND dedupe_key IS NOT NULL;

    ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_status_check;
    ALTER TABLE tickets ADD CONSTRAINT tickets_status_check
      CHECK (status IN ('open','locked','waiting','closed','deleted'));

    ALTER TABLE ticket_panels DROP CONSTRAINT IF EXISTS ticket_panels_component_mode_check;
    ALTER TABLE ticket_panels ADD CONSTRAINT ticket_panels_component_mode_check
      CHECK (component_mode = 'dropdown');

    ALTER TABLE ticket_panel_options DROP CONSTRAINT IF EXISTS ticket_panel_options_component_kind_check;
    ALTER TABLE ticket_panel_options ADD CONSTRAINT ticket_panel_options_component_kind_check
      CHECK (component_kind = 'dropdown');

    ALTER TABLE ticket_panel_options DROP CONSTRAINT IF EXISTS ticket_panel_options_action_check;
    ALTER TABLE ticket_panel_options ADD CONSTRAINT ticket_panel_options_action_check
      CHECK (action = 'CREATE_TICKET');

    CREATE INDEX IF NOT EXISTS ticket_events_ticket_idx ON ticket_events (ticket_id, created_at);
  `);
}

export async function closeDatabase() {
  await pool?.end();
  pool = undefined;
}

async function query(text, params = []) {
  return getPool().query(text, params);
}

async function withTransaction(callback) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    throw error;
  } finally {
    client.release();
  }
}

export async function getGuildSettings(guildId) {
  const { rows } = await query("SELECT * FROM guild_ticket_settings WHERE guild_id=$1", [guildId]);
  const row = rows[0];
  if (!row) return null;
  row.ticket_category_id = row.ticket_category_id ?? row.open_category_id ?? null;
  row.ticket_log_channel_id = row.ticket_log_channel_id ?? row.log_channel_id ?? null;
  row.transcript_log_channel_id = row.transcript_log_channel_id ?? row.transcript_channel_id ?? null;
  return row;
}

export async function upsertGuildSettings(guildId, patch) {
  const current = (await getGuildSettings(guildId)) ?? {
    guild_id: guildId,
    open_category_id: null,
    ticket_category_id: null,
    backup_category_id: null,
    waiting_category_id: null,
    closed_category_id: null,
    log_channel_id: null,
    ticket_log_channel_id: null,
    moderation_log_channel_id: null,
    transcript_channel_id: null,
    transcript_log_channel_id: null,
    ticket_logs_enabled: true,
    moderation_logs_enabled: true,
    transcript_logs_enabled: true,
    default_ticket_limit: 1,
  };

  const next = { ...current, ...patch };
  next.ticket_category_id = next.ticket_category_id ?? next.open_category_id ?? null;
  next.open_category_id = next.ticket_category_id;
  next.ticket_log_channel_id = next.ticket_log_channel_id ?? next.log_channel_id ?? null;
  next.log_channel_id = next.ticket_log_channel_id;
  next.transcript_log_channel_id = next.transcript_log_channel_id ?? next.transcript_channel_id ?? null;
  next.transcript_channel_id = next.transcript_log_channel_id;

  const { rows } = await query(
    "INSERT INTO guild_ticket_settings (guild_id,open_category_id,ticket_category_id,backup_category_id,waiting_category_id,closed_category_id,log_channel_id,ticket_log_channel_id,moderation_log_channel_id,transcript_channel_id,transcript_log_channel_id,ticket_logs_enabled,moderation_logs_enabled,transcript_logs_enabled,default_ticket_limit,updated_at) " +
    "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW()) " +
    "ON CONFLICT (guild_id) DO UPDATE SET open_category_id=EXCLUDED.open_category_id,ticket_category_id=EXCLUDED.ticket_category_id,backup_category_id=EXCLUDED.backup_category_id,waiting_category_id=EXCLUDED.waiting_category_id,closed_category_id=EXCLUDED.closed_category_id,log_channel_id=EXCLUDED.log_channel_id,ticket_log_channel_id=EXCLUDED.ticket_log_channel_id,moderation_log_channel_id=EXCLUDED.moderation_log_channel_id,transcript_channel_id=EXCLUDED.transcript_channel_id,transcript_log_channel_id=EXCLUDED.transcript_log_channel_id,ticket_logs_enabled=EXCLUDED.ticket_logs_enabled,moderation_logs_enabled=EXCLUDED.moderation_logs_enabled,transcript_logs_enabled=EXCLUDED.transcript_logs_enabled,default_ticket_limit=EXCLUDED.default_ticket_limit,updated_at=NOW() RETURNING *",
    [
      guildId,
      next.open_category_id,
      next.ticket_category_id,
      next.backup_category_id ?? null,
      next.waiting_category_id ?? null,
      next.closed_category_id ?? null,
      next.log_channel_id ?? null,
      next.ticket_log_channel_id ?? null,
      next.moderation_log_channel_id ?? null,
      next.transcript_channel_id ?? null,
      next.transcript_log_channel_id ?? null,
      next.ticket_logs_enabled !== false,
      next.moderation_logs_enabled !== false,
      next.transcript_logs_enabled !== false,
      next.default_ticket_limit ?? 1,
    ],
  );
  return rows[0];
}

export async function createPanel(data) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      "INSERT INTO ticket_panels (guild_id,name,component_mode,title,description,image_url,accent_color,placeholder,footer,footer_show_bot) " +
      "VALUES ($1,$2,'dropdown',$3,$4,$5,$6,$7,$8,$9) RETURNING *",
      [
        data.guildId,
        data.name,
        data.title ?? "",
        data.description ?? "",
        data.imageUrl ?? null,
        data.accentColor ?? 5793266,
        data.placeholder ?? "",
        data.footer ?? "",
        data.footerShowBot === true,
      ],
    );

    const panel = rows[0];
    if (data.withDefaultOption !== false) {
      await client.query(
        "INSERT INTO ticket_panel_options (panel_id,position,component_kind,label,description,emoji,action,category_id,closed_category_id,staff_roles,ping_roles,log_channel_id,moderation_log_channel_id,transcript_channel_id,welcome_message,ticket_name_template,close_behavior,transcript_on_close,allow_multiple,button_style,modal_fields) " +
        "VALUES ($1,0,'dropdown','Open Ticket',NULL,NULL,'CREATE_TICKET',NULL,NULL,'[]'::jsonb,'[]'::jsonb,NULL,NULL,NULL,'','ticket-{number}','move',TRUE,FALSE,2,'[]'::jsonb)",
        [panel.id],
      );
    }

    const { rows: options } = await client.query(
      "SELECT * FROM ticket_panel_options WHERE panel_id=$1 ORDER BY position,id",
      [panel.id],
    );
    panel.options = options;
    return panel;
  });
}

export async function getPanel(guildId, panelNameOrId) {
  const byId = /^\d+$/.test(String(panelNameOrId));
  const where = byId ? "id=$2 AND guild_id=$1" : "name=$2 AND guild_id=$1";
  const { rows } = await query("SELECT * FROM ticket_panels WHERE " + where, [guildId, String(panelNameOrId)]);
  if (!rows[0]) return null;
  rows[0].options = await listPanelOptions(rows[0].id);
  return rows[0];
}

export async function listPanels(guildId) {
  const { rows } = await query("SELECT * FROM ticket_panels WHERE guild_id=$1 ORDER BY id", [guildId]);
  return rows;
}

export async function updatePanel(panelId, patch) {
  const allowed = [
    "channel_id","message_id","component_mode","title","description","image_url",
    "accent_color","placeholder","footer","footer_show_bot","name"
  ];
  const keys = Object.keys(patch).filter((key) => allowed.includes(key));
  if (!keys.length) throw new Error("No editable panel fields were provided.");
  const values = keys.map((key) => patch[key]);
  const assignments = keys.map((key, index) => key + " = $" + (index + 2)).join(", ");
  const { rows } = await query(
    "UPDATE ticket_panels SET " + assignments + ",updated_at=NOW() WHERE id=$1 RETURNING *",
    [panelId, ...values],
  );
  return rows[0] ?? null;
}

export async function deletePanel(panelId) {
  await query("DELETE FROM ticket_panels WHERE id=$1", [panelId]);
}

export async function resetPanel(panelId) {
  return withTransaction(async (client) => {
    await client.query("DELETE FROM ticket_panel_options WHERE panel_id=$1", [panelId]);
    const { rows } = await client.query(
      "UPDATE ticket_panels SET component_mode='dropdown',title='',description='',image_url=NULL,accent_color=5793266,placeholder='',footer='',footer_show_bot=FALSE,message_id=NULL,channel_id=NULL,updated_at=NOW() WHERE id=$1 RETURNING *",
      [panelId],
    );
    const panel = rows[0] ?? null;
    if (!panel) return null;

    await client.query(
      "INSERT INTO ticket_panel_options (panel_id,position,component_kind,label,description,emoji,action,category_id,closed_category_id,staff_roles,ping_roles,log_channel_id,moderation_log_channel_id,transcript_channel_id,welcome_message,ticket_name_template,close_behavior,transcript_on_close,allow_multiple,button_style,modal_fields) " +
      "VALUES ($1,0,'dropdown','Open Ticket',NULL,NULL,'CREATE_TICKET',NULL,NULL,'[]'::jsonb,'[]'::jsonb,NULL,NULL,NULL,'','ticket-{number}','move',TRUE,FALSE,2,'[]'::jsonb)",
      [panelId],
    );

    const { rows: options } = await client.query(
      "SELECT * FROM ticket_panel_options WHERE panel_id=$1 ORDER BY position,id",
      [panelId],
    );
    panel.options = options;
    return panel;
  });
}

export async function addPanelOption(data) {
  const { rows } = await query(
    "INSERT INTO ticket_panel_options (panel_id,position,component_kind,label,description,emoji,action,category_id,closed_category_id,staff_roles,ping_roles,log_channel_id,moderation_log_channel_id,transcript_channel_id,welcome_message,ticket_name_template,close_behavior,transcript_on_close,allow_multiple,button_style,modal_fields) " +
    "VALUES ($1,$2,'dropdown',$3,$4,$5,'CREATE_TICKET',$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb) RETURNING *",
    [
      data.panelId,
      data.position,
      data.label,
      data.description ?? null,
      data.emoji ?? null,
      data.categoryId ?? null,
      data.closedCategoryId ?? null,
      JSON.stringify(unique(data.staffRoles)),
      JSON.stringify(unique(data.pingRoles)),
      data.logChannelId ?? null,
      data.moderationLogChannelId ?? null,
      data.transcriptChannelId ?? null,
      data.welcomeMessage ?? "",
      data.ticketNameTemplate || "ticket-{number}",
      data.closeBehavior || "move",
      data.transcriptOnClose !== false,
      data.allowMultiple === true,
      data.buttonStyle ?? 2,
      JSON.stringify(data.modalFields ?? []),
    ],
  );
  return rows[0];
}

export async function listPanelOptions(panelId) {
  const { rows } = await query("SELECT * FROM ticket_panel_options WHERE panel_id=$1 ORDER BY position,id", [panelId]);
  return rows;
}

export async function getPanelOption(optionId, guildId = null) {
  if (guildId) {
    const { rows } = await query(
      "SELECT o.* FROM ticket_panel_options o JOIN ticket_panels p ON p.id=o.panel_id WHERE o.id=$1 AND p.guild_id=$2",
      [optionId, guildId],
    );
    return rows[0] ?? null;
  }
  const { rows } = await query("SELECT * FROM ticket_panel_options WHERE id=$1", [optionId]);
  return rows[0] ?? null;
}

export async function updatePanelOption(optionId, patch) {
  const allowed = [
    "position","component_kind","label","description","emoji","action","category_id","closed_category_id",
    "staff_roles","ping_roles","log_channel_id","moderation_log_channel_id","transcript_channel_id","welcome_message",
    "ticket_name_template","close_behavior","transcript_on_close","allow_multiple","button_style","modal_fields"
  ];
  const keys = Object.keys(patch).filter((key) => allowed.includes(key));
  if (!keys.length) throw new Error("No editable option fields were provided.");
  const jsonKeys = new Set(["staff_roles","ping_roles","modal_fields"]);
  const values = keys.map((key) => jsonKeys.has(key)
    ? JSON.stringify(key === "modal_fields" ? patch[key] : unique(patch[key]))
    : patch[key]);
  const assignments = keys.map((key, index) => key + "=$" + (index + 2) + (jsonKeys.has(key) ? "::jsonb" : "")).join(", ");
  const { rows } = await query(
    "UPDATE ticket_panel_options SET " + assignments + ",updated_at=NOW() WHERE id=$1 RETURNING *",
    [optionId, ...values],
  );
  return rows[0] ?? null;
}

export async function deletePanelOption(optionId) {
  await query("DELETE FROM ticket_panel_options WHERE id=$1", [optionId]);
}

export async function getTicketByChannel(guildId, channelId) {
  const { rows } = await query("SELECT * FROM tickets WHERE guild_id=$1 AND channel_id=$2", [guildId, channelId]);
  return rows[0] ?? null;
}

export async function getOpenTicketForUser(guildId, ownerId, optionId) {
  const { rows } = await query(
    "SELECT * FROM tickets WHERE guild_id=$1 AND owner_id=$2 AND option_id=$3 AND status IN ('open','locked','waiting') ORDER BY created_at DESC LIMIT 1",
    [guildId, ownerId, optionId],
  );
  return rows[0] ?? null;
}

export async function createTicket(data) {
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["ticket-limit:" + data.guildId + ":" + data.ownerId]);

    if (Number.isInteger(data.ticketLimit) && data.ticketLimit > 0) {
      const { rows: countRows } = await client.query(
        "SELECT COUNT(*)::int AS count FROM tickets WHERE guild_id=$1 AND owner_id=$2 AND status IN ('open','locked','waiting')",
        [data.guildId, data.ownerId],
      );
      if (countRows[0].count >= data.ticketLimit) {
        const error = new Error("You have reached the open ticket limit (" + data.ticketLimit + ").");
        error.code = "EVIX_TICKET_LIMIT";
        throw error;
      }
    }

    const { rows } = await client.query(
      "WITH next_id AS (SELECT nextval('tickets_id_seq') AS id) " +
      "INSERT INTO tickets (id,guild_id,panel_id,option_id,ticket_key,channel_id,owner_id,type_label,status,category_id,current_category_id,closed_category_id,staff_roles,ping_roles,dedupe_key,log_channel_id,ticket_log_channel_id,moderation_log_channel_id,transcript_channel_id,transcript_log_channel_id,control_message_id,welcome_message,close_behavior,transcript_on_close) " +
      "SELECT id,$1,$2,$3,'EVX-' || LPAD(id::text,6,'0'),$4,$5,$6,'open',$7,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$12,$13,$14,$14,$15,$16,$17,$18 FROM next_id RETURNING *",
      [
        data.guildId,data.panelId,data.optionId,data.channelId,data.ownerId,data.typeLabel,data.categoryId,data.closedCategoryId,
        JSON.stringify(unique(data.staffRoles)),JSON.stringify(unique(data.pingRoles)),data.dedupeKey ?? null,
        data.logChannelId ?? null,data.moderationLogChannelId ?? null,data.transcriptChannelId ?? null,
        data.ticketLogsEnabled !== false,data.moderationLogsEnabled !== false,data.transcriptLogsEnabled !== false,
        data.controlMessageId ?? null,
        data.welcomeMessage || "Thanks for opening a ticket. A member of the team will be with you shortly.",
        data.closeBehavior || "move",
        data.transcriptOnClose !== false,
      ],
    );
    return rows[0];
  });
}

export async function updateTicket(ticketId, patch, conditions = {}) {
  const allowed = [
    "status","claimed_by","transcript_url","closed_at","reopened_at","waiting_at","deleted_at",
    "channel_id","ticket_key","control_message_id","welcome_message","current_category_id"
  ];
  const keys = Object.keys(patch).filter((key) => allowed.includes(key));
  if (!keys.length) throw new Error("No editable ticket fields were provided.");
  const values = keys.map((key) => patch[key]);
  const assignments = keys.map((key, index) => key + " = $" + (index + 2)).join(", ");
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
    [ticketId,...values],
  );
  return rows[0] ?? null;
}

export async function getTicketById(guildId, ticketId) {
  const { rows } = await query("SELECT * FROM tickets WHERE guild_id=$1 AND id=$2", [guildId, ticketId]);
  return rows[0] ?? null;
}

export async function addTicketMember(ticketId, userId, addedBy) {
  await query("INSERT INTO ticket_members(ticket_id,user_id,added_by) VALUES($1,$2,$3) ON CONFLICT(ticket_id,user_id) DO NOTHING", [ticketId,userId,addedBy]);
}

export async function removeTicketMember(ticketId, userId) {
  await query("DELETE FROM ticket_members WHERE ticket_id=$1 AND user_id=$2", [ticketId,userId]);
}

export async function listTicketMembers(ticketId) {
  const { rows } = await query("SELECT user_id FROM ticket_members WHERE ticket_id=$1 ORDER BY added_at", [ticketId]);
  return rows.map((row) => row.user_id);
}

export async function addTicketEvent(ticketId,eventType,actorId,details={}) {
  await query("INSERT INTO ticket_events(ticket_id,event_type,actor_id,details) VALUES($1,$2,$3,$4::jsonb)", [ticketId,eventType,actorId,JSON.stringify(details)]);
}

export async function listTicketEvents(ticketId) {
  const { rows } = await query("SELECT * FROM ticket_events WHERE ticket_id=$1 ORDER BY created_at ASC", [ticketId]);
  return rows;
}

export async function countOpenTickets(guildId, ownerId) {
  const { rows } = await query(
    "SELECT COUNT(*)::int AS count FROM tickets WHERE guild_id=$1 AND owner_id=$2 AND status IN ('open','locked','waiting')",
    [guildId,ownerId],
  );
  return rows[0].count;
}
