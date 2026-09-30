# Evix Ticket System Design

**Version:** 1.0.1
**Bot name:** Evix
**Repository:** SaylerX505/evix-bot

## Goal

Build a Discord-native ticketing system for Evix with TicketCord-like workflow semantics and a professional Components V2 UI inspired by the existing VDS-bot visual language, without AI or a dashboard.

## Product behavior

Evix provides configurable ticket panels using both Discord buttons and select menus. Every interactive option resolves through the same action layer, so UI type does not change ticket behavior.

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
- optional modal form shown before creation
- close behavior
- transcript behavior
- log destination

## Ticket lifecycle

1. User selects a configured button/select option.
2. If a form is configured, Evix presents the modal and validates its inputs.
3. Evix checks the guild configuration and whether the user already has an open ticket for that ticket type where required by configuration.
4. Evix creates the ticket channel under the configured category.
5. Channel permissions grant the ticket owner access, grant configured staff roles access, and deny @everyone access.
6. Evix sends the configured ticket welcome view and optional role mentions.
7. Staff can claim/unclaim, add/remove members, rename, lock/unlock, close, reopen, and generate transcripts according to permissions.
8. Close changes ticket state and either moves it to the configured closed category or leaves it in place, according to ticket type configuration.
9. Transcript and audit log events are generated according to configuration.
10. Delete permanently removes the channel after the configured close flow/confirmation.

Ticket state is persistent and recoverable after process restart.

## Staff/access model

Staff access is configured per ticket option instead of being globally hard-coded.

Two role concepts remain separate:
- staffRoles: roles allowed to view/handle the ticket.
- pingRoles: roles mentioned when the ticket opens.

Administrative commands use Discord permission checks plus the bot's ability to manage the target category/channel.

The bot must validate required Discord permissions before attempting channel creation or permission mutation and return an actionable error instead of leaving a partially-created ticket.

## Panels and Components V2

Panels support:
- buttons
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
- /ticket lock
- /ticket unlock
- /ticket delete

### Administration
- /ticket setup
- /ticket config
- /ticket logs
- /ticket panel create
- /ticket panel edit
- /ticket panel delete
- /ticket panel send
- /ticket panel reset

Command descriptions and option names must remain clear and Discord-native.

## Persistence

PostgreSQL is the source of truth.

The schema is additive and idempotent. Startup migrations must never drop ticket data.

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

Unique/partial constraints must prevent duplicate active ticket records for configurations where only one active ticket of a type is allowed.

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
- invalid modal submission
- stale panel message after configuration reset

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

The production implementation is released as **1.0.1**.

Implementation history should remain understandable and human-like. The preferred release shape is a focused implementation commit titled:

**release: 1.0.1 — launch Evix ticket system**

Tests/docs may be included in that release commit when they belong to the release.

## Success criteria

A fresh Evix deployment can:
- start without losing persisted configuration
- register global slash commands by default
- create a panel with buttons and/or a select menu
- map each option to CREATE_TICKET or NOTHING
- create private tickets with option-specific staff/ping roles
- support the complete ticket lifecycle
- generate logs/transcripts reliably
- survive restarts without losing ticket state/configuration
- present a clean Components V2 UI consistent with Evix branding
- pass the complete automated test suite and hard-debug verification
