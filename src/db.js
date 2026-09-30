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
      closed_category_id TEXT,
      log_channel_id TEXT,
      transcript_channel_id TEXT,
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
      component_mode TEXT NOT NULL DEFAULT 'dropdown'
        CHECK (component_mode IN ('buttons', 'dropdown', 'both')),
      title TEXT NOT NULL DEFAULT 'Evix Support',
      description TEXT NOT NULL DEFAULT 'Choose an option below to open a ticket.',
      accent_color INTEGER NOT NULL DEFAULT 5793266,
      placeholder TEXT NOT NULL DEFAULT 'Select a ticket type',
      footer TEXT NOT NULL DEFAULT 'Evix Ticket System',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (guild_id, name)
    );

    CREATE TABLE IF NOT EXISTS ticket_panel_options (
      id BIGSERIAL PRIMARY KEY,
      panel_id BIGINT NOT NULL REFERENCES ticket_panels(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0,
      component_kind TEXT NOT NULL DEFAULT 'dropdown'
        CHECK (component_kind IN ('button', 'dropdown')),
      label TEXT NOT NULL,
      description TEXT,
      emoji TEXT,
      action TEXT NOT NULL CHECK (action IN ('CREATE_TICKET', 'NOTHING')),
      category_id TEXT,
      closed_category_id TEXT,
      staff_roles JSONB NOT NULL DEFAULT '[]'::jsonb,
      ping_roles JSONB NOT NULL DEFAULT '[]'::jsonb,
      log_channel_id TEXT,
      transcript_channel_id TEXT,
      welcome_message TEXT NOT NULL DEFAULT 'Thanks for opening a ticket. A member of the team will be with you shortly.',
      ticket_name_template TEXT NOT NULL DEFAULT 'ticket-{number}',
      close_behavior TEXT NOT NULL DEFAULT 'move'
        CHECK (close_behavior IN ('move', 'stay')),
      transcript_on_close BOOLEAN NOT NULL DEFAULT TRUE,
      allow_multiple BOOLEAN NOT NULL DEFAULT FALSE,
      button_style INTEGER NOT NULL DEFAULT 2 CHECK (button_style BETWEEN 1 AND 4),
      modal_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (panel_id, label)
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
      status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'locked', 'closed', 'deleted')),
      claimed_by TEXT,
      category_id TEXT,
      closed_category_id TEXT,
      staff_roles JSONB NOT NULL DEFAULT '[]'::jsonb,
      ping_roles JSONB NOT NULL DEFAULT '[]'::jsonb,
      dedupe_key TEXT,
      log_channel_id TEXT,
      transcript_channel_id TEXT,
      transcript_url TEXT,
      close_behavior TEXT NOT NULL DEFAULT 'move' CHECK (close_behavior IN ('move','stay')),
      transcript_on_close BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at TIMESTAMPTZ,
      reopened_at TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ,
      UNIQUE (guild_id, channel_id)
    );

    CREATE INDEX IF NOT EXISTS tickets_guild_status_idx
      ON tickets (guild_id, status);

    CREATE INDEX IF NOT EXISTS tickets_owner_idx
      ON tickets (guild_id, owner_id);

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
  `);

  await pool.query(`
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS close_behavior TEXT NOT NULL DEFAULT 'move';
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS transcript_on_close BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS dedupe_key TEXT;
    DROP INDEX IF EXISTS tickets_one_active_per_type;
    CREATE UNIQUE INDEX IF NOT EXISTS tickets_one_active_dedupe_idx
      ON tickets (guild_id, owner_id, option_id, dedupe_key)
      WHERE status IN ('open','locked') AND dedupe_key IS NOT NULL;
    ALTER TABLE ticket_panel_options ADD COLUMN IF NOT EXISTS close_behavior TEXT NOT NULL DEFAULT 'move';
    ALTER TABLE ticket_panel_options ADD COLUMN IF NOT EXISTS transcript_on_close BOOLEAN NOT NULL DEFAULT TRUE;
    CREATE INDEX IF NOT EXISTS ticket_events_ticket_idx
      ON ticket_events (ticket_id, created_at);
  `);
}

export async function closeDatabase() {
  await pool?.end();
  pool = undefined;
}

async function query(text, params = []) {
  return getPool().query(text, params);
}

export async function getGuildSettings(guildId) {
  const { rows } = await query("SELECT * FROM guild_ticket_settings WHERE guild_id = $1", [guildId]);
  return rows[0] ?? null;
}

export async function upsertGuildSettings(guildId, patch) {
  const current = (await getGuildSettings(guildId)) ?? {
    guild_id: guildId,
    open_category_id: null,
    closed_category_id: null,
    log_channel_id: null,
    transcript_channel_id: null,
    default_ticket_limit: 1,
  };

  const next = { ...current, ...patch };
  const { rows } = await query(
    `INSERT INTO guild_ticket_settings
      (guild_id, open_category_id, closed_category_id, log_channel_id, transcript_channel_id, default_ticket_limit, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (guild_id) DO UPDATE SET
       open_category_id=EXCLUDED.open_category_id,
       closed_category_id=EXCLUDED.closed_category_id,
       log_channel_id=EXCLUDED.log_channel_id,
       transcript_channel_id=EXCLUDED.transcript_channel_id,
       default_ticket_limit=EXCLUDED.default_ticket_limit,
       updated_at=NOW()
     RETURNING *`,
    [
      guildId,
      next.open_category_id,
      next.closed_category_id,
      next.log_channel_id,
      next.transcript_channel_id,
      next.default_ticket_limit,
    ],
  );
  return rows[0];
}

export async function createPanel(data) {
  const { rows } = await query(
    `INSERT INTO ticket_panels
      (guild_id,name,component_mode,title,description,accent_color,placeholder,footer)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      data.guildId, data.name, data.componentMode, data.title, data.description,
      data.accentColor, data.placeholder, data.footer,
    ],
  );
  return rows[0];
}

export async function getPanel(guildId, panelNameOrId) {
  const byId = /^\d+$/.test(String(panelNameOrId));
  const where = byId ? "id = $2 AND guild_id = $1" : "name = $2 AND guild_id = $1";
  const { rows } = await query(`SELECT * FROM ticket_panels WHERE ${where}`, [guildId, String(panelNameOrId)]);
  if (!rows[0]) return null;
  rows[0].options = await listPanelOptions(rows[0].id);
  return rows[0];
}

export async function listPanels(guildId) {
  const { rows } = await query("SELECT * FROM ticket_panels WHERE guild_id = $1 ORDER BY id", [guildId]);
  return rows;
}

export async function updatePanel(panelId, patch) {
  const allowed = ["channel_id", "message_id", "component_mode", "title", "description", "accent_color", "placeholder", "footer", "name"];
  const keys = Object.keys(patch).filter((key) => allowed.includes(key));
  if (!keys.length) throw new Error("No editable panel fields were provided.");
  const values = keys.map((key) => patch[key]);
  const assignments = keys.map((key, i) => `${key} = $\{i + 2}`).join(", ");
  const { rows } = await query(
    `UPDATE ticket_panels SET ${assignments}, updated_at=NOW() WHERE id=$1 RETURNING *`,
    [panelId, ...values],
  );
  return rows[0] ?? null;
}

export async function deletePanel(panelId) {
  await query("DELETE FROM ticket_panels WHERE id=$1", [panelId]);
}

export async function resetPanel(panelId) {
  await query("DELETE FROM ticket_panel_options WHERE panel_id=$1", [panelId]);
  const { rows } = await query(
    `UPDATE ticket_panels SET component_mode='dropdown', title='Evix Support',
      description='Choose an option below to open a ticket.', accent_color=5793266,
      placeholder='Select a ticket type', footer='Evix Ticket System', message_id=NULL, updated_at=NOW()
      WHERE id=$1 RETURNING *`,
    [panelId],
  );
  return rows[0] ?? null;
}

export async function addPanelOption(data) {
  const { rows } = await query(
    `INSERT INTO ticket_panel_options
      (panel_id,position,component_kind,label,description,emoji,action,category_id,closed_category_id,
       staff_roles,ping_roles,log_channel_id,transcript_channel_id,welcome_message,ticket_name_template,
       close_behavior,transcript_on_close,allow_multiple,button_style,modal_fields)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb)
     RETURNING *`,
    [
      data.panelId, data.position, data.componentKind, data.label, data.description, data.emoji,
      data.action, data.categoryId, data.closedCategoryId,
      JSON.stringify(unique(data.staffRoles)), JSON.stringify(unique(data.pingRoles)),
      data.logChannelId, data.transcriptChannelId, data.welcomeMessage, data.ticketNameTemplate,
      data.closeBehavior, data.transcriptOnClose, data.allowMultiple, data.buttonStyle,
      JSON.stringify(data.modalFields ?? []),
    ],
  );
  return rows[0];
}

export async function listPanelOptions(panelId) {
  const { rows } = await query(
    "SELECT * FROM ticket_panel_options WHERE panel_id=$1 ORDER BY position,id",
    [panelId],
  );
  return rows;
}

export async function getPanelOption(optionId) {
  const { rows } = await query("SELECT * FROM ticket_panel_options WHERE id=$1", [optionId]);
  return rows[0] ?? null;
}

export async function updatePanelOption(optionId, patch) {
  const allowed = [
    "position","component_kind","label","description","emoji","action","category_id","closed_category_id",
    "staff_roles","ping_roles","log_channel_id","transcript_channel_id","welcome_message",
    "ticket_name_template","close_behavior","transcript_on_close","allow_multiple","button_style","modal_fields"
  ];
  const keys = Object.keys(patch).filter((key) => allowed.includes(key));
  if (!keys.length) throw new Error("No editable option fields were provided.");
  const values = keys.map((key) => ["staff_roles","ping_roles","modal_fields"].includes(key)
    ? JSON.stringify(key === "modal_fields" ? patch[key] : unique(patch[key]))
    : patch[key]);
  const assignments = keys.map((key, i) =>
    `${key} = $\{i + 2}${["staff_roles","ping_roles","modal_fields"].includes(key) ? "::jsonb" : ""}`
  ).join(", ");
  const { rows } = await query(
    `UPDATE ticket_panel_options SET ${assignments}, updated_at=NOW() WHERE id=$1 RETURNING *`,
    [optionId, ...values],
  );
  return rows[0] ?? null;
}

export async function deletePanelOption(optionId) {
  await query("DELETE FROM ticket_panel_options WHERE id=$1", [optionId]);
}

export async function getTicketByChannel(guildId, channelId) {
  const { rows } = await query(
    "SELECT * FROM tickets WHERE guild_id=$1 AND channel_id=$2",
    [guildId, channelId],
  );
  return rows[0] ?? null;
}

export async function getOpenTicketForUser(guildId, ownerId, optionId) {
  const { rows } = await query(
    `SELECT * FROM tickets WHERE guild_id=$1 AND owner_id=$2 AND option_id=$3 AND status IN ('open','locked')
     ORDER BY created_at DESC LIMIT 1`,
    [guildId, ownerId, optionId],
  );
  return rows[0] ?? null;
}

export async function createTicket(data) {
  const { rows } = await query(
    `WITH next_id AS (SELECT nextval('tickets_id_seq') AS id)
     INSERT INTO tickets
      (id,guild_id,panel_id,option_id,ticket_key,channel_id,owner_id,type_label,status,category_id,closed_category_id,
       staff_roles,ping_roles,dedupe_key,log_channel_id,transcript_channel_id,close_behavior,transcript_on_close)
     SELECT id,$1,$2,$3,'EV-' || LPAD(id::text,4,'0'),$4,$5,$6,'open',$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15
     FROM next_id
     RETURNING *`,
    [
      data.guildId, data.panelId, data.optionId, data.channelId, data.ownerId, data.typeLabel,
      data.categoryId, data.closedCategoryId, JSON.stringify(unique(data.staffRoles)),
      JSON.stringify(unique(data.pingRoles)), data.dedupeKey ?? null, data.logChannelId, data.transcriptChannelId,
      data.closeBehavior || "move", data.transcriptOnClose !== false,
    ],
  );
  return rows[0];
}

export async function updateTicket(ticketId, patch) {
  const allowed = [
    "status","claimed_by","transcript_url","closed_at","reopened_at","deleted_at","channel_id","ticket_key"
  ];
  const keys = Object.keys(patch).filter((key) => allowed.includes(key));
  if (!keys.length) throw new Error("No editable ticket fields were provided.");
  const values = keys.map((key) => patch[key]);
  const assignments = keys.map((key, i) => `${key}=$\{i + 2}`).join(", ");
  const { rows } = await query(
    `UPDATE tickets SET ${assignments} WHERE id=$1 RETURNING *`,
    [ticketId, ...values],
  );
  return rows[0] ?? null;
}

export async function addTicketMember(ticketId, userId, addedBy) {
  await query(
    `INSERT INTO ticket_members(ticket_id,user_id,added_by)
     VALUES($1,$2,$3) ON CONFLICT(ticket_id,user_id) DO NOTHING`,
    [ticketId, userId, addedBy],
  );
}

export async function removeTicketMember(ticketId, userId) {
  await query("DELETE FROM ticket_members WHERE ticket_id=$1 AND user_id=$2", [ticketId, userId]);
}

export async function listTicketMembers(ticketId) {
  const { rows } = await query("SELECT user_id FROM ticket_members WHERE ticket_id=$1 ORDER BY added_at", [ticketId]);
  return rows.map((r) => r.user_id);
}

export async function addTicketEvent(ticketId, eventType, actorId, details = {}) {
  await query(
    "INSERT INTO ticket_events(ticket_id,event_type,actor_id,details) VALUES($1,$2,$3,$4::jsonb)",
    [ticketId, eventType, actorId, JSON.stringify(details)],
  );
}

export async function listTicketEvents(ticketId) {
  const { rows } = await query(
    "SELECT * FROM ticket_events WHERE ticket_id=$1 ORDER BY created_at ASC",
    [ticketId],
  );
  return rows;
}

export async function countOpenTickets(guildId, ownerId) {
  const { rows } = await query(
    "SELECT COUNT(*)::int AS count FROM tickets WHERE guild_id=$1 AND owner_id=$2 AND status IN ('open','locked')",
    [guildId, ownerId],
  );
  return rows[0].count;
}
