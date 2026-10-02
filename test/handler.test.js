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
    withTicketActionLock: async (_ticketId, callback) => callback(),
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
  assert.deepEqual(interaction.calls, ["deferUpdate", "deleteReply", "followUp"]);
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

test("ticket control buttons acknowledge before slow work", async () => {
  const actions = ["claim", "unclaim", "close", "reopen", "transcript", "delete", "info"];
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
  }
});


test("delete control keeps its confirmation ephemeral and does not update the public ticket message", async () => {
  const interaction = makeTicketButton("evix:t:42:delete");
  const service = delayedService({
    id: 42,
    owner_id: "different",
    status: "closed",
    staff_roles: [],
  });
  service.canManageTicket = () => true;
  await handleInteraction(interaction, { service, ui: {} });
  assert.equal(interaction.flags & MessageFlags.Ephemeral, MessageFlags.Ephemeral);
  assert.deepEqual(service.calls, []);
});

test("concurrent delete confirmations are serialized instead of returning ticket busy", async () => {
  const interactions = [
    makeButton("evix:confirm:42:delete"),
    makeButton("evix:confirm:42:delete"),
  ];
  const service = delayedService({
    id: 42,
    owner_id: "owner",
    status: "closed",
    staff_roles: [],
  });
  service.canManageTicket = () => true;

  let running = 0;
  let maxRunning = 0;
  service.delete = async () => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((resolve) => setTimeout(resolve, 10));
    running -= 1;
    service.calls.push("delete");
  };

  await Promise.all(interactions.map((interaction) => handleInteraction(interaction, { service, ui: {} })));
  assert.equal(maxRunning, 1);
  assert.deepEqual(service.calls, ["delete", "delete"]);
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


test("async ticket service failures are caught after the interaction is acknowledged", async () => {
  const interaction = makeButton("evix:t:42:claim");
  interaction.deferReply = async () => {
    interaction.deferred = true;
    interaction.calls.push("deferReply");
  };
  const service = delayedService({
    id: 42,
    owner_id: "owner",
    status: "open",
    staff_roles: [],
  });
  service.withTicketActionLock = async (_ticketId, callback) => callback();
  service.claim = async () => { throw new Error("simulated claim failure"); };

  await assert.doesNotReject(() => handleInteraction(interaction, { service, ui: {} }));
  assert.equal(interaction.calls[0], "deferReply");
  assert.equal(interaction.calls.includes("editReply"), true);
});


function makePanelCommandInteraction(subcommand) {
  const calls = [];
  const interaction = {
    commandName: "panel",
    customId: null,
    guildId: "guild",
    channelId: "channel",
    user: { id: "user" },
    member: { id: "user" },
    memberPermissions: { has: () => false },
    deferred: false,
    replied: false,
    calls,
    options: {
      getSubcommand: () => subcommand,
      getString: () => null,
    },
    isAutocomplete: () => false,
    isChatInputCommand: () => true,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    isButton: () => false,
    deferReply: async () => { interaction.deferred = true; calls.push("deferReply"); },
    reply: async () => { interaction.replied = true; calls.push("reply"); },
    editReply: async () => { calls.push("editReply"); },
  };
  return interaction;
}

test("panel create and edit acknowledge before permission/database work", async () => {
  for (const subcommand of ["create", "edit"]) {
    const interaction = makePanelCommandInteraction(subcommand);
    await handleInteraction(interaction, { service: {}, ui: {} });
    assert.equal(interaction.calls[0], "deferReply");
    assert.equal(interaction.deferred, true);
    assert.equal(interaction.calls.includes("editReply"), true);
  }
});
