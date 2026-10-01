import test from "node:test";
import assert from "node:assert/strict";
import { PermissionFlagsBits } from "discord.js";
import { handleInteraction } from "../src/handler.js";
import { buildClosedTicketView, buildTicketView } from "../src/ui.js";
import { transitionTicket } from "../src/state.js";

const MUTATING = ["claim", "unclaim", "waiting", "reopen"];
const READONLY = ["info", "transcript"];
const REQUESTS = ["close", "delete"];

function xorshift32(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0x100000000;
  };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

function splitmix32(seed) {
  let x = BigInt(seed >>> 0);
  return () => {
    x = (x + 0x9E3779B9n) & 0xffffffffn;
    let z = x;
    z = ((z ^ (z >> 16n)) * 0x21f0aaadn) & 0xffffffffn;
    z = ((z ^ (z >> 15n)) * 0x735a2d97n) & 0xffffffffn;
    z ^= z >> 15n;
    return Number(z & 0xffffffffn) / 0x100000000;
  };
}

function lcg(seed) {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 0x100000000;
  };
}

function shuffled(values, random) {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function sequenceUniform(random, length) {
  const pool = [...MUTATING, ...READONLY, ...REQUESTS];
  const out = [];
  while (out.length < length) out.push(...shuffled(pool, random));
  return out.slice(0, length);
}

function sequenceWeighted(random, length) {
  const pool = [
    ["claim", 4], ["unclaim", 3], ["waiting", 4], ["reopen", 4],
    ["info", 2], ["transcript", 2], ["close", 5], ["delete", 3],
  ];
  const total = pool.reduce((sum, [, weight]) => sum + weight, 0);
  const out = [];
  while (out.length < length) {
    let target = random() * total;
    for (const [action, weight] of pool) {
      target -= weight;
      if (target < 0) {
        out.push(action);
        break;
      }
    }
  }
  return out;
}

function sequenceMarkov(random, length) {
  const pool = [...MUTATING, ...READONLY, ...REQUESTS];
  const out = [];
  let current = pool[Math.floor(random() * pool.length)];
  for (let i = 0; i < length; i += 1) {
    if (random() > 0.32) out.push(current);
    else {
      current = pool[Math.floor(random() * pool.length)];
      out.push(current);
    }
  }
  return out;
}

function sequenceBursts(random, length) {
  const pool = shuffled([...MUTATING, ...READONLY, ...REQUESTS], random);
  const out = [];
  while (out.length < length) {
    const action = pool[Math.floor(random() * pool.length)];
    const burst = 1 + Math.floor(random() * 8);
    for (let i = 0; i < burst && out.length < length; i += 1) out.push(action);
  }
  return out;
}

function makeInteraction(customId, user) {
  const calls = [];
  const interaction = {
    customId,
    commandName: null,
    guildId: "guild",
    channelId: "channel",
    user: { id: user.id },
    member: user.member,
    memberPermissions: user.memberPermissions,
    deferred: false,
    replied: false,
    calls,
    isAutocomplete: () => false,
    isChatInputCommand: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    isButton: () => true,
    deferReply: async () => {
      assert.equal(interaction.deferred || interaction.replied, false, "duplicate initial interaction acknowledgement");
      interaction.deferred = true;
      calls.push("deferReply");
    },
    deferUpdate: async () => {
      assert.equal(interaction.deferred || interaction.replied, false, "duplicate initial interaction acknowledgement");
      interaction.deferred = true;
      calls.push("deferUpdate");
    },
    reply: async () => {
      assert.equal(interaction.deferred || interaction.replied, false, "duplicate initial interaction acknowledgement");
      interaction.replied = true;
      calls.push("reply");
    },
    editReply: async () => {
      assert.equal(interaction.deferred || interaction.replied, true, "editReply before acknowledgement");
      calls.push("editReply");
    },
    update: async () => {
      assert.equal(interaction.deferred || interaction.replied, false, "update after acknowledgement");
      interaction.replied = true;
      calls.push("update");
    },
    showModal: async () => {
      assert.equal(interaction.deferred || interaction.replied, false, "showModal after acknowledgement");
      interaction.replied = true;
      calls.push("showModal");
    },
    deleteReply: async () => { calls.push("deleteReply"); },
    followUp: async () => {
      assert.equal(interaction.deferred || interaction.replied, true, "followUp before acknowledgement");
      calls.push("followUp");
    },
    guild: {},
  };
  return interaction;
}

function buildWorld() {
  const state = {
    id: 42,
    owner_id: "owner",
    status: "open",
    claimed_by: null,
    claimed_at: null,
    staff_roles: ["staff-role"],
    ticket_key: "EVX-000042",
    type_label: "Support",
    current_category_id: "category",
    closed_by: null,
    created_at: new Date(0),
  };
  const stats = { mutations: 0, rejected: 0 };
  let locked = false;

  const service = {
    state,
    stats,
    async getTicket() {
      await new Promise((resolve) => setTimeout(resolve, (stats.mutations * 7 + state.id) % 4));
      return { ...state };
    },
    canManageTicket: () => true,
    canClose: (member, ticket) => member?.id === ticket.owner_id || true,
    withTicketActionLock: async (_id, callback) => {
      if (locked) {
        const error = new Error("Another action is already being processed for this ticket.");
        error.code = "EVIX_TICKET_BUSY";
        stats.rejected += 1;
        throw error;
      }
      locked = true;
      try {
        await new Promise((resolve) => setTimeout(resolve, 1 + (stats.mutations % 3)));
        return await callback();
      } finally {
        locked = false;
      }
    },
    requestClose: async (interaction) => {
      await interaction.editReply({ pending: "close" });
    },
    requestDelete: async (interaction) => {
      await interaction.editReply({ pending: "delete" });
    },
    claim: async (interaction) => {
      if (state.status !== "open" || state.claimed_by) throw new Error("claim invalid for current state");
      state.claimed_by = interaction.user.id;
      state.claimed_at = new Date();
      stats.mutations += 1;
      await interaction.editReply({ state: "claimed" });
    },
    unclaim: async (interaction) => {
      if (!state.claimed_by || !["open", "waiting"].includes(state.status)) throw new Error("unclaim invalid for current state");
      state.claimed_by = null;
      state.claimed_at = null;
      stats.mutations += 1;
      await interaction.editReply({ state: "unclaimed" });
    },
    waiting: async (interaction) => {
      if (!["open", "waiting"].includes(state.status)) throw new Error("waiting invalid for current state");
      state.status = transitionTicket(state.status, "waiting");
      stats.mutations += 1;
      await interaction.editReply({ state: state.status });
    },
    reopen: async (interaction) => {
      if (state.status !== "closed") throw new Error("reopen invalid for current state");
      state.status = transitionTicket(state.status, "reopen");
      state.claimed_by = null;
      stats.mutations += 1;
      await interaction.editReply({ state: "open" });
    },
    close: async (interaction) => {
      if (!["open", "waiting", "locked"].includes(state.status)) throw new Error("close invalid for current state");
      state.status = transitionTicket(state.status, "close");
      state.claimed_by = null;
      stats.mutations += 1;
      await interaction.editReply({ state: "closed" });
    },
    delete: async (interaction) => {
      if (state.status !== "closed") throw new Error("delete invalid for current state");
      state.status = transitionTicket(state.status, "delete");
      stats.mutations += 1;
      await interaction.editReply({ state: "deleted" });
    },
    info: async (interaction) => interaction.editReply({ info: true }),
    sendTranscript: async (interaction) => interaction.editReply({ transcript: true }),
  };

  return { service, stats };
}

function userFor(action, index) {
  const owner = action === "close" || action === "info";
  const member = {
    id: owner ? "owner" : "staff-" + (index % 3),
    permissions: { has: () => true },
    roles: { cache: new Map([["staff-role", {}]]) },
  };
  return {
    id: member.id,
    member,
    memberPermissions: { has: () => true },
  };
}

async function runSequence(random, length) {
  const world = buildWorld();
  const sequence = sequenceUniform(random, length);
  for (let i = 0; i < sequence.length; i += 1) {
    const action = sequence[i];
    const user = userFor(action, i);
    const interaction = makeInteraction("evix:t:42:" + action, user);
    await handleInteraction(interaction, { service: world.service, ui: {} });
    assert.equal(interaction.deferred || interaction.replied, true, "interaction was left unacknowledged: " + action);
    assert.ok(interaction.calls.includes("deferReply"), "ticket button did not acknowledge through deferReply: " + action);
    assert.ok(["open", "waiting", "closed", "deleted"].includes(world.service.state.status));
    assert.doesNotThrow(() => buildTicketView(world.service.state, { welcome_message: "Test" }));
    assert.doesNotThrow(() => buildClosedTicketView(world.service.state));
  }
  return world.stats;
}

test("randomized ticket-button sequences stay acknowledged across multiple PRNG/action-order families", async () => {
  const families = [
    ["uniform-xorshift", xorshift32(0xA11CE)],
    ["weighted-mulberry", sequenceWeighted, mulberry32(0xBADC0DE)],
    ["markov-splitmix", sequenceMarkov, splitmix32(0xC0FFEE)],
    ["burst-lcg", sequenceBursts, lcg(0x12345678)],
  ];

  let total = 0;
  for (const [name, generatorOrRandom, maybeRandom] of families) {
    const random = maybeRandom ?? generatorOrRandom;
    const generator = typeof generatorOrRandom === "function" && maybeRandom
      ? generatorOrRandom
      : sequenceUniform;
    const world = buildWorld();
    const sequence = (generator === sequenceUniform ? sequenceUniform : generator)(random, 2500);
    for (let i = 0; i < sequence.length; i += 1) {
      const action = sequence[i];
      const user = userFor(action, i);
      const interaction = makeInteraction("evix:t:42:" + action, user);
      await handleInteraction(interaction, { service: world.service, ui: {} });
      assert.equal(interaction.deferred || interaction.replied, true, name + " left an interaction unacknowledged at step " + i);
      assert.equal(interaction.calls[0], "deferReply", name + " did not acknowledge early at step " + i);
      assert.ok(["open", "waiting", "closed", "deleted"].includes(world.service.state.status), name + " produced invalid final state");
      total += 1;
    }
  }
  assert.equal(total, 10000);
});

test("randomized concurrent ticket controls allow the lock to serialize mutations", async () => {
  const world = buildWorld();
  const random = mulberry32(0x51CED);
  for (let round = 0; round < 80; round += 1) {
    world.service.state.status = "open";
    world.service.state.claimed_by = null;
    const actions = shuffled(MUTATING, random);
    const interactions = actions.map((action, index) =>
      makeInteraction("evix:t:42:" + action, userFor(action, index)),
    );
    await Promise.all(interactions.map((interaction) =>
      handleInteraction(interaction, { service: world.service, ui: {} }),
    ));
    for (const interaction of interactions) {
      assert.equal(interaction.deferred || interaction.replied, true, "concurrent interaction was not acknowledged");
      assert.equal(interaction.calls[0], "deferReply", "concurrent control did not acknowledge first");
    }
    assert.ok(world.stats.mutations <= 1, "more than one mutation escaped the ticket action lock");
  }
});
