import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { addPanelOption, closeDatabase, createPanel, initDatabase, updatePanel, updatePanelOption, updateTicket, withTicketActionLock } from "../src/db.js";

test("database update builders emit valid PostgreSQL placeholders", async () => {
  const queries = [];
  const originalQuery = pg.Pool.prototype.query;
  const originalEnd = pg.Pool.prototype.end;

  pg.Pool.prototype.query = async function(text, params) {
    queries.push({ text, params });
    if (text.startsWith("UPDATE")) return { rows: [{ id: 1 }] };
    return { rows: [] };
  };
  pg.Pool.prototype.end = async function() {};

  try {
    await initDatabase("postgres://evix:test@localhost/evix");
    queries.length = 0;

    await updatePanel(1, { title: "New", accent_color: 123 });
    await updatePanelOption(2, { label: "Support", button_style: 3, action: "NOTHING" });
    await updateTicket(
      3,
      { status: "closed", claimed_by: null, claimed_at: null, closed_by: "staff" },
      { statuses: ["open"], claimedBy: null },
    );

    assert.ok(queries[0].text.includes("title=$2"));
    assert.ok(queries[0].text.includes("accent_color=$3"));
    assert.deepEqual(queries[0].params, [1, "New", 123]);

    assert.ok(queries[1].text.includes("label=$2"));
    assert.ok(queries[1].text.includes("button_style=$3"));
    assert.deepEqual(queries[1].params, [2, "Support", 3, "NOTHING"]);

    assert.ok(queries[2].text.includes("status=$2"));
    assert.ok(queries[2].text.includes("claimed_by=$3"));
    assert.ok(queries[2].text.includes("status = ANY($6::text[])"));
    assert.ok(queries[2].text.includes("claimed_by IS NOT DISTINCT FROM $7"));
    assert.deepEqual(queries[2].params, [3, "closed", null, null, "staff", ["open"], null]);

    assert.doesNotMatch(JSON.stringify(queries), /open_category_id|log_channel_id|transcript_channel_id/);
  } finally {
    pg.Pool.prototype.query = originalQuery;
    pg.Pool.prototype.end = originalEnd;
    await closeDatabase();
  }
});

test("createPanel inserts its default option with matching SQL columns and values", async () => {
  const originalQuery = pg.Pool.prototype.query;
  const originalConnect = pg.Pool.prototype.connect;
  const calls = [];
  pg.Pool.prototype.query = async function(text, params) {
    calls.push({ text, params });
    return { rows: [] };
  };
  pg.Pool.prototype.connect = async function() {
    return {
      query: async (text, params) => {
        calls.push({ text, params });
        if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
        if (text.startsWith("INSERT INTO ticket_panels")) return { rows: [{ id: 9, name: "Support" }] };
        if (text.startsWith("INSERT INTO ticket_panel_options")) {
          return { rows: [{ id: 10, panel_id: 9, label: "Open Ticket", action: "CREATE_TICKET" }] };
        }
        throw new Error("Unexpected createPanel query: " + text);
      },
      release() {},
    };
  };

  try {
    await initDatabase("postgres://evix:test@localhost/evix");
    calls.length = 0;

    const panel = await createPanel({ guildId: "guild", name: "Support", withDefaultOption: true });
    const optionInsert = calls.find((entry) => entry.text.startsWith("INSERT INTO ticket_panel_options"));
    assert.ok(optionInsert);
    assert.match(optionInsert.text, /'move',FALSE,2,'\[\]'::jsonb\) RETURNING \*$/);
    assert.equal(optionInsert.params.length, 1);
    assert.equal(optionInsert.params[0], 9);
    assert.deepEqual(panel.options, [{ id: 10, panel_id: 9, label: "Open Ticket", action: "CREATE_TICKET" }]);
  } finally {
    pg.Pool.prototype.query = originalQuery;
    pg.Pool.prototype.connect = originalConnect;
    await closeDatabase();
  }
});


test("panel option storage rejects blank names before opening a transaction", async () => {
  await assert.rejects(
    () => addPanelOption({ panelId: 1, label: "   ", action: "CREATE_TICKET", staffRoles: [], pingRoles: [], modalFields: [] }),
    /cannot be empty/,
  );
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
