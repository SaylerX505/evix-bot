
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


test("ticket control refreshes are serialized per ticket", async () => {
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

  await Promise.all([
    service.refreshControlMessage(interaction, claimed, { welcomeOverride: "FIRST" }),
    service.refreshControlMessage(interaction, unclaimed, { welcomeOverride: "SECOND" }),
  ]);

  assert.deepEqual(events, ["first-start", "first-end", "second-start", "second-end"]);
});
