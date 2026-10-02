import test from "node:test";
import assert from "node:assert/strict";
import { MessageFlags } from "discord.js";
import { buildAdminEmbed, buildClaimResult, buildCloseConfirmation, buildClosedTicketView, buildErrorResult, buildInfoView, buildPanelMessage, buildTicketView } from "../src/ui.js";

function option(id, extra = {}) {
  return { id, panel_id: 1, label: "Option " + id, description: extra.description ?? null, emoji: extra.emoji ?? null, action: extra.action ?? "CREATE_TICKET" };
}
function containerJson(payload) { return payload.components[0].toJSON(); }

test("ticket panels are dropdown-only Components V2 containers", () => {
  const payload = buildPanelMessage({ id: 1, options: [option(1, { description: "Get support", emoji: "🎟️" })] });
  assert.equal(payload.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(payload.allowedMentions, { parse: [] });
  const container = containerJson(payload);
  assert.equal(container.type, 17);
  const rows = container.components.filter((component) => component.type === 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].components[0].type, 3);
  assert.equal(rows[0].components[0].options.length, 1);
});

test("panel dropdown keeps both CREATE_TICKET and NOTHING options", () => {
  const payload = buildPanelMessage({ id: 1, options: [option(1), option(2, { action: "NOTHING" })] });
  const select = containerJson(payload).components.find((component) => component.type === 1).components[0];
  assert.deepEqual(select.options.map((entry) => entry.value), ["1", "2"]);
});

test("panel admin feedback uses a normal embed", () => {
  const payload = buildAdminEmbed("Option Saved Successfully", "Saved successfully.");
  assert.equal(payload.embeds.length, 1);
  assert.equal(payload.components, undefined);
});

test("error feedback is a normal embed with a reference", () => {
  const payload = buildErrorResult({ message: "Something went wrong.", code: "EVIX_ERROR", reference: "EVX-TEST" });
  const embed = payload.embeds[0].toJSON();
  assert.equal(embed.title, "Evix Error");
  assert.match(embed.description, /EVX-TEST/);
});

test("panel content is optional and the dropdown remains valid", () => {
  assert.doesNotThrow(() => buildPanelMessage({ id: 1, title: "", description: "", image_url: null, options: [option(1)] }));
});

test("panel preview disables ticket creation", () => {
  const payload = buildPanelMessage({ id: 1, options: [option(1)] }, null, { preview: true });
  const select = containerJson(payload).components.find((component) => component.type === 1).components[0];
  assert.equal(select.disabled, true);
});

test("panel no longer renders a footer", () => {
  const payload = buildPanelMessage({ id: 1, footer: "Should not render", footer_show_bot: true, options: [option(1)] }, { username: "Evix", displayAvatarURL: () => "https://example.com/avatar.png" });
  const components = containerJson(payload).components;
  assert.equal(components.some((component) => component.type === 9), false);
  assert.equal(components.some((component) => JSON.stringify(component).includes("Should not render")), false);
});

test("ticket controls remove unclaim, rename, add-user, lock and unlock", () => {
  const payload = buildTicketView({ id: 42, ticket_key: "EVX-000042", type_label: "Support", owner_id: "123456", claimed_by: null, status: "open" }, { welcome_message: "Welcome" });
  const json = JSON.stringify(containerJson(payload));
  assert.equal(json.includes(":lock"), false);
  assert.equal(json.includes(":unlock"), false);
  assert.equal(json.includes(":unclaim"), false);
  assert.equal(json.includes(":add"), false);
  assert.equal(json.includes(":rename"), false);
  assert.equal(json.includes(":claim"), true);
  assert.equal(json.includes(":close"), true);
  assert.equal(json.includes(":info"), true);
});

test("claimed ticket renders a public claimed state with unclaim control", () => {
  const payload = buildTicketView({ id: 42, ticket_key: "EVX-000042", type_label: "Support", owner_id: "123456", claimed_by: "999999", claimed_at: "2026-10-01T00:00:00.000Z", status: "open" }, { welcome_message: "Welcome" });
  const json = JSON.stringify(containerJson(payload));
  assert.equal(json.includes("Ticket Claimed"), true);
  assert.equal(json.includes("999999"), true);
  assert.equal(json.includes("Unclaim Ticket"), true);
});

test("close confirmation is an ephemeral-ready Components V2 container", () => {
  const payload = buildCloseConfirmation({ id: 42, ticket_key: "EVX-000042" });
  assert.equal(payload.flags, MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral);
  const json = JSON.stringify(containerJson(payload));
  assert.equal(json.includes("Yes, Close Ticket"), true);
  assert.equal(json.includes("No, Keep Open"), true);
});

test("closed ticket view exposes transcript, reopen, and delete", () => {
  const payload = buildClosedTicketView({ id: 42, ticket_key: "EVX-000042", closed_by: "999999" });
  const json = JSON.stringify(containerJson(payload));
  assert.equal(json.includes("Get Transcript"), true);
  assert.equal(json.includes("Reopen"), true);
  assert.equal(json.includes("Delete Ticket"), true);
});

test("ticket info is a Components V2 container", () => {
  const payload = buildInfoView({ id: 42, ticket_key: "EVX-000042", type_label: "Support", owner_id: "123456", claimed_by: "999999", status: "open", current_category_id: "777777", created_at: "2026-10-01T00:00:00.000Z" }, ["888888"]);
  assert.equal(payload.flags, MessageFlags.IsComponentsV2);
  const json = JSON.stringify(containerJson(payload));
  assert.equal(json.includes("EVX-000042"), true);
});


test("open ticket controls expose only the valid active-ticket actions", () => {
  const payload = buildTicketView({
    id: 42, ticket_key: "EVX-000042", type_label: "Support", owner_id: "123456",
    claimed_by: null, status: "open",
  }, { welcome_message: "Welcome" });
  const json = JSON.stringify(containerJson(payload));
  assert.match(json, /evix:t:42:claim/);
  assert.match(json, /evix:t:42/);
  assert.match(json, /evix:t:42:close/);
  assert.match(json, /evix:t:42:info/);
  assert.doesNotMatch(json, /evix:t:42:(reopen|transcript|delete)/);
});

test("closed ticket replaces active controls with only transcript, reopen and delete", () => {
  const payload = buildClosedTicketView({
    id: 42, ticket_key: "EVX-000042", closed_by: "999999",
  });
  const json = JSON.stringify(containerJson(payload));
  assert.match(json, /evix:t:42:transcript/);
  assert.match(json, /evix:t:42:reopen/);
  assert.match(json, /evix:t:42:delete/);
  assert.doesNotMatch(json, /evix:t:42:(claim|unclaim|close|info)/);
});


test("ticket control matrix never exposes invalid actions across ticket states", () => {
  const states = ["open", "locked", "closed", "deleted"];
  const claimed = [null, "staff"];

  for (const status of states) {
    for (const claimedBy of claimed) {
      const ticket = {
        id: 9001,
        ticket_key: "EVX-009001",
        type_label: "Support",
        owner_id: "owner",
        claimed_by: claimedBy,
        status,
      };
      const payload = status === "closed"
        ? buildClosedTicketView(ticket)
        : buildTicketView(ticket, { welcome_message: "Welcome" });
      const json = JSON.stringify(containerJson(payload));

      if (status === "open" && !claimedBy) {
        assert.match(json, /:claim/);
        assert.doesNotMatch(json, /:unclaim/);
      } else if ((status === "open" || status === "locked") && claimedBy) {
        assert.match(json, /:unclaim/);
        assert.doesNotMatch(json, /:claim/);
      } else if (status === "open") {
        assert.match(json, /:claim/);
      } else if (status === "closed") {
        assert.match(json, /:transcript/);
        assert.match(json, /:reopen/);
        assert.match(json, /:delete/);
        assert.doesNotMatch(json, /:claim|:unclaim|:close|:info/);
      } else if (status === "deleted") {
        assert.doesNotMatch(json, /:claim|:unclaim|:close|:reopen|:transcript|:delete|:info/);
      }
    }
  }
});

