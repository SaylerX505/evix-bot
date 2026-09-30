import test from "node:test";
import assert from "node:assert/strict";
import { transitionTicket } from "../src/state.js";

test("valid ticket transitions are deterministic", () => {
  assert.equal(transitionTicket("open", "close"), "closed");
  assert.equal(transitionTicket("locked", "close"), "closed");
  assert.equal(transitionTicket("open", "lock"), "locked");
  assert.equal(transitionTicket("locked", "unlock"), "open");
  assert.equal(transitionTicket("closed", "reopen"), "open");
});

test("invalid transitions are rejected", () => {
  assert.throws(() => transitionTicket("open", "reopen"), /Invalid ticket transition/);
  assert.throws(() => transitionTicket("deleted", "reopen"), /Deleted tickets/);
  assert.equal(transitionTicket("closed", "delete"), "deleted");
});
