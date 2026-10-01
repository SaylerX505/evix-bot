import test from "node:test";
import assert from "node:assert/strict";
import { PermissionFlagsBits } from "discord.js";
import { handleInteraction } from "../src/handler.js";
import { buildClosedTicketView, buildTicketView } from "../src/ui.js";
import { transitionTicket } from "../src/state.js";

const TICKET_ACTIONS = [
  "claim", "unclaim", "waiting", "close", "reopen", "transcript", "delete", "info",
];

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

function shuffled(items, random) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function sequenceUniform(random, length) {
  const pool = [...TICKET_ACTIONS, "confirm-close", "confirm-keep", "confirm-delete", "confirm-cancel"];
  const out = [];
  while (out.length < length) out.push(...shuffled(pool, random));
  return out.slice(0, length);
}

function sequenceMarkov(random, length) {
  const out = [];
  let current = shuffled(TICKET_ACTIONS, random)[0];
  for (let i = 0; i < length; i += 1) {
    if (random() < 0.62) {
      out.push(current);
    } else {
      current = TICKET_ACTIONS[Math.floor(random() * TICKET_ACTIONS.length)];
      out.push(current);
    }
    if (random() < 0.12) out.push("confirm-close");
    if (out.length >= length) break;
  }
  return out.slice(0, length);
}

function sequenceTwoStream(randomA, randomB, length) {
  const left = sequenceUniform(randomA, Math.ceil(length / 2));
  const right = sequenceMarkov(randomB, Math.floor(length / 2));
  const out = [];
  while (out.length < length && (left.length || right.length)) {
    if (left.length && right.length) {
      if (randomA() < 0.5) out.push(left.shift());
      else out.push(right.shift());
    } else {
      out.push((left.length ? left : right).shift());
    }
  }
  return out.slice(0, length);
}

function sequenceBursts(random, length) {
  const out = [];
  const blocks = shuffled(TICKET_ACTIONS, random);
  let index = 0;
  while (out.length < length) {
    const action = blocks[index++ % blocks.length];
    const burst = 1 + Math.floor(random() * 6);
    for (let i = 0; i < burst && out.length < length; i += 1) out.push(action);
    if (random() < 0.35) out.push("confirm-keep");
    if (random() < 0.2) out.push("confirm-delete");
  }
  return out.slice(0, length);
}

function makeInteraction(customId, userId = "staff") {
  const calls = [];
  const interaction = {
    customId,
    commandName: null,
    guildId: "guild",
    channelId: "channel",
    user: { id: userId },
    member: {
      id: userId,
      permissions: { has: (permission) => permission === PermissionFlagsBits.ManageChannels },
    },
    memberPermissions: { has: () => true },
    deferred: false,
    replied: false,
    calls,
    isAutocomplete: () => false,
    isChatInputCommand: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    isButton: () => true,
    deferReply: async () => {
      assert.equal(interaction.deferred || interaction.replied, false, "duplicate initial ack");
      interaction.deferred = true;
      calls.push("deferReply");
    },
    deferUpdate: async () => {
      assert.equal(interaction.deferred || interaction.replied, false, "duplicate initial ack");
      interaction.deferred = true;
      calls.push("deferUpdate");
    },
    reply: async () => {
      assert.equal(interaction.deferred || interaction.replied, false, "duplicate initial ack");
      interaction.replied = true;
      calls.push("reply");
    },
    editReply: async () => {
      assert.equal(interaction.deferred || interaction.replied, true, "edit before ack");
      calls.push("editReply");
    },
    update: async () => {
      assert.equal(interaction.deferred || interaction.replied, false, "update after ack");
      interaction.replied = true;
      calls.push("update");
    },
    showModal: async () => {
      assert.equal(interaction.deferred || interaction.replied, false, "showModal after ack");
      interaction.replied = true;
      calls.push("showModal");
    },
    deleteReply: async () => { calls.push("deleteReply"); },
    followUp: async () => { assert.equal(interaction.deferred || interaction.replied, true); calls.push("followUp"); },
    guild: {},
  };
  return interaction;
}

function buildFakeService() {
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
  };
  const stats = { mutations: 0, confirmations: 0, lockBusy: 0 };

  let busy = false;
  let pending = null;

  const service = {
    state,
    stats,
    async getTicket() {
      const delay = Math.floor((state.id * 17 + stats.mutations * 13) % 7);
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      return { ...state };
    },
    canManageTicket: () => true,
    canClose: (member, ticket) => member?.id === ticket.owner_id || true,
    withTicketActionLock: async (_id, callback) => {
      if (busy) {
        stats.lockBusy += 1;
        const error = new Error("Another action is already being processed for this ticket.");
        error.code = "EVIX_TICKET_BUSY";
        throw error;
      }
      busy = true;
      try {
        return await callback();
      } finally {
        busy = false;
      }
    },
    requestClose: async (interaction) => {
      pending = "close";
      await interaction.editReply({ pending: "close" });
    },
    requestDelete: async (interaction) => {
      pending = "delete";
      await interaction.editReply({ pending: "delete" });
    },
    claim: async (interaction) => {
      if (state.status !== "open") throw new Error("Only open tickets can be claimed.");
      if (state.claimed_by) throw new Error("This ticket is already claimed.");
      state.claimed_by = interaction.user.id;
      state.claimed_at = new Date();
      stats.mutations += 1;
      await interaction.editReply({ state: "claimed" });
    },
    unclaim: async (interaction) => {
      if (!state.claimed_by) throw new Error("This ticket is not currently claimed.");
      if (!["open", "waiting"].includes(state.status)) throw new Error("This ticket cannot be unclaimed.");
      state.claimed_by = null;
      state.claimed_at = null;
      stats.mutations += 1;
      await interaction.editReply({ state: "unclaimed" });
    },
    waiting: async (interaction) => {
      if (!["open", "waiting"].includes(state.status)) throw new Error("Only active tickets can move to waiting.");
      state.status = transitionTicket(state.status, "waiting");
      stats.mutations += 1;
      await interaction.editReply({ state: state.status });
    },
    reopen: async (interaction) => {
      if (state.status !== "closed") throw new Error("This ticket is not closed.");
      state.status = transitionTicket(state.status, "reopen");
      state.claimed_by = null;
      stats.mutations += 1;
      await interaction.editReply({ state: "open" });
    },
    close: async (interaction) => {
      if (!["open", "waiting"].includes(state.status)) throw new Error("This ticket is not active.");
      state.status = transitionTicket(state.status, "close");
      state.claimed_by = null;
      stats.mutations += 1;
      await interaction.editReply({ state: "closed" });
    },
    delete: async (interaction) => {
      if (state.status !== "closed") throw new Error("Close the ticket before deleting it.");
      state.status = transitionTicket(state.status, "delete");
      stats.mutations += 1;
      await interaction.editReply({ state: "deleted" });
    },
    info: async (interaction) => interaction.editReply({ info: true }),
    sendTranscript: async (interaction) => interaction.editReply({ transcript: true }),
  };

  return {
    service,
    getPending: () => pending,
    clearPending: () => { pending = null; },
  };
}

async function applyStep(world, step) {
  let customAction = step;
  let confirmation = false;

  const pending = world.getPending();
  if (pending === "close") {
    if (step === "confirm-close") {
      customAction = "close";
      confirmation = true;
      world.clearPending();
    } else if (step === "confirm-keep") {
      customAction = "keep";
      confirmation = true;
      world.clearPending();
    } else {
      world.clearPending();
    }
  } else if (pending === "delete") {
    if (step === "confirm-delete") {
      customAction = "delete";
      confirmation = true;
      world.clearPending();
    } else if (step === "confirm-cancel") {
      customAction = "cancel";
      confirmation = true;
      world.clearPending();
    } else {
      world.clearPending();
    }
  }

  const customId = confirmation
    ? customAction === "close"
      ? "evix:confirm:42:close"
      : customAction === "keep"
        ? "evix:confirm:42:keep-open"
        : customAction === "delete"
          ? "evix:confirm:42:delete"
          : "evix:confirm:42:cancel"
    : "evix:t:42:" + customAction;

  const interaction = makeInteraction(customId, customAction === "info" ? "owner" : "staff");
  await handleInteraction(interaction, { service: world.service, ui: {} });

  assert.equal(interaction.deferred || interaction.replied, true, "interaction was left unacknowledged: " + step);
  const acknowledged = confirmation
    ? interaction.calls.includes("deferUpdate")
    : ["deferReply", "reply", "update", "showModal"].some((type) => interaction.calls.includes(type));
  assert.equal(acknowledged, true, "ticket interaction did not acknowledge: " + step);
  assert.ok(["open", "waiting", "closed", "deleted"].includes(world.service.state.status));
  const activeView = buildTicketView(world.service.state, { welcome_message: "Test" });
  const closedView = buildClosedTicketView(world.service.state);
  assert.equal(activeView.flags !== undefined, true);
  assert.equal(closedView.flags !== undefined, true);
}

test("randomized ticket interaction simulation covers independent action-order algorithms", async () => {
  const algorithms = [
    ["xorshift", sequenceUniform, xorshift32(0xA11CE)],
    ["mulberry", sequenceMarkov, mulberry32(0xBADC0DE)],
    ["splitmix-bursts", sequenceBursts, splitmix32(0xC0FFEE)],
    ["lcg-two-stream", (random) => sequenceTwoStream(random, lcg(0xFACEFEED), 350), lcg(0x12345678)],
  ];

  let total = 0;
  for (const [name, makeSequence, random] of algorithms) {
    const world = buildFakeService();
    const sequence = makeSequence(random, 350);
    for (const step of sequence) {
      await applyStep(world, step);
      total += 1;
    }
    assert.ok(world.service.stats.mutations >= 1, name + " produced no mutations");
  }

  assert.equal(total, 1400);
});

test("concurrent randomized ticket clicks allow one mutation at a time", async () => {
  const world = buildFakeService();
  world.service.withTicketActionLock = async (_id, callback) => {
    if (world.locked) {
      world.service.stats.lockBusy += 1;
      const error = new Error("Another action is already being processed for this ticket.");
      error.code = "EVIX_TICKET_BUSY";
      throw error;
    }
    world.locked = true;
    try {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return await callback();
    } finally {
      world.locked = false;
    }
  };

  world.service.state.status = "open";
  const interactions = [
    makeInteraction("evix:t:42:waiting"),
    makeInteraction("evix:t:42:close"),
    makeInteraction("evix:t:42:claim"),
    makeInteraction("evix:t:42:waiting"),
  ];

  await Promise.all(interactions.map((interaction) =>
    handleInteraction(interaction, { service: world.service, ui: {} }),
  ));

  for (const interaction of interactions) {
    assert.equal(interaction.deferred || interaction.replied, true, "concurrent interaction was not acknowledged");
  }
  assert.ok(world.service.stats.mutations <= 1, "multiple concurrent mutations escaped the ticket lock");
});
