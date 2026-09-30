import test from "node:test";
import assert from "node:assert/strict";
import {
  assertPanelOptions,
  buildTicketKey,
  parseRoleMentions,
  parseUserId,
  renderTemplate,
  sanitizeChannelName,
  validateModalFields,
} from "../src/utils.js";

test("ticket keys are stable and padded", () => {
  assert.equal(buildTicketKey(1), "EV-0001");
  assert.equal(buildTicketKey(42), "EV-0042");
  assert.equal(buildTicketKey(12345), "EV-12345");
});

test("channel names are normalized safely", () => {
  assert.equal(sanitizeChannelName("  My Ticket / Purchase! "), "my-ticket-purchase");
  assert.equal(sanitizeChannelName("!!!"), "ticket");
});

test("role mentions are parsed without duplicates", () => {
  assert.deepEqual(parseRoleMentions("<@&123> <@&123> <@&456>"), ["123", "123", "456"]);
});

test("templates replace supported ticket variables", () => {
  assert.equal(
    renderTemplate("ticket-{number}-{username}-{type}", {
      number: "EV-0007",
      username: "sayler",
      type: "Billing",
    }),
    "ticket-EV-0007-sayler-Billing",
  );
});

test("panel options reject invalid create-ticket records", () => {
  assert.throws(
    () => assertPanelOptions([{ id: 1, action: "CREATE_TICKET" }]),
    /requires a category/,
  );
});

test("user IDs accept mentions or raw IDs", () => {
  assert.equal(parseUserId("<@!123456789>"), "123456789");
  assert.equal(parseUserId("123456789"), "123456789");
  assert.throws(() => parseUserId("not-a-user"), /valid user ID/);
});

test("modal fields are normalized and reject duplicates", () => {
  assert.deepEqual(validateModalFields([
    { id: "reason", label: "Reason", style: "paragraph" },
    { id: "order", label: "Order ID", required: false },
  ]), [
    { id: "reason", label: "Reason", placeholder: "", required: true, style: "paragraph" },
    { id: "order", label: "Order ID", placeholder: "", required: false, style: "short" },
  ]);

  assert.throws(() => validateModalFields([
    { id: "x", label: "A" },
    { id: "x", label: "B" },
  ]), /Duplicate form field id/);
});
