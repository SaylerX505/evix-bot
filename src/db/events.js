import { query } from "./connection.js";

export async function addTicketEvent(ticketId, eventType, actorId, details = {}) {
  await query(
    "INSERT INTO ticket_events(ticket_id,event_type,actor_id,details) VALUES($1,$2,$3,$4::jsonb)",
    [ticketId, eventType, actorId, JSON.stringify(details)],
  );
}

export async function listTicketEvents(ticketId) {
  const { rows } = await query(
    "SELECT * FROM ticket_events WHERE ticket_id=$1 ORDER BY created_at ASC, id ASC",
    [ticketId],
  );
  return rows;
}
