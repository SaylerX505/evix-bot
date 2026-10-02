import test from "node:test";
import assert from "node:assert/strict";
import { writeTicketLog } from "../src/logs.js";

function makeGuild() {
  const sent = [];
  const channel = {
    isTextBased: () => true,
    send: async (payload) => { sent.push(payload); return payload; },
  };
  return {
    client: { user: { username: "Evix", displayAvatarURL: () => "https://cdn.discordapp.com/embed/avatars/0.png" } },
    channels: { fetch: async () => channel },
    sent,
  };
}

const ticket = {
  ticket_key: "EVX-000008",
  type_label: "Open Ticket",
  channel_id: "1535645488341192774",
  status: "closed",
  ticket_log_channel_id: "1555169303479980157",
  transcript_log_channel_id: "1555169303479980157",
  ticket_logs_enabled: true,
  transcript_logs_enabled: true,
  moderation_logs_enabled: true,
};

test("ticket audit logs only expose Open, Claimed, Closed, Deleted, and Transcript", async () => {
  const guild = makeGuild();

  for (const event of [
    "TICKET_CREATED",
    "TICKET_CLAIMED",
    "TICKET_CLOSED",
    "TICKET_DELETED",
    "TRANSCRIPT_CREATED",
  ]) {
    assert.equal(await writeTicketLog(guild, ticket, event, "user"), true, event);
  }

  const rendered = guild.sent.map((payload) => JSON.stringify(payload.components.map((component) => component.toJSON())));
  assert.equal(rendered.some((value) => value.includes("# Open")), true);
  assert.equal(rendered.some((value) => value.includes("# Claimed")), true);
  assert.equal(rendered.some((value) => value.includes("# Closed")), true);
  assert.equal(rendered.some((value) => value.includes("# Deleted")), true);
  assert.equal(rendered.some((value) => value.includes("# Transcript")), true);
});

test("transcript audit log carries the generated transcript attachment", async () => {
  const guild = makeGuild();
  const files = [{ attachment: Buffer.from("<html>transcript</html>"), name: "evx-000008-transcript.html" }];

  assert.equal(
    await writeTicketLog(guild, ticket, "TRANSCRIPT_CREATED", "user", { messages: 12 }, files),
    true,
  );
  assert.equal(guild.sent.length, 1);
  assert.equal(guild.sent[0].files.length, 1);
  assert.equal(guild.sent[0].files[0].name, "evx-000008-transcript.html");
});

test("transcript audit falls back to the ticket log channel", async () => {
  const guild = makeGuild();
  const transcriptOnlyTicket = {
    ...ticket,
    transcript_log_channel_id: null,
  };

  assert.equal(
    await writeTicketLog(guild, transcriptOnlyTicket, "TRANSCRIPT_CREATED", "user", { messages: 12 }),
    true,
  );
  assert.equal(guild.sent.length, 1);
});

test("non-lifecycle ticket events are not written to audit logs", async () => {
  const guild = makeGuild();

  for (const event of [
    "TICKET_REOPENED",
    "TICKET_UNCLAIMED",
    "TICKET_RENAMED",
    "MEMBER_ADDED",
    "MEMBER_REMOVED",
    "ROLE_ADDED",
  ]) {
    assert.equal(await writeTicketLog(guild, ticket, event, "user"), false, event);
  }

  assert.equal(guild.sent.length, 0);
});

test("transcript logging skips a missing dedicated channel and uses ticket log fallback", async () => {
  const sent = [];
  const fallback = {
    isTextBased: () => true,
    send: async (payload) => {
      sent.push(payload);
      return payload;
    },
  };
  const guild = {
    client: { user: { username: "Evix", displayAvatarURL: () => "https://cdn.discordapp.com/embed/avatars/0.png" } },
    channels: {
      fetch: async (id) => id === "missing" ? null : fallback,
    },
  };

  const result = await writeTicketLog(guild, {
    ...ticket,
    transcript_log_channel_id: "missing",
    ticket_log_channel_id: "fallback",
  }, "TRANSCRIPT_CREATED", "user");

  assert.equal(result, true);
  assert.equal(sent.length, 1);
});

