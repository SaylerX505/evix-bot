import test from "node:test";
import assert from "node:assert/strict";
import { MessageFlags } from "discord.js";
import { handleInteraction } from "../src/handler.js";

function makeButton(customId) {
  const calls = [];
  const interaction = {
    customId,
    commandName: null,
    guildId: "guild",
    channelId: "channel",
    user: { id: "owner" },
    member: { id: "owner" },
    memberPermissions: { has: () => false },
    deferred: false,
    replied: false,
    isAutocomplete: () => false,
    isChatInputCommand: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    isButton: () => true,
    deferUpdate: async () => { interaction.deferred = true; calls.push("deferUpdate"); },
    deleteReply: async () => { calls.push("deleteReply"); },
    followUp: async () => { calls.push("followUp"); },
    reply: async () => { interaction.replied = true; calls.push("reply"); },
    editReply: async () => { calls.push("editReply"); },
    guild: {},
  };
  interaction.calls = calls;
  return interaction;
}

function serviceFor(ticket) {
  const calls = [];
  return {
    calls,
    getTicket: async () => ticket,
    canManageTicket: () => false,
    canClose: (member, current) => member.id === current.owner_id,
    close: async () => { calls.push("close"); },
    delete: async () => { calls.push("delete"); },
  };
}

test("keep-open removes only the close confirmation", async () => {
  const interaction = makeButton("evix:confirm:42:keep-open");
  const service = serviceFor({ id: 42, owner_id: "owner", status: "open", staff_roles: [] });
  await handleInteraction(interaction, { service, ui: {} });
  assert.deepEqual(interaction.calls, ["deferUpdate", "deleteReply"]);
  assert.deepEqual(service.calls, []);
});

test("confirm close removes the confirmation and executes close", async () => {
  const interaction = makeButton("evix:confirm:42:close");
  const service = serviceFor({ id: 42, owner_id: "owner", status: "open", staff_roles: [] });
  await handleInteraction(interaction, { service, ui: {} });
  assert.deepEqual(interaction.calls, ["deferUpdate", "deleteReply"]);
  assert.deepEqual(service.calls, ["close"]);
});

test("confirm close surfaces a failure after removing the confirmation", async () => {
  const interaction = makeButton("evix:confirm:42:close");
  const service = serviceFor({ id: 42, owner_id: "owner", status: "open", staff_roles: [] });
  service.close = async () => { throw new Error("Close failed"); };
  await handleInteraction(interaction, { service, ui: {} });
  assert.deepEqual(interaction.calls, ["deferUpdate", "deleteReply", "followUp"]);
});
