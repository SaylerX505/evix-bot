# Evix Ticket System Design

**Version:** 1.0.3
**Bot name:** Evix
**Repository:** SaylerX505/evix-bot

## Goal

Build a Discord-native ticketing system for Evix with TicketCord-like workflow semantics and a professional Components V2 UI inspired by the existing VDS-bot visual language, without AI or a dashboard.

## Product behavior

Evix provides configurable ticket panels using Discord select menus. Ticket lifecycle controls use buttons; panel options resolve through the same action layer.

Supported panel actions:
- CREATE_TICKET: creates a private ticket channel using the option's configuration.
- NOTHING: acknowledges the interaction and performs no ticket creation.

Each ticket type can independently define:
- label, description, emoji
- ticket category
- staff roles
- ping roles
- ticket channel naming template
- initial/welcome message
- optional legacy modal form retained on existing options
- close behavior
- log destination

## Ticket lifecycle

1. User selects a configured dropdown option.
2. If a form is configured, Evix presents the modal and validates its inputs.
3. Evix checks the guild configuration and whether the user already has an open ticket for that ticket type where required by configuration.
4. Evix creates the ticket channel under the configured category.
5. Channel permissions grant the ticket owner access, grant configured staff roles access, and deny @everyone access.
6. Evix sends the configured ticket welcome view and optional role mentions.
7. Staff can claim/unclaim, add/remove members, rename, close, reopen, and generate transcripts according to permissions. Manage Channels is accepted as a ticket-management override.
8. Close changes ticket state and either moves it to the configured closed category or leaves it in place, according to ticket type configuration, and replaces the public control message with the closed-ticket view.
9. Transcripts are manual-only via `/ticket transcript` or `Get Transcript` on a closed ticket. Visible audit logs are limited to Open, Claimed, Closed, Deleted, and Transcript.
10. Delete requires confirmation, marks the ticket deleted transactionally, and removes the channel; it does not run the close workflow first.

Ticket state is persistent and recoverable after process restart.

## Staff/access model

Staff access is configured per ticket option instead of being globally hard-coded.

Two role concepts remain separate:
- staffRoles: roles allowed to view/handle the ticket.
- pingRoles: roles mentioned when the ticket opens.

Administrative commands use Discord permission checks plus the bot's ability to manage the target category/channel.

The bot validates required Discord permissions before ticket creation or permission mutation where possible, compensates failed resource creation, and uses conditional persistence to prevent duplicate/racing state mutations.

## Panels and Components V2

Panels support:
- select menus
- multiple panels per guild
- configurable embed/content styling
- persistent message/channel identifiers
- per-option configuration

UI uses Discord Components V2 with a clean Evix visual system derived from the VDS pattern:
- ContainerBuilder
- TextDisplayBuilder
- SeparatorBuilder
- SectionBuilder where useful
- ActionRowBuilder for interactive components
- LabelBuilder for modal fields
- no dashboard
- no banner image required
- restrained dark/premium presentation
- consistent footer/branding text

The UI layer must not contain database/business rules.

## Commands

### General
- /ticket info
- /ticket transcript

### Ticket actions
- /ticket close
- /ticket reopen
- /ticket claim
- /ticket unclaim
- /ticket add
- /ticket remove
- /ticket rename
- /ticket delete

### Administration
- /ticket setup
- /ticket config
- /ticket logs
- /panel create
- /panel edit
- /panel list
- /panel delete
- /panel send
- /panel reset
- /panel option-add
- /panel option-edit
- /panel option-remove

Command descriptions and option names must remain clear and Discord-native. Panel and option references use Discord autocomplete selectors instead of manually entered numeric IDs.

## Persistence

PostgreSQL is the source of truth.

The schema is idempotent and preserves ticket rows across startup migrations. Obsolete legacy state/setting columns may be normalized or removed without deleting ticket records.

Core persisted entities:
- guild_ticket_settings
- ticket_panels
- ticket_panel_options
- tickets
- ticket_members
- ticket_events

Identifiers use Discord IDs stored as text. JSON/JSONB is allowed for flexible UI/form configuration, but core searchable fields remain first-class columns.

Indexes must support:
- guild lookup
- open tickets by guild/user
- tickets by channel
- events by ticket
- panels by guild

Unique/partial constraints prevent duplicate active ticket records for configurations where only one active ticket of a type is allowed, while the per-member global ticket limit is enforced transactionally.

## Reliability and error handling

Interaction handling must acknowledge every interaction exactly once.

All handlers must:
- validate interaction type/custom ID
- validate guild context where required
- validate authorization
- validate referenced configuration exists
- validate Discord permissions
- handle missing/deleted channels, categories, roles, and log channels
- avoid throwing uncaught errors from interaction callbacks
- log structured error context without secrets

Ticket creation should behave transactionally at the application level:
- persist only after Discord resources are confirmed, or
- compensate/delete the Discord channel if persistence fails after creation.

Close/delete operations must be idempotent.

Transcript generation must tolerate empty channels and deleted attachments without crashing.

## Debugging and verification

Implementation follows TDD for production logic.

Required verification layers:
- unit tests for pure configuration validation, naming, permissions, state transitions, and event normalization
- interaction/component tests for routing and one-response acknowledgement
- database tests for additive schema behavior and persistence semantics
- UI tests for Components V2 layout limits and modal structure
- syntax/runtime verification
- full project test suite
- final hard-debug pass focused on Discord edge cases and race conditions

Failure cases explicitly covered:
- missing configuration
- malformed panel option
- deleted category/role/log channel
- insufficient bot permissions
- duplicate ticket creation race
- close/reopen repeated clicks
- deleted ticket channel
- transcript with no messages
- interaction expiry/late acknowledgement
- invalid/legacy modal submission
- stale panel message after configuration reset
- control refresh with stale DB state
- failed control replacement without reintroducing unsafe controls

## Scope exclusions

Version 1.0.1 does not include:
- AI
- web dashboard
- external ticket CRM
- billing
- analytics dashboard
- voice tickets
- automated sentiment/classification
- non-Discord ticket ingestion

## Release

The production implementation is released as **1.0.2**.

Implementation history should remain understandable and human-like. The preferred release shape is a focused implementation commit titled:

**release: 1.0.1 — launch Evix ticket system**

Tests/docs may be included in that release commit when they belong to the release.

## Success criteria

A fresh Evix deployment can:
- start without losing persisted configuration
- register global slash commands by default
- create a dropdown panel
- map each option to CREATE_TICKET or NOTHING
- create private tickets with option-specific staff/ping roles
- support the complete ticket lifecycle
- generate manual transcripts and the five supported visible lifecycle logs reliably
- survive restarts without losing ticket state/configuration
- present a clean Components V2 UI consistent with Evix branding
- serialize per-ticket mutation and channel-rename races
- reconcile externally deleted ticket channels
- pass the complete automated test suite and hard-debug verification
