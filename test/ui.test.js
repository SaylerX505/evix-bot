
import test from "node:test";
import assert from "node:assert/strict";
import { MessageFlags } from "discord.js";
import { buildDeleteConfirmation, buildPanelMessage, buildTicketView } from "../src/ui.js";

function option(id, component_kind) {
  return {
    id,
    panel_id: 1,
    component_kind,
    label: `Option ${id}`,
    description: component_kind === "dropdown" ? "Ticket option" : null,
    emoji: null,
    action: "NOTHING",
    button_style: 2,
  };
}

test("panel messages use Components V2 and suppress implicit mentions", () => {
  const payload = buildPanelMessage({
    id: 1,
    component_mode: "both",
    options: [option(1, "button"), option(2, "dropdown")],
  });

  assert.equal(payload.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(payload.allowedMentions, { parse: [] });
  assert.ok(Array.isArray(payload.components));
});

test("panel layout enforces the five action-row limit", () => {
  const buttons = Array.from({ length: 15 }, (_, i) => option(i + 1, "button"));
  const dropdowns = Array.from({ length: 10 }, (_, i) => option(i + 16, "dropdown"));

  assert.doesNotThrow(() => buildPanelMessage({
    id: 1,
    component_mode: "both",
    options: [...buttons, ...dropdowns],
  }));

  assert.doesNotThrow(() => buildPanelMessage({
    id: 1,
    component_mode: "both",
    options: [
      ...Array.from({ length: 20 }, (_, i) => option(i + 1, "button")),
      ...Array.from({ length: 5 }, (_, i) => option(i + 21, "dropdown")),
    ],
  }));

  assert.throws(() => buildPanelMessage({
    id: 1,
    component_mode: "buttons",
    options: Array.from({ length: 21 }, (_, i) => option(i + 1, "button")),
  }), /at most 20 buttons/);
});

test("ticket and delete-confirmation views stay in Components V2", () => {
  const ticket = {
    id: 42,
    ticket_key: "EV-0042",
    type_label: "Support",
    owner_id: "123456",
    claimed_by: null,
    status: "open",
  };

  assert.equal(buildTicketView(ticket, { welcome_message: "Welcome" }).flags, MessageFlags.IsComponentsV2);
  assert.equal(buildDeleteConfirmation(ticket).flags, MessageFlags.IsComponentsV2);
});
