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


function delayedService(ticket) {
  const service = serviceFor(ticket);
  const originalGet = service.getTicket;
  service.getTicket = async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return originalGet(...args);
  };
  service.withTicketActionLock = async (_ticketId, callback) => callback();
  service.requestClose = async (interaction) => { await interaction.editReply({ ok: "close-confirmation" }); };
  service.requestDelete = async (interaction) => { await interaction.editReply({ ok: "delete-confirmation" }); };
  service.info = async (interaction) => { await interaction.editReply({ ok: "info" }); };
  service.claim = async (interaction) => { service.calls.push("claim"); await interaction.editReply({ ok: "claim" }); };
  service.unclaim = async (interaction) => { service.calls.push("unclaim"); await interaction.editReply({ ok: "unclaim" }); };
  service.waiting = async (interaction) => { service.calls.push("waiting"); await interaction.editReply({ ok: "waiting" }); };
  service.reopen = async (interaction) => { service.calls.push("reopen"); await interaction.editReply({ ok: "reopen" }); };
  service.sendTranscript = async (interaction) => { service.calls.push("transcript"); await interaction.editReply({ ok: "transcript" }); };
  return service;
}

function makeTicketButton(customId) {
  const interaction = makeButton(customId);
  interaction.memberPermissions = { has: () => false };
  interaction.deferReply = async ({ flags = 0 } = {}) => {
    interaction.deferred = true;
    interaction.flags = flags;
    interaction.calls.push("deferReply");
  };
  return interaction;
}

test("all ticket control buttons acknowledge before a slow ticket lookup", async () => {
  const actions = ["claim", "unclaim", "waiting", "close", "reopen", "transcript", "delete", "info"];
  for (const action of actions) {
    const interaction = makeTicketButton("evix:t:42:" + action);
    const service = delayedService({
      id: 42,
      owner_id: action === "close" || action === "info" ? "owner" : "different",
      status: action === "reopen" ? "closed" : "open",
      staff_roles: [],
      claimed_by: action === "unclaim" ? "staff" : null,
    });
    service.canManageTicket = () => true;
    await handleInteraction(interaction, { service, ui: {} });
    assert.equal(interaction.calls[0], "deferReply", action);
    assert.equal(interaction.calls.includes("deferReply"), true, action);
  }
});

test("confirmation buttons acknowledge before a slow ticket lookup", async () => {
  for (const action of ["close", "keep-open", "delete", "cancel"]) {
    const interaction = makeButton("evix:confirm:42:" + action);
    const service = delayedService({
      id: 42,
      owner_id: "owner",
      status: action === "delete" || action === "cancel" ? "closed" : "open",
      staff_roles: [],
    });
    service.canManageTicket = () => action === "delete" || action === "cancel";
    service.canClose = () => true;
    await handleInteraction(interaction, { service, ui: {} });
    assert.equal(interaction.calls[0], "deferUpdate", action);
  }
});
