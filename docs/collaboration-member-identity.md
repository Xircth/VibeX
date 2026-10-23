# Collaboration member identity (phase 1)

Phase 1 separates *who* a collaborator is (a **member**) from *where* it talks
(a **thread**). Each `(member, thread)` pair owns exactly one conversation.

## Tables (`20261024010000_collaboration_member_identity.sql`)

| table | purpose |
| --- | --- |
| `collaboration_members` | one row per member: name, `role_id`, agent, workspace |
| `collaboration_threads` | `group` threads (id = space id) and `direct` threads (id = `direct:<member_id>`) |
| `collaboration_thread_members` | PK `(thread_id, member_id)`, `conversation_id` UNIQUE, `last_seen_message_id`, `status` |
| `member_activity` | per-member activity log (empty in phase 1) |
| `member_facts` | per-member facts, scope `global`, `private` or `thread:<id>` (empty in phase 1) |

`collaboration_space_members` stays and is the seat projection that delivery,
receipts and dedupe still read. A seat's `conversation_id` always equals the
binding of its `(member, thread)` once resolved.

## Data migration

`MemberIdentityMigration::run` (called from `db::run_migrations`) is
idempotent; every insert is `ON CONFLICT DO NOTHING` and ids are derived:

* member id = UUIDv5(`vibex-member:<conversation>`), inheriting name and
  `role_id` from `conversation_personas` (else the session name).
* every space becomes a group thread with the same id, so its messages,
  deliveries and receipts need no rewrite.
* seats in the undecided space (`unassigned:<workspace>`) become the member's
  direct thread.
* seats are walked in join order (`rowid`). A conversation seated in several
  spaces keeps the original conversation for the earliest-joined space; every
  later space gets a new conversation in the same workspace (id
  UUIDv5(`vibex-member-thread:<member>:<thread>`), persona copied) and that
  seat is repointed to it.
* seats whose session or space is gone are skipped.

## Runtime

* `resolve_session(member_id, thread_id) -> conversation_id` creates the
  conversation when missing (db crate does rows; conversations crate adds the
  persona notice and role mode/config).
* space delivery (`post_to_space*`) resolves each seat through its identity
  before submitting; delivery/receipt/dedupe logic is unchanged.
* `send_session_input` accepts `member_id` + `thread_id` instead of
  `conversation_id`; the host resolves (workspace checked) and then sends.
* the single-space restriction is gone: moving a member into a space no
  longer removes it from the workspace's other spaces. Joining a second space
  creates a new conversation for that thread.
* an agent creating a space joins with its own conversation; if that
  conversation is already bound to a live seat elsewhere the new seat is a
  legacy shared seat (no binding) — see risks.

## Rollback

The change is additive. To roll back, deploy the previous build and drop the
five tables (`DROP TABLE collaboration_thread_members, collaboration_threads,
collaboration_members, member_activity, member_facts`) and delete the
`_sqlx_migrations` row for `20261024010000`. Repointed seats still reference
valid sessions, so the old code keeps working; the forked conversations remain
as ordinary conversations (one per extra space) rather than being merged back.
