import test from "node:test";
import assert from "node:assert/strict";
import { TICKET_STATES, transitionTicket } from "../src/state.js";


test("ticket state transitions form a closed set", () => {
  assert.equal(transitionTicket("open", "close"), TICKET_STATES.CLOSED);
  assert.equal(transitionTicket("locked", "close"), TICKET_STATES.CLOSED);
  assert.equal(transitionTicket("closed", "reopen"), TICKET_STATES.OPEN);
  assert.equal(transitionTicket("open", "delete"), TICKET_STATES.DELETED);
  assert.equal(transitionTicket("closed", "delete"), TICKET_STATES.DELETED);
  assert.equal(transitionTicket("deleted", "delete"), TICKET_STATES.DELETED);
});

test("invalid ticket states cannot transition even to deleted", () => {
  assert.throws(
    () => transitionTicket("corrupt", "delete"),
    /Invalid ticket state: corrupt/,
  );
});

