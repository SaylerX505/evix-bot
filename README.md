# Evix

Professional Discord ticketing system for Evix.

Evix 1.0.2 provides a Discord-native ticket workflow with a clean Components V2 UI, configurable panels, buttons, select menus, forms, role-based access, transcripts, and audit logs.

## Requirements

- Node.js 22+
- PostgreSQL 14+
- A Discord application with the bot installed
- Bot permissions: View Channels, Send Messages, Read Message History, Manage Channels, Attach Files, Embed Links

## Environment

Copy `.env.example` to `.env`:

```env
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DATABASE_URL=
NODE_ENV=production
```

## Run

```bash
npm install
npm run check
npm test
npm run deploy
npm start
```

Commands are registered globally by `npm run deploy`.

## Commands

General:
- `/ticket info`
- `/ticket transcript`

Ticket actions:
- `/ticket close`
- `/ticket reopen`
- `/ticket claim`
- `/ticket unclaim`
- `/ticket add`
- `/ticket remove`
- `/ticket rename`
- `/ticket delete`

Administration:
- `/ticket setup`
- `/ticket config`
- `/ticket logs`
- `/panel create`
- `/panel edit`
- `/panel list`
- `/panel send`
- `/panel reset`
- `/panel delete`
- `/panel option-add`
- `/panel option-edit`
- `/panel option-remove`

### Role input

For staff/ping role lists, use Discord role mentions separated by spaces, for example:

```text
<@&123456789012345678> <@&987654321098765432>
```

## Ticket behavior

Panel options support:

- `CREATE_TICKET`
- `NOTHING`

`NOTHING` is useful for a reset/no-op dropdown entry. `CREATE_TICKET` creates a private channel with the option's configured category, staff roles, ping roles, naming template, welcome message, forms, transcript behavior, and close behavior.

The database is PostgreSQL and startup schema creation is additive/idempotent. Existing ticket data is never dropped by startup.

### Ticket forms

`/panel option-add` and `option-edit` accept an optional JSON `form` field with up to five inputs:

```json
[
  { "id": "reason", "label": "What do you need help with?", "style": "paragraph", "required": true },
  { "id": "order", "label": "Order ID", "required": false }
]
```

## UI

Evix uses Discord Components V2 with Containers, Text Displays, Separators, Buttons, Select Menus, and Action Rows for the panel and ticket views. Components V2 messages use the `MessageFlags.IsComponentsV2` flag; normal content/embeds are not mixed into those V2 messages.

## Safety and lifecycle

Delete actions use a confirmation step. Ticket control messages are refreshed after claim, lock, unlock, close, and reopen actions. The global per-member open-ticket limit remains enforced even when a ticket type allows multiple tickets of that type.

## Release

Version: `1.0.2`
