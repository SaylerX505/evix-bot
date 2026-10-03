import { query } from "./connection.js";

export async function addTicketMember(ticketId, userId, addedBy) {
  await query(
    "INSERT INTO ticket_members(ticket_id,user_id,added_by) VALUES($1,$2,$3) ON CONFLICT(ticket_id,user_id) DO NOTHING",
    [ticketId, userId, addedBy],
  );
}

export async function removeTicketMember(ticketId, userId) {
  await query(
    "DELETE FROM ticket_members WHERE ticket_id=$1 AND user_id=$2",
    [ticketId, userId],
  );
}

export async function listTicketMembers(ticketId) {
  const { rows } = await query(
    "SELECT user_id FROM ticket_members WHERE ticket_id=$1 ORDER BY added_at ASC, user_id ASC",
    [ticketId],
  );
  return rows.map((row) => row.user_id);
}
