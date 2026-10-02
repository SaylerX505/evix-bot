export const TICKET_STATES = Object.freeze({
  OPEN: "open",
  CLOSED: "closed",
  DELETED: "deleted",
});

const transitions = new Map([
  ["open:close", "closed"],
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
