const SCHEMA_LOCK_KEY = "evix:schema-migrations";

const MIGRATIONS = [
  {
    version: 1,
    name: "baseline",
    transactional: true,
    async run(client) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS guild_ticket_settings (
          guild_id TEXT PRIMARY KEY,
          ticket_category_id TEXT,
          backup_category_id TEXT,
          closed_category_id TEXT,
          ticket_log_channel_id TEXT,
          moderation_log_channel_id TEXT,
          transcript_log_channel_id TEXT,
          ticket_logs_enabled BOOLEAN NOT NULL DEFAULT TRUE,
          moderation_logs_enabled BOOLEAN NOT NULL DEFAULT TRUE,
          transcript_logs_enabled BOOLEAN NOT NULL DEFAULT TRUE,
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
          claimed_at TIMESTAMPTZ,
          closed_by TEXT,
          category_id TEXT,
          current_category_id TEXT,
          closed_category_id TEXT,
          staff_roles JSONB NOT NULL DEFAULT '[]'::jsonb,
          ping_roles JSONB NOT NULL DEFAULT '[]'::jsonb,
          dedupe_key TEXT,
          ticket_log_channel_id TEXT,
          moderation_log_channel_id TEXT,
          transcript_log_channel_id TEXT,
          ticket_logs_enabled BOOLEAN NOT NULL DEFAULT TRUE,
          moderation_logs_enabled BOOLEAN NOT NULL DEFAULT TRUE,
          transcript_logs_enabled BOOLEAN NOT NULL DEFAULT TRUE,
          transcript_url TEXT,
          control_message_id TEXT,
          welcome_message TEXT NOT NULL DEFAULT 'Thanks for opening a ticket. A member of the team will be with you shortly.',
          close_behavior TEXT NOT NULL DEFAULT 'move' CHECK (close_behavior IN ('move', 'stay')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          closed_at TIMESTAMPTZ,
          reopened_at TIMESTAMPTZ,
          deleted_at TIMESTAMPTZ,
          UNIQUE (guild_id, channel_id)
        );

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

        ALTER TABLE guild_ticket_settings ADD COLUMN IF NOT EXISTS ticket_category_id TEXT;
        ALTER TABLE guild_ticket_settings ADD COLUMN IF NOT EXISTS backup_category_id TEXT;
        ALTER TABLE guild_ticket_settings ADD COLUMN IF NOT EXISTS closed_category_id TEXT;
        ALTER TABLE guild_ticket_settings ADD COLUMN IF NOT EXISTS ticket_log_channel_id TEXT;
        ALTER TABLE guild_ticket_settings ADD COLUMN IF NOT EXISTS moderation_log_channel_id TEXT;
        ALTER TABLE guild_ticket_settings ADD COLUMN IF NOT EXISTS transcript_log_channel_id TEXT;
        ALTER TABLE guild_ticket_settings ADD COLUMN IF NOT EXISTS ticket_logs_enabled BOOLEAN DEFAULT TRUE;
        ALTER TABLE guild_ticket_settings ADD COLUMN IF NOT EXISTS moderation_logs_enabled BOOLEAN DEFAULT TRUE;
        ALTER TABLE guild_ticket_settings ADD COLUMN IF NOT EXISTS transcript_logs_enabled BOOLEAN DEFAULT TRUE;
        ALTER TABLE guild_ticket_settings ADD COLUMN IF NOT EXISTS default_ticket_limit INTEGER DEFAULT 1;
        ALTER TABLE guild_ticket_settings ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
        ALTER TABLE guild_ticket_settings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

        ALTER TABLE ticket_panels ADD COLUMN IF NOT EXISTS name TEXT;
        ALTER TABLE ticket_panels ADD COLUMN IF NOT EXISTS channel_id TEXT;
        ALTER TABLE ticket_panels ADD COLUMN IF NOT EXISTS message_id TEXT;
        ALTER TABLE ticket_panels ADD COLUMN IF NOT EXISTS component_mode TEXT DEFAULT 'dropdown';
        ALTER TABLE ticket_panels ADD COLUMN IF NOT EXISTS title TEXT DEFAULT '';
        ALTER TABLE ticket_panels ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '';
        ALTER TABLE ticket_panels ADD COLUMN IF NOT EXISTS image_url TEXT;
        ALTER TABLE ticket_panels ADD COLUMN IF NOT EXISTS accent_color INTEGER DEFAULT 5793266;
        ALTER TABLE ticket_panels ADD COLUMN IF NOT EXISTS placeholder TEXT DEFAULT '';
        ALTER TABLE ticket_panels ADD COLUMN IF NOT EXISTS footer TEXT DEFAULT '';
        ALTER TABLE ticket_panels ADD COLUMN IF NOT EXISTS footer_show_bot BOOLEAN DEFAULT FALSE;
        ALTER TABLE ticket_panels ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
        ALTER TABLE ticket_panels ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

        ALTER TABLE ticket_panel_options ADD COLUMN IF NOT EXISTS position INTEGER DEFAULT 0;
        ALTER TABLE ticket_panel_options ADD COLUMN IF NOT EXISTS component_kind TEXT DEFAULT 'dropdown';
        ALTER TABLE ticket_panel_options ADD COLUMN IF NOT EXISTS description TEXT;
        ALTER TABLE ticket_panel_options ADD COLUMN IF NOT EXISTS emoji TEXT;
        ALTER TABLE ticket_panel_options ADD COLUMN IF NOT EXISTS action TEXT DEFAULT 'CREATE_TICKET';
        ALTER TABLE ticket_panel_options ADD COLUMN IF NOT EXISTS category_id TEXT;
        ALTER TABLE ticket_panel_options ADD COLUMN IF NOT EXISTS closed_category_id TEXT;
        ALTER TABLE ticket_panel_options ADD COLUMN IF NOT EXISTS staff_roles JSONB DEFAULT '[]'::jsonb;
        ALTER TABLE ticket_panel_options ADD COLUMN IF NOT EXISTS ping_roles JSONB DEFAULT '[]'::jsonb;
        ALTER TABLE ticket_panel_options ADD COLUMN IF NOT EXISTS log_channel_id TEXT;
        ALTER TABLE ticket_panel_options ADD COLUMN IF NOT EXISTS moderation_log_channel_id TEXT;
        ALTER TABLE ticket_panel_options ADD COLUMN IF NOT EXISTS transcript_channel_id TEXT;
        ALTER TABLE ticket_panel_options ADD COLUMN IF NOT EXISTS welcome_message TEXT DEFAULT '';
        ALTER TABLE ticket_panel_options ADD COLUMN IF NOT EXISTS ticket_name_template TEXT DEFAULT 'ticket-{number}';
        ALTER TABLE ticket_panel_options ADD COLUMN IF NOT EXISTS close_behavior TEXT DEFAULT 'move';
        ALTER TABLE ticket_panel_options ADD COLUMN IF NOT EXISTS allow_multiple BOOLEAN DEFAULT FALSE;
        ALTER TABLE ticket_panel_options ADD COLUMN IF NOT EXISTS button_style INTEGER DEFAULT 2;
        ALTER TABLE ticket_panel_options ADD COLUMN IF NOT EXISTS modal_fields JSONB DEFAULT '[]'::jsonb;
        ALTER TABLE ticket_panel_options ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
        ALTER TABLE ticket_panel_options ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

        ALTER TABLE tickets ADD COLUMN IF NOT EXISTS panel_id BIGINT;
        ALTER TABLE tickets ADD COLUMN IF NOT EXISTS option_id BIGINT;
        ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ticket_key TEXT;
        ALTER TABLE tickets ADD COLUMN IF NOT EXISTS channel_id TEXT;
        ALTER TABLE tickets ADD COLUMN IF NOT EXISTS owner_id TEXT;
        ALTER TABLE tickets ADD COLUMN IF NOT EXISTS type_label TEXT;
        ALTER TABLE tickets ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'open';
        ALTER TABLE tickets ADD COLUMN IF NOT EXISTS claimed_by TEXT;
        ALTER TABLE tickets ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
        ALTER TABLE tickets ADD COLUMN IF NOT EXISTS closed_by TEXT;
        ALTER TABLE tickets ADD COLUMN IF NOT EXISTS category_id TEXT;
        ALTER TABLE tickets ADD COLUMN IF NOT EXISTS current_category_id TEXT;
        ALTER TABLE tickets ADD COLUMN IF NOT EXISTS closed_category_id TEXT;
        ALTER TABLE tickets ADD COLUMN IF NOT EXISTS staff_roles JSONB DEFAULT '[]'::jsonb;
        ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ping_roles JSONB DEFAULT '[]'::jsonb;
        ALTER TABLE tickets ADD COLUMN IF NOT EXISTS dedupe_key TEXT;
        ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ticket_log_channel_id TEXT;
        ALTER TABLE tickets ADD COLUMN IF NOT EXISTS moderation_log_channel_id TEXT;
        ALTER TABLE tickets ADD COLUMN IF NOT EXISTS transcript_log_channel_id TEXT;
        ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ticket_logs_enabled BOOLEAN DEFAULT TRUE;
        ALTER TABLE tickets ADD COLUMN IF NOT EXISTS moderation_logs_enabled BOOLEAN DEFAULT TRUE;
        ALTER TABLE tickets ADD COLUMN IF NOT EXISTS transcript_logs_enabled BOOLEAN DEFAULT TRUE;
        ALTER TABLE tickets ADD COLUMN IF NOT EXISTS transcript_url TEXT;
        ALTER TABLE tickets ADD COLUMN IF NOT EXISTS control_message_id TEXT;
        ALTER TABLE tickets ADD COLUMN IF NOT EXISTS welcome_message TEXT DEFAULT 'Thanks for opening a ticket. A member of the team will be with you shortly.';
        ALTER TABLE tickets ADD COLUMN IF NOT EXISTS close_behavior TEXT DEFAULT 'move';
        ALTER TABLE tickets ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
        ALTER TABLE tickets ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
        ALTER TABLE tickets ADD COLUMN IF NOT EXISTS reopened_at TIMESTAMPTZ;
        ALTER TABLE tickets ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

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
      `);
    },
  },
  {
    version: 2,
    name: "normalize-and-cleanup",
    transactional: true,
    async run(client) {
      await client.query(`
        ALTER TABLE guild_ticket_settings ADD COLUMN IF NOT EXISTS open_category_id TEXT;
        ALTER TABLE guild_ticket_settings ADD COLUMN IF NOT EXISTS log_channel_id TEXT;
        ALTER TABLE guild_ticket_settings ADD COLUMN IF NOT EXISTS transcript_channel_id TEXT;
        ALTER TABLE guild_ticket_settings ADD COLUMN IF NOT EXISTS waiting_category_id TEXT;

        ALTER TABLE tickets ADD COLUMN IF NOT EXISTS log_channel_id TEXT;
        ALTER TABLE tickets ADD COLUMN IF NOT EXISTS transcript_channel_id TEXT;
        ALTER TABLE tickets ADD COLUMN IF NOT EXISTS waiting_at TIMESTAMPTZ;

        ALTER TABLE ticket_panel_options ADD COLUMN IF NOT EXISTS transcript_on_close BOOLEAN;
        ALTER TABLE tickets ADD COLUMN IF NOT EXISTS transcript_on_close BOOLEAN;

        UPDATE guild_ticket_settings
        SET ticket_category_id = COALESCE(ticket_category_id, open_category_id),
            ticket_log_channel_id = COALESCE(ticket_log_channel_id, log_channel_id),
            transcript_log_channel_id = COALESCE(transcript_log_channel_id, transcript_channel_id),
            ticket_logs_enabled = COALESCE(ticket_logs_enabled, TRUE),
            moderation_logs_enabled = COALESCE(moderation_logs_enabled, TRUE),
            transcript_logs_enabled = COALESCE(transcript_logs_enabled, TRUE),
            default_ticket_limit = GREATEST(1, LEAST(25, COALESCE(default_ticket_limit, 1))),
            updated_at = COALESCE(updated_at, NOW());

        UPDATE ticket_panels
        SET name = COALESCE(NULLIF(BTRIM(name), ''), 'panel-' || id::text),
            component_mode = 'dropdown',
            title = COALESCE(title, ''),
            description = COALESCE(description, ''),
            placeholder = COALESCE(placeholder, ''),
            footer = COALESCE(footer, ''),
            footer_show_bot = COALESCE(footer_show_bot, FALSE),
            accent_color = COALESCE(accent_color, 5793266),
            created_at = COALESCE(created_at, NOW()),
            updated_at = COALESCE(updated_at, NOW());

        UPDATE ticket_panel_options
        SET position = COALESCE(position, 0),
            component_kind = 'dropdown',
            action = CASE WHEN action IN ('CREATE_TICKET', 'NOTHING') THEN action ELSE 'CREATE_TICKET' END,
            staff_roles = COALESCE(staff_roles, '[]'::jsonb),
            ping_roles = COALESCE(ping_roles, '[]'::jsonb),
            welcome_message = COALESCE(welcome_message, ''),
            ticket_name_template = COALESCE(NULLIF(BTRIM(ticket_name_template), ''), 'ticket-{number}'),
            close_behavior = CASE WHEN close_behavior IN ('move', 'stay') THEN close_behavior ELSE 'move' END,
            allow_multiple = COALESCE(allow_multiple, FALSE),
            button_style = GREATEST(1, LEAST(4, COALESCE(button_style, 2))),
            modal_fields = COALESCE(modal_fields, '[]'::jsonb),
            created_at = COALESCE(created_at, NOW()),
            updated_at = COALESCE(updated_at, NOW());

        UPDATE tickets
        SET claimed_by = NULL,
            claimed_at = NULL
        WHERE status <> 'open';

        UPDATE tickets
        SET ticket_key = CASE
              WHEN ticket_key IS DISTINCT FROM ('EVX-' || LPAD(id::text, 6, '0'))
                THEN 'EVX-' || LPAD(id::text, 6, '0')
              ELSE ticket_key
            END,
            status = CASE
              WHEN status IN ('open', 'closed', 'deleted') THEN status
              WHEN status IN ('waiting', 'locked') THEN 'open'
              ELSE 'open'
            END,
            ticket_logs_enabled = COALESCE(ticket_logs_enabled, TRUE),
            moderation_logs_enabled = COALESCE(moderation_logs_enabled, TRUE),
            transcript_logs_enabled = COALESCE(transcript_logs_enabled, TRUE),
            staff_roles = COALESCE(staff_roles, '[]'::jsonb),
            ping_roles = COALESCE(ping_roles, '[]'::jsonb),
            welcome_message = COALESCE(welcome_message, 'Thanks for opening a ticket. A member of the team will be with you shortly.'),
            close_behavior = CASE WHEN close_behavior IN ('move', 'stay') THEN close_behavior ELSE 'move' END,
            created_at = COALESCE(created_at, NOW());

        ALTER TABLE guild_ticket_settings DROP COLUMN IF EXISTS open_category_id;
        ALTER TABLE guild_ticket_settings DROP COLUMN IF EXISTS log_channel_id;
        ALTER TABLE guild_ticket_settings DROP COLUMN IF EXISTS transcript_channel_id;
        ALTER TABLE guild_ticket_settings DROP COLUMN IF EXISTS waiting_category_id;

        ALTER TABLE tickets DROP COLUMN IF EXISTS log_channel_id;
        ALTER TABLE tickets DROP COLUMN IF EXISTS transcript_channel_id;
        ALTER TABLE tickets DROP COLUMN IF EXISTS waiting_at;

        ALTER TABLE ticket_panel_options DROP COLUMN IF EXISTS transcript_on_close;
        ALTER TABLE tickets DROP COLUMN IF EXISTS transcript_on_close;

        ALTER TABLE guild_ticket_settings ALTER COLUMN ticket_logs_enabled SET DEFAULT TRUE;
        ALTER TABLE guild_ticket_settings ALTER COLUMN moderation_logs_enabled SET DEFAULT TRUE;
        ALTER TABLE guild_ticket_settings ALTER COLUMN transcript_logs_enabled SET DEFAULT TRUE;
        ALTER TABLE guild_ticket_settings ALTER COLUMN default_ticket_limit SET DEFAULT 1;

        ALTER TABLE tickets ALTER COLUMN ticket_logs_enabled SET DEFAULT TRUE;
        ALTER TABLE tickets ALTER COLUMN moderation_logs_enabled SET DEFAULT TRUE;
        ALTER TABLE tickets ALTER COLUMN transcript_logs_enabled SET DEFAULT TRUE;
        ALTER TABLE tickets ALTER COLUMN close_behavior SET DEFAULT 'move';

        ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_status_check;
        ALTER TABLE tickets ADD CONSTRAINT tickets_status_check
          CHECK (status IN ('open', 'closed', 'deleted'));

        ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_close_behavior_check;
        ALTER TABLE tickets ADD CONSTRAINT tickets_close_behavior_check
          CHECK (close_behavior IN ('move', 'stay'));

        ALTER TABLE ticket_panels DROP CONSTRAINT IF EXISTS ticket_panels_component_mode_check;
        ALTER TABLE ticket_panels ADD CONSTRAINT ticket_panels_component_mode_check
          CHECK (component_mode = 'dropdown');

        ALTER TABLE ticket_panel_options DROP CONSTRAINT IF EXISTS ticket_panel_options_component_kind_check;
        ALTER TABLE ticket_panel_options ADD CONSTRAINT ticket_panel_options_component_kind_check
          CHECK (component_kind = 'dropdown');

        ALTER TABLE ticket_panel_options DROP CONSTRAINT IF EXISTS ticket_panel_options_action_check;
        ALTER TABLE ticket_panel_options ADD CONSTRAINT ticket_panel_options_action_check
          CHECK (action IN ('CREATE_TICKET', 'NOTHING'));

        ALTER TABLE ticket_panel_options DROP CONSTRAINT IF EXISTS ticket_panel_options_close_behavior_check;
        ALTER TABLE ticket_panel_options ADD CONSTRAINT ticket_panel_options_close_behavior_check
          CHECK (close_behavior IN ('move', 'stay'));

        ALTER TABLE ticket_panel_options DROP CONSTRAINT IF EXISTS ticket_panel_options_button_style_check;
        ALTER TABLE ticket_panel_options ADD CONSTRAINT ticket_panel_options_button_style_check
          CHECK (button_style BETWEEN 1 AND 4);

        ALTER TABLE guild_ticket_settings DROP CONSTRAINT IF EXISTS guild_ticket_settings_limit_check;
        ALTER TABLE guild_ticket_settings ADD CONSTRAINT guild_ticket_settings_limit_check
          CHECK (default_ticket_limit BETWEEN 1 AND 25);

        ALTER TABLE guild_ticket_settings ALTER COLUMN ticket_logs_enabled SET NOT NULL;
        ALTER TABLE guild_ticket_settings ALTER COLUMN moderation_logs_enabled SET NOT NULL;
        ALTER TABLE guild_ticket_settings ALTER COLUMN transcript_logs_enabled SET NOT NULL;
        ALTER TABLE guild_ticket_settings ALTER COLUMN default_ticket_limit SET NOT NULL;

        ALTER TABLE tickets ALTER COLUMN ticket_logs_enabled SET NOT NULL;
        ALTER TABLE tickets ALTER COLUMN moderation_logs_enabled SET NOT NULL;
        ALTER TABLE tickets ALTER COLUMN transcript_logs_enabled SET NOT NULL;
        ALTER TABLE tickets ALTER COLUMN close_behavior SET NOT NULL;
      `);
    },
  },
  {
    version: 3,
    name: "workload-indexes",
    transactional: false,
    async run(client) {
      await client.query(`
        DROP INDEX CONCURRENTLY IF EXISTS tickets_one_active_per_type;

        CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS tickets_one_active_dedupe_idx
          ON tickets (guild_id, owner_id, option_id, dedupe_key)
          WHERE status = 'open' AND dedupe_key IS NOT NULL;

        CREATE INDEX CONCURRENTLY IF NOT EXISTS tickets_open_owner_option_idx
          ON tickets (guild_id, owner_id, option_id, created_at DESC)
          WHERE status = 'open';

        CREATE INDEX CONCURRENTLY IF NOT EXISTS panels_guild_id_idx
          ON ticket_panels (guild_id, id);

        CREATE INDEX CONCURRENTLY IF NOT EXISTS ticket_events_ticket_created_id_idx
          ON ticket_events (ticket_id, created_at, id);
      `);

      await client.query("DROP INDEX CONCURRENTLY IF EXISTS tickets_owner_idx");
      await client.query("DROP INDEX CONCURRENTLY IF EXISTS tickets_guild_status_idx");
      await client.query("DROP INDEX CONCURRENTLY IF EXISTS panels_guild_idx");
      await client.query("DROP INDEX CONCURRENTLY IF EXISTS ticket_members_ticket_idx");
      await client.query("DROP INDEX CONCURRENTLY IF EXISTS ticket_events_ticket_idx");
    },
  },
];

async function ensureMigrationTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function runMigrations(pool) {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [SCHEMA_LOCK_KEY]);
    await ensureMigrationTable(client);

    const { rows } = await client.query("SELECT version FROM schema_migrations ORDER BY version");
    const applied = new Set(rows.map((row) => Number(row.version)));

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;

      if (migration.transactional) {
        await client.query("BEGIN");
        try {
          await migration.run(client);
          await client.query(
            "INSERT INTO schema_migrations(version,name) VALUES($1,$2)",
            [migration.version, migration.name],
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => null);
          throw error;
        }
      } else {
        await migration.run(client);
        await client.query(
          "INSERT INTO schema_migrations(version,name) VALUES($1,$2)",
          [migration.version, migration.name],
        );
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [SCHEMA_LOCK_KEY]).catch(() => null);
    client.release();
  }
}
