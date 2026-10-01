import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import {
  closeDatabase,
  createPanel,
  createTicket,
  getGuildSettings,
  getPool,
  getTicketById,
  initDatabase,
  updateTicket,
  upsertGuildSettings,
} from "../src/db.js";

const DATABASE_URL = process.env.CHAOS_DATABASE_URL;
const RUNS = Number(process.env.EVIX_CHAOS_RUNS ?? 800);

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeNetworkError(kind = "ECONNRESET") {
  const error = new Error("simulated PostgreSQL transport failure: " + kind);
  error.code = kind;
  error.name = "PostgresChaosError";
  return error;
}

async function resetSchema() {
  await getPool().query(
    "TRUNCATE ticket_events, ticket_members, tickets, ticket_panel_options, ticket_panels, guild_ticket_settings RESTART IDENTITY CASCADE",
  );
}

async function installRollbackTrigger(pool) {
  await pool.query(`
    CREATE OR REPLACE FUNCTION evix_chaos_fail_panel_option()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.label = 'Open Ticket' THEN
        RAISE EXCEPTION 'intentional PostgreSQL chaos rollback';
      END IF;
      RETURN NEW;
    END;
    $$;
    DROP TRIGGER IF EXISTS evix_chaos_fail_panel_option_trigger ON ticket_panel_options;
    CREATE TRIGGER evix_chaos_fail_panel_option_trigger
      BEFORE INSERT ON ticket_panel_options
      FOR EACH ROW EXECUTE FUNCTION evix_chaos_fail_panel_option();
  `);
}

async function removeRollbackTrigger(pool) {
  await pool.query("DROP TRIGGER IF EXISTS evix_chaos_fail_panel_option_trigger ON ticket_panel_options");
  await pool.query("DROP FUNCTION IF EXISTS evix_chaos_fail_panel_option()");
}

async function installSettingsDelayTrigger(pool) {
  await pool.query(`
    CREATE OR REPLACE FUNCTION evix_chaos_delay_settings_update()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      PERFORM pg_sleep(0.08);
      RETURN NEW;
    END;
    $$;
    DROP TRIGGER IF EXISTS evix_chaos_delay_settings_update_trigger ON guild_ticket_settings;
    CREATE TRIGGER evix_chaos_delay_settings_update_trigger
      BEFORE UPDATE ON guild_ticket_settings
      FOR EACH ROW EXECUTE FUNCTION evix_chaos_delay_settings_update();
  `);
}

async function removeSettingsDelayTrigger(pool) {
  await pool.query("DROP TRIGGER IF EXISTS evix_chaos_delay_settings_update_trigger ON guild_ticket_settings");
  await pool.query("DROP FUNCTION IF EXISTS evix_chaos_delay_settings_update()");
}

async function installTicketLatencyTrigger(pool) {
  await pool.query(`
    CREATE OR REPLACE FUNCTION evix_chaos_delay_ticket_insert()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.guild_id = 'chaos-guild' THEN
        PERFORM pg_sleep(0.008);
      END IF;
      RETURN NEW;
    END;
    $$;
    DROP TRIGGER IF EXISTS evix_chaos_delay_ticket_insert_trigger ON tickets;
    CREATE TRIGGER evix_chaos_delay_ticket_insert_trigger
      BEFORE INSERT ON tickets
      FOR EACH ROW EXECUTE FUNCTION evix_chaos_delay_ticket_insert();
  `);
}

async function removeTicketLatencyTrigger(pool) {
  await pool.query("DROP TRIGGER IF EXISTS evix_chaos_delay_ticket_insert_trigger ON tickets");
  await pool.query("DROP FUNCTION IF EXISTS evix_chaos_delay_ticket_insert()");
}

function installQueryChaos({ seed, delayProbability = 0.2, failProbability = 0.04, maxDelayMs = 12 }) {
  const pool = getPool();
  const random = rng(seed);
  const originalQuery = pool.query.bind(pool);

  pool.query = async function chaosQuery(textOrConfig, params) {
    if (delayProbability && random() < delayProbability) {
      await new Promise((resolve) => setTimeout(resolve, Math.floor(random() * maxDelayMs) + 1));
    }
    if (failProbability && random() < failProbability) {
      throw makeNetworkError(random() < 0.5 ? "ECONNRESET" : "ETIMEDOUT");
    }
    return originalQuery(textOrConfig, params);
  };

  return () => {
    pool.query = originalQuery;
  };
}

test("isolated PostgreSQL chaos audit: transactions, concurrency, failure recovery, and invariants", {
  timeout: 240_000,
  skip: !DATABASE_URL,
}, async () => {
  if (!DATABASE_URL) {
    throw new Error("CHAOS_DATABASE_URL is required; this audit must never fall back to a non-isolated database.");
  }

  const poolKiller = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
  let pool;
  await initDatabase(DATABASE_URL);
  pool = getPool();
  await resetSchema();

  try {
    const seed = 0xE51A505;

    assert.equal((await pool.query("SELECT 1 AS ok")).rows[0].ok, 1);

    // Real PostgreSQL reproduction of the guild-settings read/modify/write race.
    await upsertGuildSettings("guild-race", {
      ticket_category_id: "base-ticket",
      waiting_category_id: "base-waiting",
      backup_category_id: "base-backup",
      default_ticket_limit: 3,
    });
    await installSettingsDelayTrigger(pool);
    try {
      await Promise.all([
        upsertGuildSettings("guild-race", { ticket_category_id: "ticket-A" }),
        upsertGuildSettings("guild-race", { waiting_category_id: "waiting-B" }),
      ]);
    } finally {
      await removeSettingsDelayTrigger(pool);
    }

    const raced = await getGuildSettings("guild-race");
    assert.equal(raced.ticket_category_id, "ticket-A");
    assert.equal(raced.waiting_category_id, "waiting-B");
    assert.equal(raced.backup_category_id, "base-backup");
    assert.equal(raced.default_ticket_limit, 3);

    // Real PostgreSQL trigger failure must roll back the whole createPanel transaction.
    await installRollbackTrigger(pool);
    try {
      await assert.rejects(
        () => createPanel({ guildId: "rollback-guild", name: "rollback-me" }),
        /intentional PostgreSQL chaos rollback/,
      );
    } finally {
      await removeRollbackTrigger(pool);
    }
    assert.equal(
      (await pool.query("SELECT COUNT(*)::int AS count FROM ticket_panels WHERE guild_id=$1", ["rollback-guild"])).rows[0].count,
      0,
      "transaction rollback left a partial panel row",
    );

    // Real PostgreSQL latency + concurrency: advisory locking must enforce the ticket limit.
    await installTicketLatencyTrigger(pool);
    const owners = 30;
    const outcomes = [];
    try {
      await Promise.all(
        Array.from({ length: RUNS }, (_, index) => (async () => {
          const owner = "owner-" + (index % owners);
          const channel = "channel-" + index;
          try {
            const ticket = await createTicket({
              guildId: "chaos-guild",
              panelId: null,
              optionId: null,
              channelId: channel,
              ownerId: owner,
              typeLabel: "Chaos",
              categoryId: "category",
              closedCategoryId: "closed-category",
              staffRoles: [],
              pingRoles: [],
              dedupeKey: null,
              ticketLimit: 2,
            });
            outcomes.push({ ok: true, id: ticket.id, owner, channel });
          } catch (error) {
            outcomes.push({ ok: false, code: error?.code || "UNKNOWN", owner, channel });
          }
        })()),
      );
    } finally {
      await removeTicketLatencyTrigger(pool);
    }

    const ticketRows = (await pool.query(
      "SELECT id,guild_id,owner_id,channel_id,ticket_key,status,claimed_by,claimed_at,closed_by,closed_at,waiting_at,deleted_at " +
      "FROM tickets WHERE guild_id=$1 ORDER BY id",
      ["chaos-guild"],
    )).rows;

    assert.ok(ticketRows.length > 0, "concurrent creation storm committed no tickets");
    assert.ok(ticketRows.length <= owners * 2, "ticket limit was violated under PostgreSQL advisory locking");
    assert.equal(new Set(ticketRows.map((row) => row.channel_id)).size, ticketRows.length);

    for (const row of ticketRows) {
      assert.match(row.ticket_key, /^EVX-\d{6}$/);
      assert.equal(row.status, "open");
      assert.equal(row.guild_id, "chaos-guild");
      assert.ok(row.owner_id);
      assert.ok(row.channel_id);
      assert.equal(row.closed_by, null);
      assert.equal(row.closed_at, null);
      assert.equal(row.deleted_at, null);
    }

    const ownerCounts = (await pool.query(
      "SELECT owner_id,COUNT(*)::int AS count FROM tickets WHERE guild_id=$1 AND status IN ('open','locked','waiting') GROUP BY owner_id",
      ["chaos-guild"],
    )).rows;
    for (const row of ownerCounts) {
      assert.ok(row.count <= 2, "active ticket limit exceeded for " + row.owner_id);
    }

    assert.ok(outcomes.some((entry) => entry.ok));
    assert.ok(outcomes.some((entry) => !entry.ok), "contention test did not exercise rejection paths");

    // Query-level network chaos against real PostgreSQL-backed reads/writes.
    const queryChaosTickets = [];
    for (let index = 0; index < 20; index++) {
      queryChaosTickets.push(await createTicket({
        guildId: "query-chaos-guild",
        panelId: null,
        optionId: null,
        channelId: "query-chaos-channel-" + index,
        ownerId: "query-owner-" + index,
        typeLabel: "QueryChaos",
        categoryId: "category",
        closedCategoryId: "closed-category",
        staffRoles: [],
        pingRoles: [],
        dedupeKey: null,
        ticketLimit: 25,
      }));
    }

    const restoreQueryChaos = installQueryChaos({
      seed: seed ^ 0x44444444,
      delayProbability: 0.25,
      failProbability: 0.05,
      maxDelayMs: 15,
    });
    let querySuccesses = 0;
    let queryFailures = 0;
    try {
      await Promise.all(
        Array.from({ length: 1200 }, (_, index) => (async () => {
          try {
            switch (index % 3) {
              case 0:
                await getGuildSettings(index % 5 === 0 ? "guild-race" : "query-chaos-settings-" + (index % 20));
                break;
              case 1: {
                const ticket = queryChaosTickets[index % queryChaosTickets.length];
                await updateTicket(ticket.id, { current_category_id: "chaos-category-" + (index % 7) });
                break;
              }
              default: {
                const ticket = queryChaosTickets[index % queryChaosTickets.length];
                await getTicketById(ticket.guild_id, ticket.id);
                break;
              }
            }
            querySuccesses++;
          } catch {
            queryFailures++;
          }
        })()),
      );
    } finally {
      restoreQueryChaos();
    }

    assert.ok(querySuccesses > 0, "query chaos produced no successful PostgreSQL operations");
    assert.ok(queryFailures > 0, "query chaos produced no injected PostgreSQL failures");

    const queryRows = (await pool.query(
      "SELECT id,status,ticket_key FROM tickets WHERE guild_id=$1 ORDER BY id",
      ["query-chaos-guild"],
    )).rows;
    assert.equal(queryRows.length, 20);
    for (const row of queryRows) {
      assert.equal(row.status, "open");
      assert.match(row.ticket_key, /^EVX-\d{6}$/);
    }

    // Kill real PostgreSQL sessions in active transactions; PostgreSQL must roll them back automatically.
    const killedChannels = Array.from({ length: 12 }, (_, index) => "killed-channel-" + index);
    await Promise.all(killedChannels.map(async (channelId) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "INSERT INTO tickets (guild_id,ticket_key,channel_id,owner_id,type_label,status,category_id,current_category_id,closed_category_id,staff_roles,ping_roles) " +
          "VALUES ('killed-guild',$1,$2,$3,'Killed','open','category','category','closed','[]'::jsonb,'[]'::jsonb)",
          ["TMP-" + channelId, channelId, "killed-owner-" + channelId],
        );
        const { rows } = await client.query("SELECT pg_backend_pid() AS pid");
        const sleep = client.query("SELECT pg_sleep(10)");
        await poolKiller.query("SELECT pg_terminate_backend($1)", [rows[0].pid]);
        await assert.rejects(() => sleep);
      } finally {
        client.release();
      }
    }));

    assert.equal(
      (await pool.query("SELECT COUNT(*)::int AS count FROM tickets WHERE guild_id='killed-guild'")).rows[0].count,
      0,
      "terminated transactions left committed ticket rows",
    );

    // Pool must recover after real backend termination.
    for (let index = 0; index < 20; index++) {
      assert.equal((await pool.query("SELECT $1::int AS value", [index])).rows[0].value, index);
    }

    // Final database-wide ticket invariants for all chaos-created rows.
    const invalid = (await pool.query(
      "SELECT COUNT(*)::int AS count FROM tickets " +
      "WHERE status NOT IN ('open','locked','waiting','closed','deleted') " +
      "OR ticket_key !~ '^EVX-[0-9]{6}$' " +
      "OR guild_id IS NULL OR owner_id IS NULL OR channel_id IS NULL",
    )).rows[0].count;
    assert.equal(invalid, 0);
  } finally {
    await removeSettingsDelayTrigger(pool).catch(() => null);
    await removeRollbackTrigger(pool).catch(() => null);
    await removeTicketLatencyTrigger(pool).catch(() => null);
    await resetSchema().catch(() => null);
    await closeDatabase().catch(() => null);
    await poolKiller.end().catch(() => null);
  }
});
