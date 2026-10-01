import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { addPanelOption, closeDatabase, initDatabase, updatePanel, updatePanelOption, updateTicket, upsertGuildSettings } from "../src/db.js";

test("database update builders emit valid PostgreSQL placeholders", async () => {
  const queries = [];
  const originalQuery = pg.Pool.prototype.query;
  const originalEnd = pg.Pool.prototype.end;

  pg.Pool.prototype.query = async function(text, params) {
    queries.push({ text, params });
    return { rows: text.startsWith("UPDATE") ? [{ id: 1 }] : [] };
  };
  pg.Pool.prototype.end = async function() {};

  try {
    await initDatabase("postgres://evix:test@localhost/evix");
    queries.length = 0;

    await updatePanel(1, { title: "New", accent_color: 123 });
    await updatePanelOption(2, { label: "Support", button_style: 3, action: "NOTHING" });
    await updateTicket(3, { status: "closed", claimed_by: null, claimed_at: null, closed_by: "staff" }, { statuses: ["open", "locked"], claimedBy: null });

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
    assert.deepEqual(queries[2].params, [3, "closed", null, null, "staff", ["open", "locked"], null]);

    await addPanelOption({ panelId: 1, position: 0, label: "Services", action: "NOTHING", staffRoles: [], pingRoles: [], modalFields: [] });
    const optionInsert = queries.find((entry) => entry.text.startsWith("INSERT INTO ticket_panel_options"));
    assert.ok(optionInsert);
    assert.equal(optionInsert.params[5], "NOTHING");

    queries.length = 0;
    pg.Pool.prototype.query = async function(text, params) {
      queries.push({ text, params });
      if (text.startsWith("SELECT * FROM guild_ticket_settings")) return { rows: [] };
      if (text.startsWith("INSERT INTO guild_ticket_settings")) return { rows: [{ guild_id: "1" }] };
      return { rows: [] };
    };

    await upsertGuildSettings("1", {
      ticket_category_id: "10",
      ticket_logs_enabled: false,
      moderation_logs_enabled: true,
      transcript_logs_enabled: false,
    });

    const settingsQuery = queries.find((entry) => entry.text.startsWith("INSERT INTO guild_ticket_settings"));
    assert.ok(settingsQuery);
    assert.ok(settingsQuery.text.includes("ticket_logs_enabled"));
    assert.ok(settingsQuery.text.includes("$13"));
    assert.ok(settingsQuery.text.includes("$14"));
    assert.ok(settingsQuery.text.includes("$15"));
    assert.deepEqual(settingsQuery.params.slice(-4), [false, true, false, 1]);
  } finally {
    pg.Pool.prototype.query = originalQuery;
    pg.Pool.prototype.end = originalEnd;
    await closeDatabase();
  }
});