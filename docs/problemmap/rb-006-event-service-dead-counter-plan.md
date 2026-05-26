# RB-006 Event Service Dead Counter State Plan

## Scope

- `crates/services/src/services/events.rs`
- `crates/local-deployment/src/lib.rs`
- ProblemMap documentation for the review ledger.

## Smell

`EventService` stores `entry_count` only to suppress dead-code warnings. The
actual fallback event-entry counter is owned by the SQLite update hook closure
created by `EventService::create_hook`, and the service instance never reads
that field.

## Behavior Lock

1. Run `cargo test -p services events --lib` before editing to compile the event
   module and preserve the current event-service test surface.
2. Run `cargo check -p services -p local-deployment` after editing to prove the
   constructor contract and local deployment wiring still compile together.
3. Use `rg` to prove `#[allow(dead_code)]` and the unused service field are gone
   while the hook-owned counter remains.

## Cleanup Order

1. Remove the dead `entry_count` field and `#[allow(dead_code)]` from
   `EventService`.
2. Remove the unused `entry_count` constructor argument from
   `EventService::new`.
3. Update the local deployment constructor call while leaving
   `EventService::create_hook` and its counter argument unchanged.
4. Run targeted and full verification gates.

## Explicit Non-Goals

- Do not change event patch semantics.
- Do not change SQLite preupdate/update hook behavior.
- Do not collapse `EventService` into `LocalDeployment`.
- Do not introduce new abstractions or dependencies.
