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
const RUNS = Number(process.env.EVIX_CHAOS_RUNS ?? 600);

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

function sqlText(textOrConfig) {
  return typeof textOrConfig === "string" ? textOrConfig : textOrConfig?.text ?? "";
}

async function resetSchema() {
  await getPool().query("TRUNCATE ticket_events, ticket_members, tickets, ticket_panel_options, ticket_panels, guild_ticket_settings RESTART IDENTITY CASCADE");
}

function installChaos({ seed, delayProbability = 0.15, failProbability = 0.02, killProbability = 0.025, maxDelayMs = 18, killer }) {
  const pool = getPool();
  const random = rng(seed);
  const originalQuery = pool.query.bind(pool);
  const originalConnect = pool.connect.bind(pool);

  let barrier = null;

  function armSettingsReadBarrier(target = 2) {
    let waiting = 0;
    let release;
    const promise = new Promise((resolve) => { release = resolve; });
    barrier = {
      target,
      done: false,
      arrive() {
        waiting++;
        if (waiting >= target) {
          this.done = true;
          release();
        }
        return promise;
      },
    };
  }

  pool.query = async function chaosPoolQuery(textOrConfig, params) {
    const sql = sqlText(textOrConfig);
    if (barrier && /^SELECT \* FROM guild_ticket_settings/i.test(sql)) {
      const active = barrier;
      barrier = null;
      await active.arrive();
    }
    if (delayProbability && random() < delayProbability) {
      await new Promise((resolve) => setTimeout(resolve, Math.floor(random() * maxDelayMs) + 1));
    }
    if (failProbability && random() < failProbability) {
      throw makeNetworkError(random() < 0.5 ? "ECONNRESET" : "ETIMEDOUT");
    }
    return originalQuery(textOrConfig, params);
  };

  pool.connect = async function chaosPoolConnect(...args) {
    const client = await originalConnect(...args);
    const originalClientQuery = client.query.bind(client);
    let killed = false;

    client.query = async function chaosClientQuery(textOrConfig, params) {
      const sql = sqlText(textOrConfig);
      const controlQuery = /^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql.trim());

      if (delayProbability && random() < delayProbability) {
        await new Promise((resolve) => setTimeout(resolve, Math.floor(random() * maxDelayMs) + 1));
      }

      if (!controlQuery && !killed && killProbability && random() < killProbability) {
        const { rows } = await originalClientQuery("SELECT pg_backend_pid()");
        const pid = rows[0]?.pg_backend_pid;
        if (pid) await killer.query("SELECT pg_terminate_backend($1)", [pid]);
        killed = true;
      }

      if (!controlQuery && failProbability && random() < failProbability) {
        throw makeNetworkError(random() < 0.5 ? "ECONNRESET" : "ETIMEDOUT");
      }

      return originalClientQuery(textOrConfig, params);
    };

    return client;
  };

  return {
    armSettingsReadBarrier,
    restore() {
      pool.query = originalQuery;
      pool.connect = originalConnect;
    },
  };
}

test("isolated PostgreSQL chaos audit: transactions, concurrency, failure recovery, and invariants", {
  timeout: 180_000,
  skip: !DATABASE_URL,
}, async () => {
  if (!DATABASE_URL) {
    throw new Error("CHAOS_DATABASE_URL is required; this audit must never fall back to a non-isolated database.");
  }

  const killer = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
  await initDatabase(DATABASE_URL);
  await resetSchema();

  try {
    const pool = getPool();
    const seed = 0xE51A505;

    // Baseline connectivity before fault injection.
    assert.equal((await pool.query("SELECT 1 AS ok")).rows[0].ok, 1);

    // Deterministic reproduction of the read-modify-write race in guild settings.
    await upsertGuildSettings("guild-race", {
      ticket_category_id: "base-ticket",
      waiting_category_id: "base-waiting",
      backup_category_id: "base-backup",
      default_ticket_limit: 3,
    });

    const race = installChaos({ seed, killer });
    try {
      race.armSettingsReadBarrier(2);
      await Promise.all([
        upsertGuildSettings("guild-race", { ticket_category_id: "ticket-A" }),
        upsertGuildSettings("guild-race", { waiting_category_id: "waiting-B" }),
      ]);
    } finally {
      race.restore();
    }

    const raced = await getGuildSettings("guild-race");
    assert.equal(raced.ticket_category_id, "ticket-A", "concurrent settings update lost ticket_category_id");
    assert.equal(raced.waiting_category_id, "waiting-B", "concurrent settings update lost waiting_category_id");
    assert.equal(raced.backup_category_id, "base-backup", "unrelated settings were overwritten");
    assert.equal(raced.default_ticket_limit, 3, "unrelated numeric setting was overwritten");

    // Rollback test: force the option insert in createPanel to fail; the panel must not survive.
    const rollbackChaos = installChaos({
      seed: seed ^ 0x11111111,
      failProbability: 0,
      killProbability: 0,
      delayProbability: 0,
      killer,
    });
    const rollbackOriginalConnect = pool.connect;
    pool.connect = async (...args) => {
      const client = await rollbackOriginalConnect(...args);
      const originalClientQuery = client.query.bind(client);
      client.query = async (textOrConfig, params) => {
        const sql = sqlText(textOrConfig);
        if (/^INSERT INTO ticket_panel_options/i.test(sql)) {
          throw makeNetworkError("ECONNRESET");
        }
        return originalClientQuery(textOrConfig, params);
      };
      return client;
    };
    try {
      await assert.rejects(
        () => createPanel({ guildId: "rollback-guild", name: "rollback-me" }),
        /simulated PostgreSQL transport failure/,
      );
    } finally {
      pool.connect = rollbackOriginalConnect;
      rollbackChaos.restore();
    }
    assert.equal(
      (await pool.query("SELECT COUNT(*)::int AS count FROM ticket_panels WHERE guild_id=$1", ["rollback-guild"])).rows[0].count,
      0,
      "failed transaction left a partially created panel",
    );

    // Large concurrent ticket creation storm with real PostgreSQL advisory locking.
    const owners = 30;
    const attempts = RUNS;
    const outcomes = [];
    const chaos = installChaos({
      seed: seed ^ 0x22222222,
      delayProbability: 0.22,
      failProbability: 0.025,
      killProbability: 0.03,
      maxDelayMs: 16,
      killer,
    });

    try {
      const jobs = Array.from({ length: attempts }, (_, index) => (async () => {
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
          outcomes.push({ ok: false, error: error?.code || error?.message || "unknown", owner, channel });
        }
      })());
      await Promise.all(jobs);
    } finally {
      chaos.restore();
    }

    const ticketRows = (await pool.query(
      "SELECT id,guild_id,owner_id,channel_id,ticket_key,status,claimed_by,claimed_at,closed_by,closed_at,waiting_at,deleted_at " +
      "FROM tickets WHERE guild_id=$1 ORDER BY id",
      ["chaos-guild"],
    )).rows;

    assert.ok(ticketRows.length > 0, "chaos storm committed no tickets at all");
    assert.ok(ticketRows.length <= owners * 2, "ticket limit was violated under concurrent PostgreSQL transactions");
    assert.equal(new Set(ticketRows.map((row) => row.channel_id)).size, ticketRows.length, "duplicate channel_id rows exist");
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
    for (const row of ownerCounts) assert.ok(row.count <= 2, "active ticket limit exceeded for " + row.owner_id);

    const minOutcomeFailures = outcomes.filter((entry) => !entry.ok).length;
    assert.ok(minOutcomeFailures > 0, "chaos injection produced no rejected operations; the fault path was not exercised");

    // DB compare-and-set race: exactly one claim should win.
    const baseTicket = await createTicket({
      guildId: "cas-guild",
      panelId: null,
      optionId: null,
      channelId: "cas-channel",
      ownerId: "cas-owner",
      typeLabel: "CAS",
      categoryId: "category",
      closedCategoryId: "closed-category",
      staffRoles: [],
      pingRoles: [],
      dedupeKey: null,
      ticketLimit: 25,
    });

    const claimResults = await Promise.all(
      Array.from({ length: 100 }, async (_, index) => {
        try {
          const claimed = await updateTicket(
            baseTicket.id,
            { claimed_by: "staff-" + index, claimed_at: new Date() },
            { statuses: ["open"], claimedBy: null },
          );
          return Boolean(claimed);
        } catch {
          return false;
        }
      }),
    );
    assert.equal(claimResults.filter(Boolean).length, 1, "more than one concurrent claim succeeded");
    const claimedFinal = await getTicketById("cas-guild", baseTicket.id);
    assert.match(claimedFinal.claimed_by, /^staff-\d+$/);
    assert.equal(claimedFinal.status, "open");

    // Connection-kill recovery: after terminated real backend connections, the pool must still work.
    const recovery = installChaos({
      seed: seed ^ 0x33333333,
      delayProbability: 0.1,
      failProbability: 0.03,
      killProbability: 0.08,
      maxDelayMs: 10,
      killer,
    });
    try {
      await Promise.all(
        Array.from({ length: 80 }, async (_, index) => {
          try {
            await pool.query("SELECT $1::int AS value", [index]);
          } catch {}
        }),
      );
    } finally {
      recovery.restore();
    }

    assert.equal((await pool.query("SELECT 42 AS answer")).rows[0].answer, 42);
    assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM tickets WHERE guild_id=$1", ["chaos-guild"])).rows[0].count, ticketRows.length);
  } finally {
    await resetSchema().catch(() => null);
    await closeDatabase().catch(() => null);
    await killer.end().catch(() => null);
  }
});
