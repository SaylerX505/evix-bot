import test from "node:test";
import assert from "node:assert/strict";
import { TICKET_STATES, transitionTicket } from "../src/state.js";

test("waiting is a first-class ticket state", () => {
  assert.equal(TICKET_STATES.WAITING, "waiting");
  assert.equal(transitionTicket("open", "waiting"), "waiting");
  assert.equal(transitionTicket("waiting", "waiting"), "open");
  assert.equal(transitionTicket("waiting", "close"), "closed");
});


test("legacy locked tickets can still close", () => {
  assert.equal(transitionTicket("locked", "close"), "closed");
  assert.equal(transitionTicket("locked", "waiting"), "waiting");
});
