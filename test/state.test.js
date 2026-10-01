import test from "node:test";
import assert from "node:assert/strict";
import { TICKET_STATES, transitionTicket } from "../src/state.js";

test("legacy locked tickets can still close", () => {
  assert.equal(transitionTicket("locked", "close"), "closed");
});
