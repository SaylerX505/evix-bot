
import test from "node:test";
import assert from "node:assert/strict";
import { ComponentType } from "discord.js";
import { buildAddUserModal, buildRenameModal, buildTicketModal } from "../src/commands.js";

function firstComponent(modal) {
  return modal.toJSON().components[0];
}

test("management modals use current modal Label components", () => {
  assert.equal(firstComponent(buildAddUserModal("42")).type, ComponentType.Label);
  assert.equal(firstComponent(buildRenameModal("42")).type, ComponentType.Label);
});

test("ticket modal validates and wraps text inputs in labels", () => {
  const modal = buildTicketModal({
    id: 7,
    label: "Support",
    modal_fields: [{ id: "reason", label: "Reason", style: "paragraph", required: true }],
  });

  assert.ok(modal);
  assert.equal(firstComponent(modal).type, ComponentType.Label);
});
