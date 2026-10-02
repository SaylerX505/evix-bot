
import test from "node:test";
import assert from "node:assert/strict";
import { PermissionFlagsBits } from "discord.js";
import { TicketService } from "../src/tickets.js";

const service = new TicketService({});

function member(id, { manageChannels = false, roles = [] } = {}) {
  return {
    id,
    permissions: { has: (permission) => manageChannels && permission === PermissionFlagsBits.ManageChannels },
    roles: { cache: new Map(roles.map((roleId) => [roleId, {}])) },
  };
}

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


test("reopen rolls back participant access when the DB transition fails", async () => {
  const originalFresh = service.getFreshTicket;
  const originalSettings = service.getSettings;
  const originalPermissions = service.setParticipantPermissions;

  const rollbacks = [];
  service.getFreshTicket = async () => ({
    id: 53,
    channel_id: "channel",
    ticket_key: "EVX-000053",
    owner_id: "owner",
    type_label: "Support",
    status: "closed",
    category_id: "category-1",
    current_category_id: "category-1",
    closed_category_id: "category-closed",
    backup_category_id: null,
    staff_roles: [],
    claimed_by: null,
  });
  service.getSettings = async () => ({
    ticket_category_id: "category-1",
    open_category_id: "category-1",
    backup_category_id: null,
  });
  service.setParticipantPermissions = async (_interaction, _ticket, options) => {
    if (options.view === false) rollbacks.push("rollback");
    return { changed: ["owner"], failed: [] };
  };

  const interaction = {
    guildId: "guild",
    channel: {
      parentId: "category-1",
      guild: {
        channels: {
          fetch: async (id) => id === "category-1"
            ? { id: "category-1", type: 4 }
            : null,
        },
      },
      permissionOverwrites: {
        edit: async (userId, options) => {
          if (options.ViewChannel === false) rollbacks.push("owner-permission-rollback:" + userId);
        },
      },
    },
    user: { id: "staff" },
    member: member("staff", { manageChannels: true }),
    guild: {
      channels: {
        fetch: async (id) => id === "category-1"
          ? {
              id: "category-1",
              type: 4,
            }
          : null,
      },
    },
    deferred: false,
    replied: false,
    reply: async () => {},
    editReply: async () => {},
  };

  try {
    await assert.rejects(
      () => service.reopen(interaction, { id: 53 }),
      /Database has not been initialized/,
    );
    assert.deepEqual(rollbacks, ["owner-permission-rollback:owner"]);
  } finally {
    service.getFreshTicket = originalFresh;
    service.getSettings = originalSettings;
    service.setParticipantPermissions = originalPermissions;
  }
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
