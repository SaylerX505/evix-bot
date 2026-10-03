import test from "node:test";
import assert from "node:assert/strict";
import { PermissionFlagsBits } from "discord.js";
import { TicketService } from "../src/tickets.js";

test("ticket rename uses the sanitized name directly without a lifecycle status prefix", async () => {
  const service = new TicketService({});
  const calls = [];
  const ticket = {
    id: 90,
    channel_id: "channel",
    status: "closed",
    owner_id: "owner",
    staff_roles: [],
  };

  service.getFreshTicket = async () => ticket;

  const interaction = {
    member: {
      id: "staff",
      permissions: {
        has: (permission) => permission === PermissionFlagsBits.ManageChannels,
      },
      roles: { cache: new Map() },
    },
    channel: {
      setName: async (name) => {
        calls.push(name);
      },
    },
    user: { id: "staff" },
    reply: async () => {},
  };

  await service.rename(interaction, ticket, " My Ticket! ");

  assert.deepEqual(calls, ["my-ticket"]);
});
