export const TICKET_STATES = Object.freeze({
  OPEN: "open",
  LOCKED: "locked",
  CLOSED: "closed",
  DELETED: "deleted",
});

const transitions = new Map([
  ["open:close", "closed"],
  ["locked:close", "closed"],
  ["open:lock", "locked"],
  ["locked:unlock", "open"],
  ["closed:reopen", "open"],
]);

export function transitionTicket(state, action) {
  const current = String(state);
  if (!Object.values(TICKET_STATES).includes(current)) {
    throw new Error("Invalid ticket state: " + current);
  }
  if (current === TICKET_STATES.DELETED) {
    if (action === "delete") return TICKET_STATES.DELETED;
    throw new Error("Deleted tickets cannot be modified.");
  }
  if (action === "delete") return TICKET_STATES.DELETED;
  const next = transitions.get(current + ":" + String(action));
  if (!next) throw new Error("Invalid ticket transition: " + current + " -> " + action);
  return next;
}
