import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import {
  allocateTicketId,
  closeDatabase,
  createTicket,
  getGuildSettings,
  initDatabase,
  upsertGuildSettings,
} from "../src/db.js";

const databaseUrl = process.env.DATABASE_URL;

test("PostgreSQL migration and workload smoke test", { skip: !databaseUrl }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const guildId = "integration-guild";
  const ticketChannelId = "evix-integration-ticket-1";
  const reservedChannelId = "evix-integration-ticket-2";

  try {
    await pool.query("DROP TABLE IF EXISTS ticket_events CASCADE; DROP TABLE IF EXISTS ticket_members CASCADE; DROP TABLE IF EXISTS tickets CASCADE; DROP TABLE IF EXISTS ticket_panel_options CASCADE; DROP TABLE IF EXISTS ticket_panels CASCADE; DROP TABLE IF EXISTS guild_ticket_settings CASCADE; DROP TABLE IF EXISTS schema_migrations CASCADE;");
    await pool.query(
      "CREATE TABLE guild_ticket_settings (" +
      "guild_id TEXT PRIMARY KEY, open_category_id TEXT, log_channel_id TEXT, transcript_channel_id TEXT, " +
      "default_ticket_limit INTEGER, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ)",
    );
    await pool.query(
      "CREATE TABLE ticket_panels (" +
      "id BIGSERIAL PRIMARY KEY, guild_id TEXT NOT NULL, name TEXT NOT NULL, component_mode TEXT, " +
      "title TEXT, description TEXT, accent_color INTEGER, placeholder TEXT, footer TEXT, footer_show_bot BOOLEAN, " +
      "created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, UNIQUE (guild_id, name))",
    );
    await pool.query(
      "CREATE TABLE ticket_panel_options (id BIGSERIAL PRIMARY KEY, panel_id BIGINT, label TEXT NOT NULL)",
    );
    await pool.query(
      "CREATE TABLE tickets (" +
      "id BIGSERIAL PRIMARY KEY, guild_id TEXT NOT NULL, panel_id BIGINT, option_id BIGINT, ticket_key TEXT, " +
      "channel_id TEXT NOT NULL, owner_id TEXT NOT NULL, type_label TEXT, status TEXT, claimed_by TEXT, " +
      "claimed_at TIMESTAMPTZ, closed_by TEXT, category_id TEXT, staff_roles JSONB, ping_roles JSONB, dedupe_key TEXT, " +
      "log_channel_id TEXT, transcript_channel_id TEXT, created_at TIMESTAMPTZ, closed_at TIMESTAMPTZ, " +
      "reopened_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ, UNIQUE (guild_id, channel_id))",
    );

    await pool.query(
      "INSERT INTO guild_ticket_settings (guild_id,open_category_id,log_channel_id,transcript_channel_id,default_ticket_limit,created_at,updated_at) " +
      "VALUES ($1,$2,$3,$4,$5,NOW(),NOW())",
      [guildId, "legacy-category", "legacy-ticket-log", "legacy-transcript-log", 1],
    );
    await pool.query(
      "INSERT INTO tickets (guild_id,ticket_key,channel_id,owner_id,type_label,status,category_id,log_channel_id,transcript_channel_id,created_at) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())",
      [guildId, "OLD-KEY", ticketChannelId, "owner-1", "Legacy", "closed", "legacy-category", "legacy-ticket-log", "legacy-transcript-log"],
    );

    await initDatabase(databaseUrl);

    const migrations = await pool.query("SELECT version FROM schema_migrations ORDER BY version");
    assert.deepEqual(migrations.rows.map((row) => Number(row.version)), [1, 2, 3]);

    const settingsColumns = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='guild_ticket_settings' ORDER BY column_name");
    const ticketColumns = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='tickets' ORDER BY column_name");
    const settingColumnNames = new Set(settingsColumns.rows.map((row) => row.column_name));
    const ticketColumnNames = new Set(ticketColumns.rows.map((row) => row.column_name));

    assert.equal(settingColumnNames.has("ticket_category_id"), true);
    assert.equal(settingColumnNames.has("ticket_log_channel_id"), true);
    assert.equal(settingColumnNames.has("transcript_log_channel_id"), true);
    assert.equal(settingColumnNames.has("open_category_id"), false);
    assert.equal(settingColumnNames.has("log_channel_id"), false);
    assert.equal(settingColumnNames.has("transcript_channel_id"), false);
    assert.equal(ticketColumnNames.has("ticket_log_channel_id"), true);
    assert.equal(ticketColumnNames.has("transcript_log_channel_id"), true);
    assert.equal(ticketColumnNames.has("log_channel_id"), false);
    assert.equal(ticketColumnNames.has("transcript_channel_id"), false);

    const settings = await getGuildSettings(guildId);
    assert.equal(settings.ticket_category_id, "legacy-category");
    assert.equal(settings.ticket_log_channel_id, "legacy-ticket-log");
    assert.equal(settings.transcript_log_channel_id, "legacy-transcript-log");

    await Promise.all([
      upsertGuildSettings(guildId, { backup_category_id: "backup-category" }),
      upsertGuildSettings(guildId, { closed_category_id: "closed-category" }),
    ]);
    const mergedSettings = await getGuildSettings(guildId);
    assert.equal(mergedSettings.backup_category_id, "backup-category");
    assert.equal(mergedSettings.closed_category_id, "closed-category");

    const first = await createTicket({
      guildId,
      channelId: reservedChannelId,
      ownerId: "owner-2",
      typeLabel: "Support",
      ticketLimit: 1,
    });
    assert.match(first.ticket_key, /^EVX-[0-9]{6,}$/);

    await assert.rejects(
      () => createTicket({
        guildId,
        channelId: ticketChannelId + "-second",
        ownerId: "owner-2",
        typeLabel: "Support",
        ticketLimit: 1,
      }),
      (error) => error.code === "EVIX_TICKET_LIMIT",
    );

    const reservedId = await allocateTicketId();
    const reserved = await createTicket({
      id: reservedId,
      guildId,
      channelId: "evix-integration-ticket-3",
      ownerId: "owner-3",
      typeLabel: "Reserved",
      ticketLimit: 1,
    });
    assert.equal(Number(reserved.id), reservedId);
    assert.equal(reserved.ticket_key, "EVX-" + String(reservedId).padStart(6, "0"));

    const indexes = await pool.query("SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() AND tablename IN ('tickets','ticket_events','ticket_panels') ORDER BY indexname");
    const indexNames = new Set(indexes.rows.map((row) => row.indexname));
    assert.equal(indexNames.has("tickets_open_owner_option_idx"), true);
    assert.equal(indexNames.has("ticket_events_ticket_created_id_idx"), true);
    assert.equal(indexNames.has("panels_guild_id_idx"), true);
    assert.equal(indexNames.has("tickets_owner_idx"), false);
    assert.equal(indexNames.has("tickets_guild_status_idx"), false);
    assert.equal(indexNames.has("panels_guild_idx"), false);
  } finally {
    await closeDatabase().catch(() => null);
    await pool.end();
  }
});