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

test("concurrent delete confirmations are serialized without duplicate deletion starts", async () => {
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
    return { started: true, start: () => Promise.resolve() };
  };

  await Promise.all(interactions.map((interaction) => handleInteraction(interaction, { service, ui: {} })));
  assert.equal(maxRunning, 1);
  assert.deepEqual(service.calls, ["delete", "delete"]);
});

test("delete confirmation shows progress before the channel deletion starts", async () => {
  const interaction = makeButton("evix:confirm:42:delete");
  const service = serviceFor({
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
      return new Promise((resolve) => { resolveDeletion = resolve; });
    },
  });
  interaction.editReply = async (payload) => {
    events.push("editReply:" + (payload?.components ? JSON.stringify(payload.components.map((component) => component.toJSON())) : "other"));
    interaction.editReplyPayloads = [...(interaction.editReplyPayloads ?? []), payload];
  };

  const running = handleInteraction(interaction, { service, ui: {} });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(events[0].startsWith("editReply:"), true);
  assert.equal(events[1], "delete-start");

  resolveDeletion();
  await running;
});


test("concurrent delete confirmations do not wait for the first Discord channel deletion", async () => {
  const interactions = [
    makeButton("evix:confirm:42:delete"),
    makeButton("evix:confirm:42:delete"),
  ];

  const ticketByCall = [
    { id: 42, owner_id: "owner", status: "closed", staff_roles: [] },
    { id: 42, owner_id: "owner", status: "deleted", staff_roles: [] },
  ];
  const service = serviceFor(ticketByCall[0]);
  service.withTicketActionLock = withTicketActionLock;
  service.getTicket = async () => ticketByCall.shift() || { id: 42, owner_id: "owner", status: "deleted", staff_roles: [] };
  service.canManageTicket = () => true;

  let signalFirstDeleteStarted;
  let releaseFirstDelete;
  const firstDeleteStarted = new Promise((resolve) => { signalFirstDeleteStarted = resolve; });
  const firstDeleteDone = new Promise((resolve) => { releaseFirstDelete = resolve; });

  service.delete = async (_interaction, ticket) => {
    if (ticket.status === "deleted") return { started: false };
    return {
      started: true,
      start: () => {
        signalFirstDeleteStarted();
        return firstDeleteDone;
      },
    };
  };

  const firstRun = handleInteraction(interactions[0], { service, ui: {} });
  await firstDeleteStarted;

  const secondRun = handleInteraction(interactions[1], { service, ui: {} });
  await secondRun;

  assert.equal(
    interactions[0].editReplyPayloads?.some((payload) => JSON.stringify(payload.components?.map((x) => x.toJSON())).includes("Deleting Ticket")),
    true,
  );
  assert.equal(
    interactions[1].editReplyPayloads?.some((payload) => JSON.stringify(payload.components?.map((x) => x.toJSON())).includes("already been deleted")),
    true,
  );

  releaseFirstDelete();
  await firstRun;
});


test("ticket confirmation progress responses remain Components V2", async () => {
  for (const action of ["close", "delete"]) {
    const interaction = makeButton("evix:confirm:42:" + action);
    const service = serviceFor({
      id: 42,
      owner_id: "owner",
      status: action === "delete" ? "closed" : "open",
      staff_roles: [],
    });
    service.canManageTicket = () => true;

    await handleInteraction(interaction, { service, ui: {} });

    const payloads = interaction.editReplyPayloads ?? [];
    assert.equal(payloads.length >= 1, true);
    assert.equal(payloads.every((payload) => (payload.flags & MessageFlags.IsComponentsV2) === MessageFlags.IsComponentsV2), true);
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


test("component deferUpdate failures return a Components V2 error instead of an embed", async () => {
  const panelId = "77";
  setPanelDraft("guild", "user", panelId, {
    id: Number(panelId),
    name: "Panel",
    title: "",
    description: "",
    image_url: null,
    accent_color: 0x5865f2,
    placeholder: "",
    options: Array.from({ length: 26 }, (_, index) => ({
      id: index + 1,
      label: "Option " + (index + 1),
      action: "CREATE_TICKET",
    })),
  });

  const interaction = {
    customId: "evix:panelstudio-modal:77:basic",
    commandName: null,
    guildId: "guild",
    channelId: "channel",
    user: { id: "user" },
    member: { id: "user" },
    memberPermissions: { has: () => true },
    deferred: false,
    replied: false,
    isAutocomplete: () => false,
    isChatInputCommand: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => true,
    isButton: () => false,
    fields: { fields: new Map([["name", { value: "Panel" }]]) },
    client: { user: null },
    deferUpdate: async () => { interaction.deferred = true; },
    editReply: async (payload) => { interaction.errorPayload = payload; },
    reply: async () => { interaction.replied = true; },
  };

  try {
    await handleInteraction(interaction, { service: {}, ui: {} });
    assert.ok(interaction.errorPayload);
    assert.equal(interaction.errorPayload.flags, MessageFlags.IsComponentsV2);
    assert.equal(interaction.errorPayload.embeds, undefined);
    assert.match(JSON.stringify(interaction.errorPayload.components.map((component) => component.toJSON())), /Evix Error/);
  } finally {
    clearPanelDraft("guild", "user", panelId);
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
