    if (!ticket.claimed_by) return respond(interaction, buildActionResult("Ticket Unclaimed", "This ticket is not currently claimed."));
    const next = await updateTicket(ticket.id, { claimed_by: null, claimed_at: null }, { statuses: ["open"], claimedBy: ticket.claimed_by });
    if (!next) throw new Error("This ticket was changed by another staff member. Please try again.");
    await respond(interaction, buildActionResult("Ticket Unclaimed", "The ticket is available for another staff member to claim."));
    void addTicketEvent(ticket.id, "TICKET_UNCLAIMED", interaction.user.id, { previous_claim: ticket.claimed_by })
      .catch((error) => console.error("[evix-ticket-unclaim-event-error]", error));
    void this.refreshControlMessage(interaction, next, { fallbackToKnownState: true, ticketIsFresh: true })
      .catch((error) => console.error("[evix-ticket-refresh-after-unclaim-error]", error));
    void writeTicketLog(interaction.guild, next, "TICKET_UNCLAIMED", interaction.user.id)
      .catch((error) => console.error("[evix-ticket-unclaim-log-error]", error));
    return next;
  }

  async requestClose(interaction, ticket) {
    ticket = await this.getFreshTicket(interaction, ticket);
    if (!this.canClose(interaction.member, ticket)) throw new Error("Only the ticket owner or configured staff can close this ticket.");
    if (ticket.status === "closed") {
      await this.refreshControlMessage(interaction, ticket, { closed: true, closedBy: ticket.closed_by, ticketIsFresh: true });
      return respond(interaction, buildActionResult("Ticket Already Closed", "This ticket is already closed. Use the controls on the closed ticket message."));
    }
    if (ticket.status === "deleted") throw new Error("This ticket has been deleted.");
    return respond(interaction, buildCloseConfirmation(ticket));
  }

  async close(interaction, ticket, { reply = true, closedBy = null, backgroundSideEffects = true } = {}) {
    ticket = await this.getFreshTicket(interaction, ticket);
    if (!this.canClose(interaction.member, ticket)) throw new Error("Only the ticket owner or configured staff can close this ticket.");
    if (ticket.status === "closed") {
      await this.refreshControlMessage(interaction, ticket, {
        closed: true,
        closedBy: ticket.closed_by,
        ticketIsFresh: true,
      });
      if (reply) {
        await respond(interaction, buildActionResult("Ticket Already Closed", "This ticket is already closed. Use the controls on the closed ticket message."));
      }
      return ticket;
    }
    if (ticket.status === "deleted") throw new Error("This ticket has been deleted.");
    transitionTicket(ticket.status, "close");

    let next = await updateTicket(ticket.id, {
      status: "closed",
      closed_at: new Date(),
      closed_by: closedBy || interaction.user.id,
      claimed_by: null,
      claimed_at: null,
    }, { statuses: ["open"] });
    if (!next) throw new Error("This ticket was already closed by another action.");
