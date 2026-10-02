import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { addPanelOption, closeDatabase, initDatabase, updatePanel, updatePanelOption, updateTicket, upsertGuildSettings, withTicketActionLock } from "../src/db.js";

test("database update builders emit valid PostgreSQL placeholders", async () => {
  const queries = [];
  const originalQuery = pg.Pool.prototype.query;
  const originalEnd = pg.Pool.prototype.end;
  const originalConnect = pg.Pool.prototype.connect;

  pg.Pool.prototype.query = async function(text, params) {
    queries.push({ text, params });
    return { rows: text.startsWith("UPDATE") ? [{ id: 1 }] : [] };
  };
  pg.Pool.prototype.end = async function() {};

  try {
    await initDatabase("postgres://evix:test@localhost/evix");
    const migrationSql = queries[2].text;
    queries.length = 0;

    await updatePanel(1, { title: "New", accent_color: 123 });
    await updatePanelOption(2, { label: "Support", button_style: 3, action: "NOTHING" });
    await updateTicket(3, { status: "closed", claimed_by: null, claimed_at: null, closed_by: "staff" }, { statuses: ["open"], claimedBy: null });

    assert.ok(queries[0].text.includes("title = $2"));
    assert.ok(queries[0].text.includes("accent_color = $3"));
    assert.deepEqual(queries[0].params, [1, "New", 123]);

    assert.ok(queries[1].text.includes("label = $2"));
    assert.ok(queries[1].text.includes("button_style = $3"));
    assert.deepEqual(queries[1].params, [2, "Support", 3, "NOTHING"]);

    assert.ok(queries[2].text.includes("status=$2"));
    assert.ok(queries[2].text.includes("claimed_by=$3"));
    assert.ok(queries[2].text.includes("status = ANY($6::text[])"));
    assert.ok(queries[2].text.includes("claimed_by IS NOT DISTINCT FROM $7"));
    assert.deepEqual(queries[2].params, [3, "closed", null, null, "staff", ["open"], null]);

    let optionCount = 0;
    let optionQueries = [];
    pg.Pool.prototype.connect = async function() {
      return {
        query: async (text, params) => {
          optionQueries.push({ text, params });
          if (text === "SELECT id FROM ticket_panels WHERE id=$1 FOR UPDATE") return { rows: [{ id: 1 }] };
          if (text.startsWith("SELECT COUNT(*)::int AS count FROM ticket_panel_options")) return { rows: [{ count: optionCount }] };
          if (text.startsWith("SELECT COALESCE(MAX(position), -1) + 1 AS next_position")) return { rows: [{ next_position: 4 }] };
          if (text.startsWith("INSERT INTO ticket_panel_options")) return { rows: [{ id: 7, position: 4, action: "NOTHING" }] };
          return { rows: [] };
        },
        release() {},
      };
    };

    const option = await addPanelOption({ panelId: 1, position: 0, label: "Services", action: "NOTHING", staffRoles: [], pingRoles: [], modalFields: [] });
    const optionInsert = optionQueries.find((entry) => entry.text.startsWith("INSERT INTO ticket_panel_options"));
    assert.ok(optionInsert);
    assert.equal(optionInsert.params[1], 4);
    assert.equal(optionInsert.params[5], "NOTHING");
    assert.equal(option.position, 4);
    assert.equal(optionInsert.text.includes("transcript_on_close"), false);
    assert.match(optionInsert.text, /\$19::jsonb\) RETURNING \*/);
    assert.equal(optionInsert.params.length, 19);

    const migration = migrationSql;
    assert.equal(migration.includes("transcript_on_close"), true);
    assert.ok(migration.indexOf("DROP INDEX IF EXISTS tickets_one_active_dedupe_idx") < migration.indexOf("UPDATE tickets\n    SET status = 'open'"));
    assert.ok(migration.indexOf("UPDATE tickets\n    SET status = 'open'") < migration.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS tickets_one_active_dedupe_idx"));
    assert.ok(migration.indexOf("UPDATE tickets\n    SET status = 'open'") < migration.indexOf("ALTER TABLE tickets ADD CONSTRAINT tickets_status_check"));

    optionCount = 25;
    await assert.rejects(
      () => addPanelOption({ panelId: 1, position: 99, label: "Blocked", action: "CREATE_TICKET", staffRoles: [], pingRoles: [], modalFields: [] }),
      (error) => error.code === "EVIX_PANEL_OPTION_LIMIT" && /25 ticket options/.test(error.message),
    );

    const optionCountQuery = optionQueries.filter((entry) => entry.text.startsWith("SELECT COUNT(*)::int AS count FROM ticket_panel_options"));
    assert.equal(optionCountQuery.length, 2);

    const settingsQueries = [];
    pg.Pool.prototype.connect = async function() {
      return {
        query: async (text, params) => {
          settingsQueries.push({ text, params });
          if (text.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [] };
          if (text.startsWith("SELECT * FROM guild_ticket_settings")) return { rows: [] };
          if (text.startsWith("INSERT INTO guild_ticket_settings")) return { rows: [{ guild_id: "1" }] };
          if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
          return { rows: [] };
        },
        release() {},
      };
    };

    await upsertGuildSettings("1", {
      ticket_category_id: "10",
      ticket_logs_enabled: false,
      moderation_logs_enabled: true,
      transcript_logs_enabled: false,
    });

    const settingsQuery = settingsQueries.find((entry) => entry.text.startsWith("INSERT INTO guild_ticket_settings"));
    assert.ok(settingsQueries.some((entry) => entry.text.startsWith("SELECT pg_advisory_xact_lock")));
    assert.ok(settingsQuery);
    assert.ok(settingsQuery.text.includes("ticket_logs_enabled"));
    assert.ok(settingsQuery.text.includes("$13"));
    assert.ok(settingsQuery.text.includes("$14"));
    assert.ok(settingsQuery.text.includes("$14"));
    assert.deepEqual(settingsQuery.params.slice(-4), [false, true, false, 1]);
  } finally {
    pg.Pool.prototype.query = originalQuery;
    pg.Pool.prototype.end = originalEnd;
    pg.Pool.prototype.connect = originalConnect;
    await closeDatabase();
  }
});


test("ticket action lock serializes a ticket without holding a database connection", async () => {
  const result = await withTicketActionLock(42, async () => "ok");
  assert.equal(result, "ok");
});

test("ticket action queue continues after a failed action", async () => {
  const order = [];
  const first = withTicketActionLock(43, async () => {
    order.push("first");
    throw new Error("expected failure");
  });
  const second = withTicketActionLock(43, async () => {
    order.push("second");
    return "recovered";
  });

  await assert.rejects(first, /expected failure/);
  assert.equal(await second, "recovered");
  assert.deepEqual(order, ["first", "second"]);
});

test("ticket action lock serializes concurrent actions in order", async () => {
  const order = [];
  let release;
  const first = withTicketActionLock(42, () => new Promise((resolve) => {
    order.push("first");
    release = resolve;
  }));
  const second = withTicketActionLock(42, async () => {
    order.push("second");
    return "second-result";
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["first"]);
  release("done");
  assert.equal(await first, "done");
  assert.equal(await second, "second-result");
  assert.deepEqual(order, ["first", "second"]);
});
