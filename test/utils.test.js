import test from "node:test";
import assert from "node:assert/strict";
import {
  assertPanelOptions,
  buildTicketKey,
  parseEmoji,
  parseRoleMentions,
  parseUserId,
  renderTemplate,
  sanitizeChannelName,
  validateModalFields,
} from "../src/utils.js";

test("ticket keys use the Evix release format", () => {
  assert.equal(buildTicketKey(1), "EVX-000001");
  assert.equal(buildTicketKey(42), "EVX-000042");
  assert.equal(buildTicketKey(12345), "EVX-012345");
});

test("channel names are normalized safely", () => {
  assert.equal(sanitizeChannelName("  My Ticket / Purchase! "), "my-ticket-purchase");
  assert.equal(sanitizeChannelName("!!!"), "ticket");
});

test("role mentions are parsed uniquely and reject invalid input", () => {
  assert.deepEqual(parseRoleMentions("<@&123456> <@&123456> <@&987654>"), ["123456", "987654"]);
  assert.throws(() => parseRoleMentions("<@&123456> helpers"), /valid Discord role mentions/);
});

test("templates replace supported ticket variables", () => {
  assert.equal(
    renderTemplate("ticket-{number}-{username}-{type}", {
      number: "EVX-000007",
      username: "sayler",
      type: "Billing",
    }),
    "ticket-EVX-000007-sayler-Billing",
  );
});

test("panel options only require a stable id and name", () => {
  assert.doesNotThrow(() => assertPanelOptions([
    { id: 1, label: "Support" },
  ]));
  assert.throws(() => assertPanelOptions([
    { id: 1, label: "" },
  ]), /needs a name/);
});

test("emoji parser supports unicode and custom Discord emojis", () => {
  assert.deepEqual(parseEmoji("🎟️"), { name: "🎟️" });
  assert.deepEqual(parseEmoji("<a:ticket:123456789>"), {
    id: "123456789",
    name: "ticket",
    animated: true,
  });
});

test("user IDs accept mentions or raw IDs", () => {
  assert.equal(parseUserId("<@!123456789>"), "123456789");
  assert.equal(parseUserId("123456789"), "123456789");
  assert.throws(() => parseUserId("not-a-user"), /valid user ID/);
});

test("modal fields are strict and reject duplicates", () => {
  assert.deepEqual(validateModalFields([
    { id: "reason", label: "Reason", style: "paragraph" },
    { id: "order", label: "Order ID", required: false },
  ]), [
    { id: "reason", label: "Reason", placeholder: "", required: true, style: "paragraph" },
    { id: "order", label: "Order ID", placeholder: "", required: false, style: "short" },
  ]);

  assert.throws(() => validateModalFields([{ label: "Missing id" }]), /requires an id and label/);
  assert.throws(() => validateModalFields([
    { id: "x", label: "A" },
    { id: "x", label: "B" },
  ]), /Duplicate form field id/);
});
