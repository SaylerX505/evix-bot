
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
