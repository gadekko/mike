# Durable job claims

`public.db_jobs` owns durable job state. Redis/BullMQ's `app-jobs` queue
delivers IDs faster; PostgreSQL polling recovers lost deliveries. Both paths
must claim through PostgreSQL and use the same settlement rules.

## Scope and invariants

This work is the claim-correctness foundation for [#277](https://github.com/open-legal-products/mike/issues/277).
It does not complete that issue's OCR reference or add schedules, workflow
definitions, user APIs, or a new production job kind.

The existing registry contains `audit.chat_turn`, `account.delete`,
`storage.cleanup`, `document.cleanup`, `export.build`, `conversion.convert`,
`extraction.extract`, `mcp.refresh_token`, `document.precompute_text`, and
`memory.consolidate`. They retain their existing execution policies. Cleanup
must retain indefinite retries, durable object pointers and independently
fenced coalesced sibling claims.

A claim is identified by row ID, attempt and `claimed_at`; settlement also
requires `status = running`. Never renew `claimed_at`. A nullable separate
`heartbeat_at` can extend the lease only for an explicitly opted-in handler.
Old workers and rows without a heartbeat retain the 600-second stale window.

Settlement has three outcomes: committed (exactly one matching row), lost
ownership (zero rows), or unknown (database/transport failure). Only confirmed
settlement may invoke a terminal-failure hook or arrange retry delivery.
Handler failure and persistence failure are separate outcomes. Neither a
successful HTTP transport nor absence of an exception proves a row changed.

An opted-in handler needs a finite execution deadline, an abort signal and
single-flight, bounded renewals. Expiry must be checked against database time
after acquiring the claim lock, including when no replacement worker exists.
An uncertain renewal stops the controller; it does not release the claim early.
Stopping renewal does not physically terminate arbitrary JavaScript or undo
external effects. Domain writers still need their own idempotency, access,
cancellation and generation fences.

Shutdown stops new claim intake on both delivery paths before awaiting drains.
A claim request already in flight can still commit. If it returns after intake
closed, do not start its handler; recovery occurs through lease expiry. Keep
the standalone worker's existing keepalive and bounded force-exit behavior.

## Acceptance contract

| Case | Required proof |
|---|---|
| Q01 | Current claimant settles success exactly once. |
| Q02 | Reclaimed worker cannot settle, invoke a hook or redeliver. |
| Q03 | Returned/thrown settlement errors do not become handler retries. |
| Q04 | Hooks, retry delivery and deferred attempt refunds require confirmed settlement. |
| Q05 | Renewal preserves claim identity; expired claims cannot renew/settle, including after lock waits. |
| Q06 | Renewal protects a live worker; actual killed-worker work becomes recoverable. |
| Q07 | Old/NULL heartbeat, cleanup exceptions, pending times and claim-by-kind retain semantics. |
| Q08 | Poll and Redis delivery have one database owner; polling covers lost delivery. |
| Q09 | Deadline/uncertainty closes renewal; late bodies cannot settle or leak timers. |
| Q10 | Coalesced siblings settle independently and retain cleanup pointers on failure. |
| Q11 | RPC privileges, index and fresh/upgraded schemas agree. |
| Q12 | Initial timers, in-flight claims, repeated stop/start and force-exit preserve shutdown boundaries. |
| Q13 | Existing domain job and architecture checks remain green. |
| Q14 | New diagnostics exclude payloads, text, credentials and object paths. |

Unit checks establish state-machine behavior. Real PostgreSQL/PostgREST and
separate worker processes must establish locking, permissions, migration and
crash recovery; a skipped stack suite does not establish those properties.

## Operational boundaries

The production opt-in policy map remains empty in this first increment.
Apply the additive migration before updated workers. Retain the added schema
on a code rollback. Do not disable the entire queue to stop one future feature:
`DB_JOBS_ENABLED=false` also disables cleanup and other existing durable work.
Use `WORKERS_MODE=none` on the API when running the existing standalone worker.

Before adding OCR, upgrade every queue consumer, including embedded worker
threads. Old consumers may terminally fail an unfamiliar kind. Disable new
producers and drain/cancel their queued work before rolling back consumer code.

Failure hooks remain best effort: a crash after terminal settlement can omit a
hook, and SQL's abandoned-attempt sweep does not execute JavaScript hooks.
Future OCR state must reconcile terminal queue rows, not rely only on hooks.
