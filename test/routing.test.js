import test from "node:test";
import assert from "node:assert/strict";
import { ChannelType } from "discord.js";
import { findTicketReopenCategory } from "../src/routing.js";

test("reopen keeps an already-full current category instead of treating it as a creation target", async () => {
  const category = {
    id: "category-1",
    type: ChannelType.GuildCategory,
  };
  const guild = {
    channels: {
      fetch: async (id) => id === "category-1" ? category : null,
    },
  };

  const result = await findTicketReopenCategory(guild, ["category-1"], "category-1");
  assert.equal(result.category.id, "category-1");
  assert.deepEqual(result.failures, []);
});

test("reopen category selection falls back to normal creation checks when current category is not a candidate", async () => {
  const target = {
    id: "category-2",
    type: ChannelType.GuildCategory,
    children: { cache: new Map() },
    permissionsFor: () => ({ has: () => true }),
  };
  const guild = {
    members: { me: { id: "bot" } },
    channels: {
      fetch: async (id) => id === "category-2" ? target : null,
    },
  };

  const result = await findTicketReopenCategory(guild, ["category-2"], "category-1");
  assert.equal(result.category.id, "category-2");
});
