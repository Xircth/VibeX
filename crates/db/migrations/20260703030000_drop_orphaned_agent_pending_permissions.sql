-- Complete the 批次D1 shadow-table retirement (ADR-0002).
--
-- `agent_pending_permissions` (+ its two indexes) was part of the first-generation
-- ACP shadow group created in 20260613000000_agent_session_core_foundation.sql, but was
-- missed by 20260703020000_drop_agent_runtime_tables.sql. Its only writer/reader lived in
-- the now-deleted `persist_agent_event` / `agent_permissions` snapshot merge, so it is
-- dead schema — pending permissions are event-sourced in `conversation_events` and voided
-- on startup recovery (ADR-0001). Dropping the table drops its indexes too.

DROP TABLE IF EXISTS agent_pending_permissions;
