import test from "node:test";
import assert from "node:assert/strict";
import { ComponentType } from "discord.js";
import { commands, buildAddUserModal, buildRenameModal, buildTicketModal } from "../src/commands.js";

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

test("release command structure has separate ticket and panel commands", () => {
  const ticket = commands.find((command) => command.name === "ticket").toJSON();
  const panel = commands.find((command) => command.name === "panel").toJSON();

  assert.ok(ticket);
  assert.ok(panel);
  assert.equal(panel.options.some((option) => option.name === "create"), true);
  assert.equal(ticket.options.some((option) => option.name === "waiting"), true);
  assert.equal(ticket.options.some((option) => option.name === "panel"), false);
  assert.equal(panel.options.some((option) => option.name === "option-add"), true);
});

test("panel option management requires a name only when creating an option", () => {
  const panel = commands.find((command) => command.name === "panel").toJSON();
  const add = panel.options.find((option) => option.name === "option-add");
  const edit = panel.options.find((option) => option.name === "option-edit");

  assert.equal(add.options.find((option) => option.name === "name").required, true);
  assert.equal(edit.options.find((option) => option.name === "name").required, false);
});
