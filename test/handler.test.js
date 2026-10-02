import test from "node:test";
import assert from "node:assert/strict";
import { MessageFlags } from "discord.js";
import { withTicketActionLock } from "../src/db.js";
import { handleInteraction } from "../src/handler.js";
import { clearPanelDraft, setPanelDraft } from "../src/panels.js";

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
    followUp: async (payload) => { interaction.followUpPayload = payload; calls.push("followUp"); },
    reply: async () => { interaction.replied = true; calls.push("reply"); },
    editReply: async (payload) => { interaction.editReplyPayloads = [...(interaction.editReplyPayloads ?? []), payload]; calls.push("editReply"); },
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
    delete: async () => ({ started: true, start: () => Promise.resolve() }),
  };
}

test("keep-open removes only the close confirmation", async () => {
  const interaction = makeButton("evix:confirm:42:keep-open");
  const service = serviceFor({ id: 42, owner_id: "owner", status: "open", staff_roles: [] });
  await handleInteraction(interaction, { service, ui: {} });
  assert.deepEqual(interaction.calls, ["deferUpdate", "deleteReply"]);
  assert.deepEqual(service.calls, []);
});

test("confirm close shows progress and completes the close operation", async () => {
  const interaction = makeButton("evix:confirm:42:close");
  const service = serviceFor({ id: 42, owner_id: "owner", status: "open", staff_roles: [] });
  await handleInteraction(interaction, { service, ui: {} });
  assert.deepEqual(interaction.calls, ["deferUpdate", "editReply", "editReply"]);
  assert.deepEqual(service.calls, ["close"]);
});

test("confirm close surfaces a failure in the same progress response", async () => {
  const interaction = makeButton("evix:confirm:42:close");
  const service = serviceFor({ id: 42, owner_id: "owner", status: "open", staff_roles: [] });
  service.close = async () => { throw new Error("Close failed"); };
  await handleInteraction(interaction, { service, ui: {} });
  assert.deepEqual(interaction.calls, ["deferUpdate", "editReply", "editReply"]);
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
  service.withTicketActionLock = withTicketActionLock;

  let running = 0;
  let maxRunning = 0;
  service.delete = async () => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((resolve) => setTimeout(resolve, 10));
    running -= 1;
    service.calls.push("delete");
    return { started: true, completion: Promise.resolve() };
  };

  await Promise.all(interactions.map((interaction) => handleInteraction(interaction, { service, ui: {} })));
  assert.equal(maxRunning, 1);
  assert.deepEqual(service.calls, ["delete", "delete"]);
});

test("delete confirmation acknowledges deletion before the channel deletion promise finishes", async () => {
  const interaction = makeButton("evix:confirm:42:delete");
  const service = delayedService({
    id: 42,
    owner_id: "owner",
    status: "closed",
    staff_roles: [],
  });
  service.canManageTicket = () => true;

  let resolveDeletion;
  const deletionFinished = new Promise((resolve) => { resolveDeletion = resolve; });
  service.delete = async () => ({
    started: true,
    completion: deletionFinished,
  });

  const running = handleInteraction(interaction, { service, ui: {} });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(interaction.calls, ["deferUpdate", "deleteReply", "followUp"]);
  assert.match(JSON.stringify(interaction.followUpPayload.components.map((component) => component.toJSON())), /Deleting Ticket/);

  resolveDeletion();
  await running;
});

test("close confirmation shows progress before the close operation starts", async () => {
  const interaction = makeButton("evix:confirm:42:close");
  const service = delayedService({
    id: 42,
    owner_id: "owner",
    status: "open",
    staff_roles: [],
  });
  service.canManageTicket = () => true;
  const events = [];
  service.close = async () => {
    events.push("close-start");
    await new Promise((resolve) => setTimeout(resolve, 20));
    events.push("close-end");
  };
  interaction.editReply = async (payload) => {
    events.push("editReply:" + (payload?.components ? JSON.stringify(payload.components.map((component) => component.toJSON())) : "other"));
  };

  await handleInteraction(interaction, { service, ui: {} });

  assert.equal(events[0].startsWith("editReply:"), true);
  assert.equal(events.includes("close-start"), true);
});

test("delete confirmation shows progress before channel deletion starts", async () => {
  const interaction = makeButton("evix:confirm:42:delete");
  const service = delayedService({
    id: 42,
    owner_id: "owner",
    status: "closed",
    staff_roles: [],
  });
  service.canManageTicket = () => true;
  const events = [];
  let resolveDeletion;
  service.delete = async () => ({
    started: true,
    start: () => {
      events.push("delete-start");
      return new Promise((resolve) => {
        resolveDeletion = resolve;
      });
    },
  });
  interaction.editReply = async (payload) => {
    events.push("editReply:" + (payload?.components ? JSON.stringify(payload.components.map((component) => component.toJSON())) : "other"));
  };

  const running = handleInteraction(interaction, { service, ui: {} });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(events[0].startsWith("editReply:"), true);
  assert.equal(events.includes("delete-start"), true);

  resolveDeletion();
  await running;
});

test("ticket confirmation progress keeps Components V2 and Ephemeral flags", async () => {
  for (const action of ["close", "delete"]) {
    const interaction = makeButton("evix:confirm:42:" + action);
    const service = delayedService({
      id: 42,
      owner_id: "owner",
      status: action === "delete" ? "closed" : "open",
      staff_roles: [],
    });
    service.canManageTicket = () => true;
    await handleInteraction(interaction, { service, ui: {} });

    const payload = interaction.editReplyPayloads?.at(-1);
    assert.ok(payload);
  }
});