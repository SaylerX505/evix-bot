# Evix Database Deep Audit & Refactor

Date: 2026-10-03
Branch: refactor/database-deep-audit
Base: main

## Goal

Split the monolithic `src/db.js` into focused modules while preserving the public DB API through a compatibility facade. Reduce unnecessary PostgreSQL work, make startup migrations one-time/versioned, add safe in-process caching for read-heavy configuration, preserve correctness under concurrent ticket creation/actions, and remove ticket-channel status renames.

## Architecture

```
src/db.js                 compatibility facade / stable exports
src/db/
  connection.js           Pool, query, transaction, lifecycle
  schema.js               versioned migrations and schema bootstrap
  cache.js                TTL cache + single-flight helpers
  settings.js             guild settings CRUD/cache
  panels.js               panels/options CRUD/cache
  tickets.js              ticket reads/writes/limit lock
  members.js               ticket members
  events.js                ticket events
```

PostgreSQL remains the source of truth for mutable ticket state. Memory is used only for bounded, invalidatable configuration/index data and request coalescing.

## Test-first work

1. Add regression tests for settings partial UPSERT/concurrency, cache hit/invalidation, single-flight reads, ticket-channel index behavior, event ordering, and migration versioning.
2. Add ticket-channel naming regressions proving creation uses the final name and close/reopen do not rename.
3. Add any DB boundary tests needed for new module contracts.
4. Verify the new tests fail against the current implementation where expected.
5. Implement the smallest changes required to make them pass.

## Database refactor

- Replace repeated startup DDL/data rewrites with a versioned migration runner using `schema_migrations`.
- Keep the first migration safe for existing databases and preserve ticket rows.
- Migrate legacy alias columns to canonical values once, then remove obsolete columns.
- Add/retain DB constraints needed by current domain rules, including ticket close behavior.
- Replace redundant ticket indexes with workload-oriented indexes and deterministic event ordering support.
- Keep member/event foreign-key indexes.
- Keep the per-member ticket-limit transaction lock; use a 64-bit advisory hash to reduce collision risk.
- Replace settings read/merge/write transaction with an atomic whitelist-based partial UPSERT.
- Remove unused/dead DB APIs where there are no callers after the audit.

## Memory strategy

- Guild settings: bounded TTL cache + immediate invalidation after successful write.
- Panel configuration: bounded TTL cache + invalidation after panel/option mutation.
- Live ticket channel lookup: bounded in-process index for known ticket channels and negative routing fast-path where safe.
- Single-flight identical reads so concurrent requests share one DB query.
- Cache values are copied before returning so callers cannot mutate cached state.
- No broad mutable-ticket-row cache for authorization/mutations; those paths keep fresh DB reads.

## Ticket workflow

- Remove status-based channel naming entirely.
- Create the Discord channel once with the final sanitized/template name.
- Close/reopen no longer call Discord `setName`.
- `/ticket rename` sets exactly the sanitized user name, without a status prefix and without the old rename queue.
- Preserve ticket key generation and all existing lifecycle/event/log behavior.

## Validation / final audit

- Review every changed file for imports, circular dependencies, stale exports, SQL placeholder alignment, migration ordering, rollback behavior, cache invalidation, and race conditions.
- Run syntax checks and the full Node test suite through GitHub Actions.
- Inspect the final diff against `main` for accidental behavior changes and redundant work.
