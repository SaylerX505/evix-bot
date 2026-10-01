import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { closeDatabase, initDatabase, updatePanel, updatePanelOption, updateTicket } from "../src/db.js";

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
    await updatePanelOption(2, { label: "Support", button_style: 3 });
    await updateTicket(3, { status: "closed", claimed_by: null }, {
      statuses: ["open", "locked"],
      claimedBy: null,
    });

    assert.match(queries[0].text, /title = \$2/);
    assert.match(queries[0].text, /accent_color = \$3/);
    assert.deepEqual(queries[0].params, [1, "New", 123]);

    assert.match(queries[1].text, /label = \$2/);
    assert.match(queries[1].text, /button_style = \$3/);
    assert.deepEqual(queries[1].params, [2, "Support", 3]);

    assert.match(queries[2].text, /status=\$2/);
    assert.match(queries[2].text, /claimed_by=\$3/);
    assert.match(queries[2].text, /status = ANY\\(\$4::text\\[\\]\\)/);
    assert.match(queries[2].text, /claimed_by IS NOT DISTINCT FROM \$5/);
    assert.deepEqual(queries[2].params, [3, "closed", null, ["open", "locked"], null]);
  } finally {
    pg.Pool.prototype.query = originalQuery;
    pg.Pool.prototype.end = originalEnd;
    await closeDatabase();
  }
});