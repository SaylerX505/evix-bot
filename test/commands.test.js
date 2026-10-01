import test from "node:test";
import assert from "node:assert/strict";
import { ComponentType } from "discord.js";
import { commands, buildRenameModal, buildTicketModal } from "../src/commands.js";

function firstComponent(modal) { return modal.toJSON().components[0]; }

test("rename management modal uses current modal Label components", () => {
  assert.equal(firstComponent(buildRenameModal("42")).type, ComponentType.Label);
});

test("ticket modal validates and wraps text inputs in labels", () => {
  const modal = buildTicketModal({ id: 7, label: "Support", modal_fields: [{ id: "reason", label: "Reason", style: "paragraph", required: true }] });
  assert.ok(modal);
  assert.equal(firstComponent(modal).type, ComponentType.Label);
});

test("ticket and panel commands are registered separately", () => {
  const ticket = commands.find((command) => command.name === "ticket").toJSON();
  const panel = commands.find((command) => command.name === "panel").toJSON();
  assert.ok(ticket);
  assert.ok(panel);
  assert.equal(ticket.options.some((option) => option.name === "waiting"), true);
  assert.equal(ticket.options.some((option) => option.name === "lock" || option.name === "unlock"), false);
  assert.equal(panel.options.some((option) => option.name === "option-add"), true);
});

test("ticket add command supports either user or role", () => {
  const ticket = commands.find((command) => command.name === "ticket").toJSON();
  const add = ticket.options.find((option) => option.name === "add");
  assert.equal(add.options.find((option) => option.name === "user").required, false);
  assert.equal(add.options.find((option) => option.name === "role").required, false);
});

test("panel selectors use Discord autocomplete instead of numeric IDs", () => {
  const panel = commands.find((command) => command.name === "panel").toJSON();
  for (const name of ["edit", "send", "reset", "delete", "option-add", "option-edit", "option-remove"]) {
    const sub = panel.options.find((option) => option.name === name);
    assert.equal(sub.options.find((option) => option.name === "panel").autocomplete, true);
  }
  for (const name of ["option-edit", "option-remove"]) {
    const sub = panel.options.find((option) => option.name === name);
    assert.equal(sub.options.find((option) => option.name === "option").autocomplete, true);
  }
});

test("panel options support CREATE_TICKET and NOTHING actions", () => {
  const panel = commands.find((command) => command.name === "panel").toJSON();
  const add = panel.options.find((option) => option.name === "option-add");
  const action = add.options.find((option) => option.name === "action");
  assert.equal(action.required, true);
  assert.deepEqual(action.choices.map((choice) => choice.value), ["CREATE_TICKET", "NOTHING"]);
});

test("panel option management requires a name only when creating an option", () => {
  const panel = commands.find((command) => command.name === "panel").toJSON();
  const add = panel.options.find((option) => option.name === "option-add");
  const edit = panel.options.find((option) => option.name === "option-edit");
  assert.equal(add.options.find((option) => option.name === "name").required, true);
  assert.equal(edit.options.find((option) => option.name === "name").required, false);
});


test("panel option add uses native role selectors and removes unused fields", () => {
  const panel = commands.find((command) => command.name === "panel").toJSON();
  const add = panel.options.find((option) => option.name === "option-add");
  const staff = add.options.find((option) => option.name === "staff_roles");
  const ping = add.options.find((option) => option.name === "ping_roles");
  assert.equal(staff.type, 8);
  assert.equal(ping.type, 8);
  assert.equal(add.options.some((option) => ["form", "name_template", "welcome"].includes(option.name)), false);
});

test("panel option edit uses role selectors and removes unused fields", () => {
  const panel = commands.find((command) => command.name === "panel").toJSON();
  const edit = panel.options.find((option) => option.name === "option-edit");
  assert.equal(edit.options.find((option) => option.name === "staff_roles").type, 8);
  assert.equal(edit.options.find((option) => option.name === "ping_roles").type, 8);
  assert.equal(edit.options.some((option) => ["form", "name_template", "welcome"].includes(option.name)), false);
});