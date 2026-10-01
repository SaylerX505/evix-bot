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
  if (state === "deleted") {
    if (action === "delete") return "deleted";
    throw new Error("Deleted tickets cannot be modified.");
  }
  if (action === "delete") return "deleted";
  const next = transitions.get(String(state) + ":" + String(action));
  if (!next) throw new Error("Invalid ticket transition: " + state + " -> " + action);
  return next;
}
