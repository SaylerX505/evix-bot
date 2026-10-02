
import test from "node:test";
import assert from "node:assert/strict";
import { PermissionFlagsBits } from "discord.js";
import { assertTicketChannel, TicketService } from "../src/tickets.js";

const service = new TicketService({});

function member(id, { manageChannels = false, roles = [] } = {}) {
  return {
    id,
    permissions: { has: (permission) => manageChannels && permission === PermissionFlagsBits.ManageChannels },
    roles: { cache: new Map(roles.map((roleId) => [roleId, {}])) },
  };
}

test("ticket channel renames are serialized per ticket", async () => {
  const events = [];
  let releaseFirst;
  let signalFirstStarted;
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  const firstStarted = new Promise((resolve) => { signalFirstStarted = resolve; });

  const first = service.queueChannelName(90, async () => {
    events.push("first-start");
    signalFirstStarted();
    await firstBlocked;
    events.push("first-end");
  });

  await firstStarted;
  const second = service.queueChannelName(90, async () => {
    events.push("second");
  });

  assert.deepEqual(events, ["first-start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first-start", "first-end", "second"]);
});

test("ticket mutations reject a ticket id used from another channel", () => {
  assert.throws(
    () => assertTicketChannel(
      { channelId: "different-channel" },
      { channel_id: "ticket-channel" },
    ),
    /not available in the current channel/,
  );
});

test("ticket management accepts configured staff or Manage Channels", () => {
  const ticket = { staff_roles: ["staff-role"] };
  assert.equal(service.canManageTicket(member("u1", { roles: ["staff-role"] }), ticket), true);
  assert.equal(service.canManageTicket(member("u2", { manageChannels: true }), ticket), true);
  assert.equal(service.canManageTicket(member("u3"), ticket), false);
});

test("ticket owner may close and view info but is not staff", () => {
  const ticket = { owner_id: "owner", staff_roles: [] };
  assert.equal(service.canClose(member("owner"), ticket), true);
  assert.equal(service.canManageTicket(member("owner"), ticket), false);
});


test("trusted post-mutation control refresh skips an extra database read", async () => {
  const originalFresh = service.getFreshTicket;
  let freshReads = 0;
  service.getFreshTicket = async () => {
    freshReads += 1;
    throw new Error("unexpected extra database read");
  };
  const edits = [];
  const ticket = {
    id: 55,
    channel_id: "channel",
    control_message_id: "control",
    ticket_key: "EVX-000055",
    owner_id: "owner",
    type_label: "Support",
    status: "closed",
    closed_by: "staff",
    staff_roles: [],
  };
  const interaction = {
    guildId: "guild",
    channel: {
      id: "channel",
      isTextBased: () => true,
      messages: {
        fetch: async () => ({ edit: async (payload) => edits.push(payload) }),
      },
    },
    guild: { channels: { fetch: async () => null } },
  };

  try {
    await service.refreshControlMessage(interaction, ticket, { ticketIsFresh: true });
    assert.equal(freshReads, 0);
    assert.equal(edits.length, 1);
  } finally {
    service.getFreshTicket = originalFresh;
  }
});

test("control refresh requires fresh ticket state and does not trust stale input", async () => {
  const originalFresh = service.getFreshTicket;
  service.getFreshTicket = async () => ({
    id: 41, channel_id: "channel", control_message_id: "control",
    ticket_key: "EVX-000041", owner_id: "owner", type_label: "Support",
    status: "closed", closed_by: "staff", staff_roles: [],
  });
  const edited = [];
  const interaction = {
    guildId: "guild",
    guild: {
      channels: {
        fetch: async () => ({
          isTextBased: () => true,
          messages: { fetch: async () => ({ edit: async (payload) => edited.push(payload) }) },
        }),
      },
    },
  };
  try {
    await service.refreshControlMessage(interaction, {
      id: 41, channel_id: "channel", control_message_id: "control",
      ticket_key: "EVX-000041", owner_id: "owner", type_label: "Support",
      status: "open", claimed_by: "staff", staff_roles: [],
    });
    assert.equal(edited.length, 1);
    const rendered = JSON.stringify(edited[0].components.map((component) => component.toJSON()));
    assert.match(rendered, /Get Transcript/);
    assert.doesNotMatch(rendered, /evix:t:41:claim|evix:t:41:close|evix:t:41:info/);
  } finally {
    service.getFreshTicket = originalFresh;
  }
});

test("post-mutation control refresh may use only the explicitly trusted state on DB read failure", async () => {
  const originalFresh = service.getFreshTicket;
  service.getFreshTicket = async () => { throw new Error("database unavailable"); };
  const edited = [];
  const ticket = {
    id: 54,
    channel_id: "channel",
    control_message_id: "control",
    ticket_key: "EVX-000054",
    owner_id: "owner",
    type_label: "Support",
    status: "closed",
    closed_by: "staff",
    staff_roles: [],
  };
  const interaction = {
    guildId: "guild",
    guild: {
      channels: {
        fetch: async () => ({
          isTextBased: () => true,
          messages: {
            fetch: async () => ({ edit: async (payload) => edited.push(payload) }),
          },
        }),
      },
    },
  };

  try {
    await service.refreshControlMessage(interaction, ticket, { replace: false, fallbackToKnownState: true });
    assert.equal(edited.length, 1);
    const rendered = JSON.stringify(edited[0].components.map((component) => component.toJSON()));
    assert.match(rendered, /Get Transcript/);
    assert.doesNotMatch(rendered, /evix:t:54:claim|evix:t:54:close|evix:t:54:info/);
  } finally {
    service.getFreshTicket = originalFresh;
  }
});

test("control refresh propagates fresh ticket lookup failures", async () => {
  const originalFresh = service.getFreshTicket;
  service.getFreshTicket = async () => { throw new Error("database unavailable"); };
  try {
    await assert.rejects(
      () => service.refreshControlMessage({
        guildId: "guild",
        guild: { channels: { fetch: async () => { throw new Error("must not fetch channel"); } } },
      }, { id: 42, channel_id: "channel" }),
      /database unavailable/,
    );
  } finally {
    service.getFreshTicket = originalFresh;
  }
});

test("ticket control refreshes are serialized per ticket", async () => {
  const originalFresh = service.getFreshTicket;
  service.getFreshTicket = async (_interaction, ticket) => ticket;
  const events = [];
  let first = true;
  const message = {
    async edit(payload) {
      events.push(JSON.stringify(payload).includes("FIRST") ? "first-start" : "second-start");
      await new Promise((resolve) => setTimeout(resolve, first ? 10 : 0));
      first = false;
      events.push(JSON.stringify(payload).includes("FIRST") ? "first-end" : "second-end");
    },
  };
  const channel = {
    isTextBased: () => true,
    messages: {
      fetch: async () => message,
    },
  };
  const interaction = {
    guildId: "guild",
    guild: {
      channels: { fetch: async () => channel },
    },
  };
  const ticketBase = {
    id: 42,
    channel_id: "channel",
    control_message_id: "control",
    ticket_key: "EVX-000042",
    owner_id: "owner",
    type_label: "Support",
    status: "open",
    claimed_by: null,
    staff_roles: [],
  };
  const claimed = { ...ticketBase, claimed_by: "staff" };
  const unclaimed = { ...ticketBase, claimed_by: null };

  try {
    await Promise.all([
      service.refreshControlMessage(interaction, claimed, { welcomeOverride: "FIRST" }),
      service.refreshControlMessage(interaction, unclaimed, { welcomeOverride: "SECOND" }),
    ]);

    assert.deepEqual(events, ["first-start", "first-end", "second-start", "second-end"]);
  } finally {
    service.getFreshTicket = originalFresh;
  }
});


test("closed ticket refresh always renders the closed control view", async () => {
  const originalFresh = service.getFreshTicket;
  const edited = [];
  const channel = {
    isTextBased: () => true,
    messages: {
      fetch: async () => ({
        async edit(payload) {
          edited.push(payload);
        },
      }),
    },
  };
  const interaction = {
    guildId: "guild",
    guild: {
      channels: { fetch: async () => channel },
    },
  };
  const closedTicket = {
    id: 43,
    channel_id: "channel",
    control_message_id: "control",
    ticket_key: "EVX-000043",
    owner_id: "owner",
    type_label: "Support",
    status: "closed",
    closed_by: "staff",
    staff_roles: [],
  };

  service.getFreshTicket = async () => closedTicket;
  try {
    await service.refreshControlMessage(interaction, closedTicket);

    assert.equal(edited.length, 1);
    const rendered = JSON.stringify(edited[0].components.map((component) => component.toJSON()));
    assert.equal(rendered.includes("Ticket Closed"), true);
    assert.equal(rendered.includes("Get Transcript"), true);
    assert.equal(rendered.includes("Reopen"), true);
    assert.equal(rendered.includes("Delete Ticket"), true);
  } finally {
    service.getFreshTicket = originalFresh;
  }
});

test("stale close action on an already-closed ticket repairs the public control view", async () => {
  const refreshed = [];
  const originalRefresh = service.refreshControlMessage;
  const originalFreshTicket = service.getFreshTicket;
  service.getFreshTicket = async (_interaction, ticket) => ticket;
  service.refreshControlMessage = async (_interaction, ticket, options) => {
    refreshed.push({ ticket, options });
  };

  const interaction = {
    guildId: "guild",
    user: { id: "staff" },
    member: member("staff", { manageChannels: true }),
    deferred: false,
    replied: false,
    reply: async () => { interaction.replied = true; },
    editReply: async () => { interaction.replied = true; },
  };
  const ticket = {
    id: 44,
    owner_id: "owner",
    status: "closed",
    closed_by: "staff",
    staff_roles: [],
  };

  await service.requestClose(interaction, ticket);

  assert.equal(refreshed.length, 1);
  assert.deepEqual(refreshed[0].options, { closed: true, closedBy: "staff" });
  assert.equal(interaction.replied, true);
  service.refreshControlMessage = originalRefresh;
  service.getFreshTicket = originalFreshTicket;
});


test("delete handler acknowledges before physical channel deletion completes", async () => {
  const interaction = makeButton("evix:confirm:42:delete");
  let release;
  const completion = new Promise((resolve) => { release = resolve; });
  const service = serviceFor({ id: 42 });
  service.delete = async () => ({ completion });

  const started = Date.now();
  await handleInteraction(interaction, { service, ui: {} });
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 100);
  assert.equal(interaction.followUpPayload?.components?.length > 0, true);
  assert.match(JSON.stringify(interaction.followUpPayload.components.map((component) => component.toJSON())), /Ticket Deletion Started/);

  release();
  await completion;
});

test("reopen permission rollback preserves a staff member's channel visibility", async () => {
  const edits = [];
  const interaction = {
    guild: {
      members: {
        cache: new Map([["staff", member("staff", { manageChannels: true })]]),
        fetch: async () => null,
      },
    },
    channel: {
      permissionOverwrites: {
        edit: async (userId, options) => edits.push({ userId, options }),
      },
    },
  };
  await service.restoreParticipantPermissions(
    interaction,
    { staff_roles: [] },
    ["staff"],
    { view: false, send: false },
  );

  assert.deepEqual(edits, [{
    userId: "staff",
    options: {
      ViewChannel: true,
      SendMessages: false,
      ReadMessageHistory: true,
    },
  }]);
});

test("ticket info rejects a deleted ticket after refreshing state", async () => {
  const originalFresh = service.getFreshTicket;
  service.getFreshTicket = async () => ({ id: 50, owner_id: "owner", status: "deleted", staff_roles: [] });

  const interaction = {
    guildId: "guild",
    user: { id: "owner" },
    member: member("owner"),
  };

  await assert.rejects(
    () => service.info(interaction, { id: 50 }),
    /deleted/,
  );

  service.getFreshTicket = originalFresh;
});

test("ticket role management rejects a deleted ticket after refreshing state", async () => {
  const originalFresh = service.getFreshTicket;
  service.getFreshTicket = async () => ({ id: 51, owner_id: "owner", status: "deleted", staff_roles: [] });

  const interaction = {
    guildId: "guild",
    user: { id: "staff" },
    member: member("staff", { manageChannels: true }),
  };

  await assert.rejects(
    () => service.addRole(interaction, { id: 51 }, "role"),
    /deleted/,
  );

  service.getFreshTicket = originalFresh;
});



test("control refresh falls back to editing the existing message when replacement send fails", async () => {
  const edited = [];
  const message = {
    async edit(payload) {
      edited.push(payload);
    },
  };
  const originalFresh = service.getFreshTicket;
  service.getFreshTicket = async () => ticket;
  const channel = {
    isTextBased: () => true,
    messages: {
      fetch: async () => message,
    },
    send: async () => {
      throw new Error("simulated send failure");
    },
  };
  const interaction = {
    guildId: "guild",
    guild: { channels: { fetch: async () => channel } },
  };
  const ticket = {
    id: 52,
    channel_id: "channel",
    control_message_id: "control",
    ticket_key: "EVX-000052",
    owner_id: "owner",
    type_label: "Support",
    status: "closed",
    closed_by: "staff",
    staff_roles: [],
  };

  try {
    await service.refreshControlMessage(interaction, ticket, { replace: true });

    assert.equal(edited.length, 1);
    const rendered = JSON.stringify(edited[0].components.map((component) => component.toJSON()));
    assert.match(rendered, /Get Transcript/);
    assert.match(rendered, /Reopen/);
    assert.match(rendered, /Delete Ticket/);
  } finally {
    service.getFreshTicket = originalFresh;
  }
});
