import test from "node:test";
import assert from "node:assert/strict";
import { MessageFlags } from "discord.js";
import { buildDeleteConfirmation, buildPanelMessage, buildTicketView } from "../src/ui.js";

function option(id, extra = {}) {
  return {
    id,
    panel_id: 1,
    label: "Option " + id,
    description: extra.description ?? null,
    emoji: extra.emoji ?? null,
    action: "CREATE_TICKET",
  };
}

function containerJson(payload) {
  return payload.components[0].toJSON();
}

test("ticket panels are dropdown-only Components V2 containers", () => {
  const payload = buildPanelMessage({
    id: 1,
    options: [option(1, { description: "Get support", emoji: "🎟️" })],
  });

  assert.equal(payload.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(payload.allowedMentions, { parse: [] });

  const container = containerJson(payload);
  assert.equal(container.type, 17);
  const rows = container.components.filter((component) => component.type === 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].components[0].type, 3);
  assert.equal(rows[0].components[0].options.length, 1);
});

test("panel content is optional and the dropdown remains valid", () => {
  assert.doesNotThrow(() => buildPanelMessage({
    id: 1,
    title: "",
    description: "",
    image_url: null,
    footer: "",
    footer_show_bot: false,
    options: [option(1)],
  }));
});

test("panel can render optional image and bot footer", () => {
  const payload = buildPanelMessage({
    id: 1,
    title: "",
    description: "Choose a ticket type.",
    image_url: "https://example.com/panel.png",
    footer: "Support Center",
    footer_show_bot: true,
    options: [option(1)],
  }, {
    username: "Evix",
    displayAvatarURL: () => "https://example.com/avatar.png",
  });

  const components = containerJson(payload).components;
  assert.ok(components.some((component) => component.type === 12));
  assert.ok(components.some((component) => component.type === 10));
  assert.ok(components.some((component) => component.type === 9));
});

test("ticket, waiting, and delete views stay in Components V2", () => {
  const ticket = {
    id: 42,
    ticket_key: "EVX-000042",
    type_label: "Support",
    owner_id: "123456",
    claimed_by: null,
    status: "waiting",
  };

  assert.equal(buildTicketView(ticket, { welcome_message: "Welcome" }).flags, MessageFlags.IsComponentsV2);
  assert.equal(buildDeleteConfirmation(ticket).flags, MessageFlags.IsComponentsV2);
});
