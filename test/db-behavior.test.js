import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { closeDatabase, getGuildSettings, initDatabase, listTicketEvents, upsertGuildSettings } from "../src/db.js";

test("guild settings patch is a single atomic database write", async () => {
  const calls = [];
  const originalQuery = pg.Pool.prototype.query;
  const originalEnd = pg.Pool.prototype.end;
  const originalConnect = pg.Pool.prototype.connect;

  pg.Pool.prototype.query = async function(text, params) {
    calls.push({ text, params });
    if (text.startsWith("INSERT INTO guild_ticket_settings")) {
      return {
        rows: [{
          guild_id: "guild",
          ticket_category_id: "category",
          backup_category_id: null,
          closed_category_id: null,
          ticket_log_channel_id: "logs",
          moderation_log_channel_id: null,
          transcript_log_channel_id: null,
          ticket_logs_enabled: true,
          moderation_logs_enabled: true,
          transcript_logs_enabled: true,
          default_ticket_limit: 1,
        }],
      };
    }
    return { rows: [] };
  };

  pg.Pool.prototype.end = async function() {};
  pg.Pool.prototype.connect = async function() {
    return {
      query: async () => ({ rows: [] }),
      release() {},
    };
  };


  try {
    await initDatabase("postgres://evix:test@localhost/evix");
    calls.length = 0;

    const saved = await upsertGuildSettings("guild", {
      ticket_category_id: "category",
      ticket_logs_enabled: true,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].text.startsWith("INSERT INTO guild_ticket_settings"), true);
    assert.equal(calls[0].text.includes("SELECT pg_advisory_xact_lock"), false);
    assert.equal(calls[0].text.includes("ON CONFLICT (guild_id)"), true);
    assert.equal(saved.guild_id, "guild");
  } finally {
    pg.Pool.prototype.query = originalQuery;
    pg.Pool.prototype.end = originalEnd;
    pg.Pool.prototype.connect = originalConnect;
    await closeDatabase();
  }
});

test("settings writes invalidate the cached row instead of caching a potentially stale write response", async () => {
  const calls = [];
  const originalQuery = pg.Pool.prototype.query;
  const originalEnd = pg.Pool.prototype.end;
  const originalConnect = pg.Pool.prototype.connect;

  pg.Pool.prototype.query = async function(text, params) {
    calls.push({ text, params });
    if (text === "SELECT * FROM guild_ticket_settings WHERE guild_id=$1") {
      return {
        rows: [{
          guild_id: "guild",
          ticket_category_id: "fresh-from-db",
        }],
      };
    }
    if (text.startsWith("INSERT INTO guild_ticket_settings")) {
      return {
        rows: [{
          guild_id: "guild",
          ticket_category_id: "write-response",
        }],
      };
    }
    return { rows: [] };
  };
  pg.Pool.prototype.end = async function() {};
  pg.Pool.prototype.connect = async function() {
    return {
      query: async () => ({ rows: [] }),
      release() {},
    };
  };

  try {
    await initDatabase("postgres://evix:test@localhost/evix");
    calls.length = 0;

    await getGuildSettings("guild");
    await upsertGuildSettings("guild", { ticket_logs_enabled: true });
    const afterWrite = await getGuildSettings("guild");

    const settingsReads = calls.filter(({ text }) => text === "SELECT * FROM guild_ticket_settings WHERE guild_id=$1");
    assert.equal(settingsReads.length, 2);
    assert.equal(afterWrite.ticket_category_id, "fresh-from-db");
  } finally {
    pg.Pool.prototype.query = originalQuery;
    pg.Pool.prototype.end = originalEnd;
    pg.Pool.prototype.connect = originalConnect;
    await closeDatabase();
  }
});

test("ticket event listing uses a deterministic tie-breaker", async () => {
  const calls = [];
  const originalQuery = pg.Pool.prototype.query;
  const originalEnd = pg.Pool.prototype.end;

  pg.Pool.prototype.query = async function(text, params) {
    calls.push({ text, params });
    return { rows: [{ id: 2 }, { id: 3 }] };
  };
  pg.Pool.prototype.end = async function() {};
  pg.Pool.prototype.connect = async function() {
    return {
      query: async () => ({ rows: [] }),
      release() {},
    };
  };

  try {
    await initDatabase("postgres://evix:test@localhost/evix");
    calls.length = 0;

    const rows = await listTicketEvents(42);

    assert.deepEqual(rows, [{ id: 2 }, { id: 3 }]);
    assert.match(calls[0].text, /ORDER BY created_at ASC, id ASC/);
  } finally {
    pg.Pool.prototype.query = originalQuery;
    pg.Pool.prototype.end = originalEnd;
    pg.Pool.prototype.connect = originalConnect;
    await closeDatabase();
  }
});
