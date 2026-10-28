# SyncSpace --- Detailed Engineering Specification

**Version:** 4.0\
**Status:** Implementation blueprint\
**Product type:** Real-time collaborative project-management workspace\
**Primary engineering focus:** Authorization, transactional consistency,
concurrency control, durable events, and recoverable real-time
synchronization

------------------------------------------------------------------------

## 1. Executive summary

SyncSpace is a web application for small teams to organize projects on
collaborative boards. Members create tasks, move them between status
columns, assign work, comment, and see updates from other connected
users without manually refreshing the page.

The goal is not to build another feature-heavy project-management
platform. The goal is to build a focused, dependable collaboration
product and demonstrate the engineering behind it: permission
boundaries, stale-write handling, atomic task moves, transactional event
publication, reconnect recovery, and meaningful automated tests.

**Core architectural rule:** PostgreSQL is the source of truth. A domain
mutation and its corresponding project event commit in the same database
transaction. WebSockets deliver notifications about committed events;
they are not the durable record and are not relied upon for guaranteed
delivery.

The application is a modular monolith deployed as a long-running Node.js
process with PostgreSQL. It does not require microservices, Kafka,
Kubernetes, Redis, or a fine-tuned AI model.

## 2. Problem statement

Teams using a shared project board need a reliable way to coordinate
work. In ordinary collaborative interfaces, concurrent edits can
overwrite one another, users can see stale ordering, reconnecting
clients can miss changes, and weak authorization can expose data across
workspaces.

SyncSpace addresses this by combining a usable project board with
explicit consistency and recovery rules. It makes collaboration visible
while preserving database correctness when requests overlap, connections
fail, or clients retry operations.

## 3. Goals and non-goals

### 3.1 Goals

1.  Allow authenticated users to create workspaces and collaborate on
    projects.
2.  Provide a kanban board with tasks, status columns, assignments,
    comments, and activity history.
3.  Enforce workspace and project access on every HTTP request and
    WebSocket subscription.
4.  Prevent lost updates and make task moves atomic under concurrent
    requests.
5.  Record each externally visible project mutation in a durable,
    ordered event stream.
6.  Deliver live updates to connected clients and recover missed events
    after reconnect.
7.  Make retries safe for designated mutation endpoints through
    idempotency keys.
8.  Include automated unit, integration, concurrency, security, and
    end-to-end tests.
9.  Deploy to infrastructure that supports a persistent Node process and
    PostgreSQL.

### 3.2 Non-goals for v1

-   Workspace deletion in v1; a future version may implement soft
    deletion using `workspaces.deleted_at`.
-   Reservations, bookings, or inventory management.
-   Guest accounts, public boards, or anonymous access.
-   Private projects inside a workspace. Workspace members can access
    all projects in that workspace.
-   Presence indicators, typing indicators, and collaborative cursors.
-   Email or push notifications.
-   Attachments, file storage, and rich document editing.
-   Microservices, Kafka, Kubernetes, Redis, or a separate
    event-streaming platform.
-   AI fine-tuning or LoRA training.
-   Complex workflow automation, custom fields, and advanced reporting.

These are intentionally excluded so that correctness and testing are
completed before the scope expands.

## 4. Product model and authorization decisions

### 4.1 Roles

There are three workspace roles:

-   **Owner:** full control over the workspace, including ownership
    transfer and workspace settings.
-   **Admin:** manages workspace membership and projects, and can manage
    all project content.
-   **Member:** can view projects and create or edit project content,
    but cannot administer workspace membership.

A workspace has exactly one owner. Each project belongs to exactly one
workspace. Workspace membership grants access to every project in that
workspace; there are no separate project-membership restrictions in v1.

### 4.2 Permission matrix

  Action                             Owner                    Admin             Member
  -------------------------------- ------- ------------------------ ------------------
  View workspace and projects          Yes                      Yes                Yes
  Update workspace name/settings       Yes                      Yes                 No
  Invite/add workspace member          Yes                      Yes                 No
  Change member role                   Yes   Yes, except owner role                 No
  Remove a member                      Yes        Yes, except owner                 No
  Transfer workspace ownership         Yes                       No                 No
  Create project                       Yes                      Yes                Yes
  Rename/archive/restore project       Yes                      Yes                 No
  View board and task history          Yes                      Yes                Yes
  Create task/comment                  Yes                      Yes                Yes
  Edit task fields                     Yes                      Yes                Yes
  Move/reorder task                    Yes                      Yes                Yes
  Archive task                         Yes                      Yes                Yes
  Restore archived task                Yes                      Yes                Yes
  Delete a comment                     Yes                      Yes   Own comment only

**Implementation rule:** permissions are checked in the service layer
using the authenticated user ID and the resource's workspace ID. Never
trust a workspace/project ID supplied by the client as proof of access.
Every WebSocket subscription performs the same authorization check.
Tests must verify that a user from workspace A cannot read or mutate
workspace B's data.

An admin cannot demote, remove, or otherwise take control of the owner.
Owner transfer is a single transaction that changes the owner role and
the workspace owner ID together.

## 5. Core user journeys

1.  A user signs in and creates a workspace.
2.  The owner adds teammates and assigns roles.
3.  A workspace member creates a project and opens its board.
4.  Members create tasks, edit titles/descriptions, assign tasks, add
    comments, and move tasks between status columns.
5.  Connected clients receive project events and update their views.
6.  A disconnected client reconnects with its last applied event
    sequence and fetches missed events.
7.  When an edit conflicts with a newer edit, the client receives a
    clear conflict response and can refresh/reapply rather than silently
    overwriting data.
8.  A member archives a task; the task disappears from the active board
    but remains in history and can be restored.

## 6. Functional requirements

### 6.1 Authentication and sessions

-   Use an established authentication library, Better Auth, rather than implementing password/session infrastructure from
    scratch.
-   If password credentials are enabled, passwords must be hashed with
    Argon2id using the library's supported secure configuration.
-   Use secure, HttpOnly cookies in production, with appropriate
    `SameSite` and `Secure` attributes.
-   Mutating cookie-authenticated requests must have CSRF protection.
    Validate `Origin` and use the auth library's supported CSRF
    mechanism or an equivalent synchronizer/double-submit design.
-   WebSocket handshakes must validate the `Origin` against an explicit
    allowlist and authenticate the session before accepting a
    connection.
-   Sessions must be revocable. Membership removal must take effect for
    subsequent API requests and WebSocket authorization checks.

### 6.2 Workspaces and membership

-   Create and rename a workspace. Workspace deletion is out of scope
    for v1; a future version may implement soft deletion using
    `workspaces.deleted_at`.
-   Add existing registered users by email; v1 does not send invitation
    emails. Only owners/admins may use this endpoint. Rate-limit it and
    return a generic response that reveals no more information than
    necessary about whether an email is registered or already belongs to
    the workspace.
-   Change member roles and remove members according to the permission
    matrix.
-   Show the current member list and role.

### 6.3 Projects and boards

-   Create, rename, and archive projects.
-   Each project has a fixed set of status columns in v1: `Backlog`,
    `Todo`, `In Progress`, and `Done`.
-   A task's `status` is represented by its `column_id`; there is no
    separate task status field that can disagree with the column.
-   Column definitions are project-scoped and have a stable ordering.
-   Archived projects are read-only and excluded from the default
    active-project list. Mutations in an archived project return
    `409 PROJECT_ARCHIVED`; owner/admin can restore it through
    `POST /api/projects/:projectId/restore`, which emits
    `project.restored`.

### 6.4 Tasks

A task contains at least:

-   ID, project ID, column ID, title, description, creator ID, optional
    assignee ID.
-   Rank key used for ordering within a column.
-   Version number used for stale-write detection.
-   Created, updated, and archived timestamps.
-   Optional due date.

Task operations:

-   Create, read, edit, archive, and restore.
-   Assign or unassign a workspace member.
-   Move between columns and reorder within a column.
-   View comments and event history.
-   Filter by column, assignee, and due date.
-   Search task titles and descriptions using PostgreSQL full-text
    search.

### 6.5 Comments

-   Members can add comments to active tasks.
-   A comment author can delete their own comment; owner/admin can
    delete any comment.
-   Deletion is a soft deletion: the comment row remains with
    `deleted_at` set, and the comments API hides deleted content from
    normal responses. `comment.created` and `comment.deleted` events
    contain IDs and metadata only, never comment bodies; clients fetch
    bodies from the comments API.
-   Comment creation and deletion are project mutations and produce
    durable project events.

### 6.6 Real-time updates

-   Workspace-level changes (workspace rename, membership changes, and
    project creation) are not delivered as project events in v1; clients
    refetch on navigation. Before sending project data to a socket, the
    server checks current workspace membership and role directly against
    PostgreSQL. Member removal or role change emits `NOTIFY` on the dedicated
    `membership_changes` channel in the same transaction and triggers prompt
    re-authorization or disconnection of affected sockets. No membership
    authorization cache is used in v1.
-   Clients connect to a WebSocket endpoint after authentication.
-   Clients subscribe only to projects they are authorized to view.
-   Each successful project mutation creates a durable event in the same
    transaction.
-   Each mutation issues PostgreSQL `NOTIFY` with `(project_id, seq)`
    inside the transaction; PostgreSQL delivers it only after commit.
    Every app instance independently reads committed events after its
    instance delivery cursor and sends them to its local authorized
    sockets. Each instance also polls periodically to recover missed
    notifications. Each client maintains its own cursor and can use the
    catch-up endpoint after reconnect.
-   WebSocket messages contain event metadata and the canonical payload.
    Every `task.*` event carries the full after-state task snapshot,
    including `version`. Comment event payloads contain IDs and metadata
    only, never comment bodies.
-   Delivery is at-least-once. Clients deduplicate by
    `(project_id, seq)` and apply only events newer than their last
    applied sequence.
-   If a client detects a sequence gap, it fetches missed events through
    the catch-up endpoint before applying later events.
-   If the catch-up window has expired or the client has no valid
    cursor, it reloads the relevant project snapshot and resumes from
    the returned sequence.

Workspace-level changes are not delivered as project events in real time;
clients refetch workspace/project lists on navigation. Before delivering
project data to a WebSocket, each instance checks current workspace membership
and role directly against PostgreSQL. Membership changes issue `NOTIFY` on the
dedicated `membership_changes` channel in the same transaction. Each instance
listens on that channel and immediately re-authorizes or disconnects affected
sockets. The notification provides prompt revocation; the database check is
the authorization source of truth. No membership authorization cache is used
in v1.

### 6.7 Activity history

The `project_events` table is the canonical activity history. The UI
presents a human-readable timeline for task creation, edits, moves,
archive/restore, assignment changes, and comments. Event records are
append-only during normal application operation.

### 6.8 AI-assisted task extraction (optional, after core correctness)

The optional AI feature turns pasted meeting notes into draft task
suggestions with title, description, assignee hint, and due-date hint.

-   AI output is never written directly into project state.
-   The output must conform to a strict JSON schema; invalid output is
    rejected or repaired with a bounded retry.
-   A user reviews, edits, and explicitly confirms each suggested task.
-   The initial version uses prompting with a hosted/local model and
    schema validation. Fine-tuning is not a project requirement.
-   Evaluation uses a small, manually labeled set of meeting notes and
    reports field-level precision/recall or exact-match rates, plus
    malformed-output rate.
-   AI must not bypass authorization, invent valid user IDs, or silently
    assign tasks.
-   If the AI feature threatens the 10-week delivery, omit it without
    affecting the core deliverables.

## 7. Explicit consistency and concurrency policy

This section is normative: all API handlers and tests must follow these
rules.

### 7.1 General transaction rule

Use PostgreSQL `READ COMMITTED` isolation and design each mutation
explicitly for that isolation level. Every mutation runs in a PostgreSQL
transaction that:

1.  Authenticates and authorizes the actor.
2.  Locks or conditionally updates the affected rows as required by the
    operation. For project-scoped idempotent creation, acquire the
    project row lock before checking the idempotency record.
3.  Checks the idempotency record before applying a creation mutation.
    If a matching key and request hash already exist, return the stored
    response without creating another domain record or event. If the key
    exists with a different request hash, return
    `409 IDEMPOTENCY_KEY_REUSED`.
4.  Validates current state and request preconditions, then applies the
    domain mutation.
5.  Locks the project's sequence counter, increments `last_seq`, and
    inserts the corresponding `project_events` row for a successful
    state-changing project mutation.
6.  Stores the idempotency key, request hash, response status, and
    response body in the same transaction when required by the endpoint.
7.  Issues PostgreSQL `NOTIFY` with `(project_id, seq)` inside the
    transaction. PostgreSQL delivers the notification only if the
    transaction commits.
8.  Commits. Polling recovers missed notifications.

If a concurrent duplicate request still races on the idempotency unique
constraint, the handler must catch that specific conflict, re-read the
committed idempotency record in a new statement/transaction, compare
request hashes, and return the stored response only for a matching hash.
See Section 7.5. If the transaction fails, neither the domain mutation
nor its event is committed. Real-time delivery failure cannot roll back
an already committed mutation.

### 7.2 Task field edits and versions

Tasks have a monotonically increasing integer `version`. Every
successful mutation that changes persisted task state, including a move,
increments this version exactly once. No-op moves are explicitly exempt.

Clients send `expectedVersion` for edits that are based on a previously
read task. The server uses a conditional update or row lock to ensure
that the expected version is current.

**Conflict rule:** v1 uses task-level optimistic concurrency. If any
mutation has changed the task since the client read it, a mutation
carrying an old `expectedVersion` is rejected with
`409 VERSION_CONFLICT`. This deliberately favors simple, predictable
behavior over automatic merging of independent fields. The response
includes the current version and enough current task data for the client
to refresh and let the user reapply the intended change.

Ordinary task edits and moves require `expectedVersion`. Archive and
restore are explicit user-invoked endpoints but do not require a client
`expectedVersion` in v1; each uses a transactional row lock/current-state
check, validates that the operation is legal for the current archive state,
and increments task version exactly once when state changes. Repeating an
archive on an already archived task or a restore on an active task is a
no-op and creates no event.

This means a priority/assignee edit can conflict with a simultaneous
move. That is an accepted v1 trade-off, documented to the user and
tested. Do not silently overwrite the newer state.

### 7.3 Atomic task moves and ordering

-   Tasks are ordered within a column using fractional rank keys
    (lexicographically sortable strings generated by a well-tested
    fractional-indexing implementation).
-   The move API accepts the destination column and an anchor task or
    neighboring task IDs; it does not accept an arbitrary rank string
    from the client.
-   The server authorizes both tasks, validates that the destination
    column belongs to the same project, locks the project sequence row
    and affected task rows in a consistent order, computes the rank,
    changes the column/rank, increments task version, and writes the normal
    task event in the transaction. If rank-key rebalancing is required, the
    transaction also writes the `column.rebalanced` event specified below.
-   Concurrent moves in the same project serialize through the
    per-project sequence counter row. The server recalculates rank
    against the current neighboring tasks after acquiring the lock.
-   If two tasks receive equal rank keys due to an
    implementation/library edge case, use a deterministic tie-breaker by
    task ID and schedule a rebalance.
-   Rebalance a column when a newly computed rank key would exceed 32
    characters. Rebalancing runs in the same transaction as the triggering
    move, preserves the exact visible task order, and assigns compact rank
    keys in that order.
-   A rebalance changes only the internal ordering representation; it does
    not increment task versions and does not create one `task.*` event per
    affected task. If a rebalance occurs, emit one `column.rebalanced` event
    containing `project_id`, `column_id`, and an ordered list of
    `{ task_id, rank_key }` pairs for every active task in the column after
    rebalancing but before the triggering move is applied. The triggering
    move emits its normal task event after the rebalance event. Both events
    receive consecutive project sequence numbers in the same transaction.
    Clients apply the rank map atomically before later events; snapshots
    always contain the current rank keys.
-   A move that changes column or effective position increments task
    version exactly once and creates one event. A move to the same
    column and same effective position is a no-op: it does not increment
    version and does not produce an event.

### 7.4 Archive and restore policy

Tasks are archived, not hard-deleted, in normal product workflows.

-   Archived tasks are excluded from active boards and normal search by
    default.
-   Archive and restore operations increment task version and create
    events.
-   Mutations to archived tasks are rejected with `409 TASK_ARCHIVED`,
    except restore and read-only history access.
-   Task IDs are never reused.
-   Hard deletion is reserved for an explicit account/workspace
    retention workflow and is outside v1. Event history must not be
    silently rewritten as part of ordinary task deletion.

### 7.5 Idempotency

The `request_hash` covers the HTTP method, the route with resolved path
parameters (including the relevant project ID or task ID), and the
canonicalized request body.

The following endpoints require an `Idempotency-Key` header: task
creation, comment creation, and any future endpoint whose retry could
create duplicate records.

-   The key is scoped to the authenticated actor and endpoint.
-   Use PostgreSQL `READ COMMITTED`. For project-scoped creation,
    acquire the project row lock before looking up the idempotency
    record. Store the key, request hash, response status, and response
    body in an `idempotency_records` table in the same transaction as
    the mutation.
-   Enforce uniqueness on `(actor_id, endpoint_key, idempotency_key)`.
    Under `READ COMMITTED`, if a concurrent duplicate hits the unique
    constraint, catch that specific conflict, re-read the committed
    record in a new statement/transaction, compare the request hash, and
    return the original response only if the hashes match. Otherwise
    return `409 IDEMPOTENCY_KEY_REUSED`; never surface the raw database
    error.
-   Reusing the same key with the same request hash returns the original
    response without repeating the mutation.
-   Reusing the same key with a different request hash returns
    `409 IDEMPOTENCY_KEY_REUSED`.
-   Records are retained for at least 24 hours. The cleanup job must not
    delete records still within the retention window.
-   Updates and moves use expected versions and transactional checks;
    idempotency keys are not a replacement for concurrency control.

## 8. Unified project event architecture

### 8.1 One table, three uses

There is exactly one canonical `project_events` table for v1. It serves
as:

1.  **Audit history:** records who changed project state and what
    happened.
2.  **Catch-up feed:** clients request events after their last applied
    sequence.
3.  **Durable notification source:** PostgreSQL `NOTIFY` wakes each
    instance, which reads the event table; polling recovers missed
    notifications.

There is no per-event publication flag, no publication-attempt counter, no claim/mark worker loop, no unpublished-events index, and no separate outbox table.

### 8.2 Per-project sequence allocation

**Known trade-off:** allocating a sequence by locking the project
counter serializes event-producing mutations within that project. This
is accepted for v1 because it provides a simple, testable committed
order. It may limit throughput for a very hot project; measure
contention before changing the design.

Do not use a plain PostgreSQL sequence as the client-facing project
cursor. Sequence values can be allocated by transactions that commit out
of order, which can cause a client to advance its cursor past an event
that commits later.

Each project has `last_seq BIGINT NOT NULL DEFAULT 0`. Every
event-producing transaction locks the project row (or a dedicated
per-project counter row) and increments `last_seq` inside the same
transaction. It then inserts the event with that sequence. The row lock
is held until commit or rollback, so the next writer for that project
cannot allocate a later sequence before the earlier transaction
resolves.

This creates a per-project serialization point. It is an intentional MVP
trade-off that makes the cursor ordering straightforward to reason about
and test. Use a dedicated `project_event_counters` table only if
contention measurements later justify separating the counter from the
project row; the counter must still be transactionally locked.

### 8.3 Event schema

Conceptual schema:

``` sql
CREATE TABLE project_events (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id),
  seq BIGINT NOT NULL,
  actor_id UUID NOT NULL REFERENCES users(id),
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, seq)
);

```

The SQL is illustrative and must be reconciled with the chosen migration
tool and actual foreign-key policy. Every v1 project event is caused by an
authenticated user mutation, so `actor_id` is required; system-generated
events are out of scope. `entity_type` must match the entity implied by
`event_type` (for example, `task.updated` requires `entity_type = 'task'`);
validate this in the event-writing layer or with a database constraint. The
unique constraint on `(project_id, seq)` supplies the catch-up index, so do
not create a duplicate index over the same columns. Event payloads must not contain
secrets, session data, or unnecessary personal information. Every
`task.*` event carries the full after-state task snapshot, including
`version`, and a `changes` object listing only changed fields as
`{ "field": { "from": ..., "to": ... } }`. For `task.created`, omit
`from`. For description changes, use
`{ "description": { "changed": true } }`; never include previous or new
description text in `changes`. Compute `changes` from the transaction's
before-state and after-state. The activity timeline renders from
`changes`. `comment.created` and `comment.deleted` payloads contain IDs
and metadata only, never comment bodies; clients fetch comment content
through the comments API, which hides deleted content. Workspace-level
changes are not stored in this per-project event stream.

### 8.4 Per-instance delivery algorithm

Each application instance maintains an in-memory delivery cursor per
project to avoid repeatedly scanning already processed events for its
local WebSocket subscribers. This cursor is only an optimization;
PostgreSQL remains authoritative. Each individual client also tracks its
own last contiguous applied sequence. A new socket/subscriber must
perform catch-up from its own cursor or load a consistent snapshot; it
must not inherit the instance cursor as proof that it has received prior
events.

1.  Register the PostgreSQL `LISTEN` subscription before reading the
    project's initial state.
2.  On a first subscription, read the project snapshot and `last_seq` in
    one `REPEATABLE READ`, read-only transaction. Initialize the instance's
    local delivery cursor to that snapshot's `last_seq` (never `0` by
    default), and initialize each client from the same snapshot sequence.
    Registering `LISTEN` first ensures commits during setup are represented
    in the snapshot or recovered by catch-up/polling.
3.  On `NOTIFY` carrying `(project_id, seq)`, read committed rows from
    `project_events` for that project with
    `seq > local_last_delivered_seq`, ordered by `seq`.
4.  Deliver each event to that instance's currently authorized local
    subscribers in ascending sequence order. Advance the instance cursor
    only after handing the event to the local delivery layer; client
    acknowledgements are not implied, so clients still deduplicate and
    catch up independently.
5.  Poll active/subscribed projects every 1 second for rows after each
    local cursor, querying only projects with local subscribers. This recovers
    from missed notifications, listener interruptions, and process restarts.
    Recovery latency may be up to one polling interval plus query and
    processing time.
6.  On startup or a new local subscription, reconcile from the client's
    cursor or a consistent snapshot; never assume an in-memory cursor
    survives a restart.
7.  Do not use `FOR UPDATE SKIP LOCKED`, claim events, or mark an event
    globally published. Every instance must independently deliver events
    to its own local sockets.

`NOTIFY` is issued inside the mutation transaction and PostgreSQL
delivers it only after commit. The notification is a wake-up signal
containing project ID and sequence, not the durable event itself. If
notifications are coalesced or lost, polling finds the durable rows. The
per-project sequence lets an instance read committed events in order.

**Delivery semantics:** delivery is at-least-once. An instance can send
an event and fail before updating its local cursor, causing a duplicate.
Clients deduplicate by `(project_id, seq)` and apply only contiguous
sequences. The server must not claim exactly-once WebSocket delivery.

### 8.5 Catch-up endpoint

`GET /api/projects/:projectId/changes?after=<seq>&limit=<n>`

-   Requires authenticated project membership.
-   Returns events with `seq > after`, sorted ascending by `seq`, capped
    at a maximum page size.
-   Returns `nextCursor`, `hasMore`, and the current committed project
    sequence.
-   The client advances its cursor only through a contiguous sequence of
    applied events.
-   If the requested cursor predates retained history (retention
    compaction is not part of v1), return a documented reset response
    requiring a fresh project snapshot.
-   Snapshot reads must return a consistent `snapshotSeq`: read
    `projects.last_seq` and all board data inside one PostgreSQL
    `REPEATABLE READ`, read-only transaction. The board snapshot and
    sequence must represent the same database snapshot; clients then
    fetch events after `snapshotSeq`.

### 8.6 Event payload and client application

Each event has an event type, entity identity, actor, sequence,
timestamp, and schema-versioned payload.

The canonical task snapshot carried by every `task.*` event contains:
`id`, `project_id`, `column_id`, `title`, `description`, `created_by`,
`assignee_id`, `rank_key`, `version`, `due_date`, `created_at`,
`updated_at`, and `archived_at`. Include nullable fields explicitly so
clients can clear old values. Do not embed comments, workspace
membership, or unrelated collections. For `task.archived`, the snapshot
includes `archived_at` and clients remove the task from the active
board. For `task.restored`, `archived_at` is null and the snapshot
contains enough data to place the task back into its column and order.
Example event types:

-   `task.created`
-   `task.updated`
-   `task.moved`
-   `task.archived`
-   `task.restored`
-   `comment.created`
-   `comment.deleted`
-   `project.updated`
-   `project.archived`
-   `project.restored`

Every `task.*` event carries the full after-state task snapshot and a
`changes` object as specified in Section 8.3. Comment events contain IDs
and metadata only, never comment bodies.

Clients apply an event only if its sequence is the next expected
sequence. Duplicate events are ignored. If an event arrives out of order
or there is a gap, buffer a small bounded number of events and request
catch-up. If the buffer limit is exceeded, reload a snapshot.

## 9. Data model

The following is the required conceptual model. Names can be adjusted to
match the ORM, but relationships and constraints must be preserved.

### 9.1 `users`

-   `id UUID PRIMARY KEY`
-   `email CITEXT UNIQUE NOT NULL`
-   `display_name TEXT NOT NULL`
-   `created_at TIMESTAMPTZ NOT NULL`
-   Authentication tables are owned by the selected auth library.

### 9.2 `workspaces`

-   `id UUID PRIMARY KEY`
-   `name TEXT NOT NULL`
-   `owner_id UUID NOT NULL REFERENCES users(id)`
-   `created_at`, `updated_at`

### 9.3 `workspace_members`

-   `workspace_id UUID REFERENCES workspaces(id)`
-   `user_id UUID REFERENCES users(id)`
-   `role TEXT CHECK (role IN ('owner','admin','member'))`
-   `joined_at TIMESTAMPTZ NOT NULL`
-   Primary key `(workspace_id, user_id)`
-   A transaction and/or constraint strategy must ensure exactly one
    owner membership agrees with `workspaces.owner_id`.

### 9.4 `projects`

-   `id UUID PRIMARY KEY`
-   `workspace_id UUID NOT NULL REFERENCES workspaces(id)`
-   `name TEXT NOT NULL`
-   `archived_at TIMESTAMPTZ NULL`
-   `last_seq BIGINT NOT NULL DEFAULT 0`
-   `created_by UUID NOT NULL REFERENCES users(id)`
-   `created_at`, `updated_at`

### 9.5 `project_columns`

-   `id UUID PRIMARY KEY`
-   `project_id UUID NOT NULL REFERENCES projects(id)`
-   `name TEXT NOT NULL`
-   `position INTEGER NOT NULL`
-   Unique `(project_id, position)` and unique `(project_id, name)`
    where appropriate.
-   V1 seeds the fixed columns `Backlog`, `Todo`, `In Progress`, and
    `Done` in that order; custom columns are out of scope. Ordering is
    represented by `position`, so no `is_default` flag is needed.

### 9.6 `tasks`

-   `id UUID PRIMARY KEY`
-   `project_id UUID NOT NULL REFERENCES projects(id)`
-   `column_id UUID NOT NULL REFERENCES project_columns(id)`
-   `title TEXT NOT NULL`
-   `description TEXT NOT NULL DEFAULT ''`
-   `created_by UUID NOT NULL REFERENCES users(id)`
-   `assignee_id UUID NULL REFERENCES users(id)`
-   `rank_key TEXT NOT NULL`
-   `version INTEGER NOT NULL DEFAULT 1`
-   `due_date DATE NULL`
-   `created_at`, `updated_at`
-   `archived_at TIMESTAMPTZ NULL`
-   Indexes on `(project_id, column_id, rank_key, id)` and
    `(project_id, assignee_id)`.

Enforce that `column_id` belongs to the same project as the task in the
service layer and, if practical, with a composite foreign key. Assignees
must be members of the task's workspace.

### 9.7 `comments`

-   `id UUID PRIMARY KEY`
-   `task_id UUID NOT NULL REFERENCES tasks(id)`
-   `author_id UUID NOT NULL REFERENCES users(id)`
-   `body TEXT NOT NULL`
-   `created_at TIMESTAMPTZ NOT NULL`
-   `deleted_at TIMESTAMPTZ NULL`

### 9.8 `project_events`

Use the unified schema from Section 8. It is append-only for normal
application flows. All `project_events` columns are immutable after insert.

### 9.9 `idempotency_records`

-   `id UUID PRIMARY KEY`
-   `actor_id UUID NOT NULL REFERENCES users(id)`
-   `endpoint_key TEXT NOT NULL`
-   `idempotency_key TEXT NOT NULL`
-   `request_hash TEXT NOT NULL`
-   `response_status INTEGER NOT NULL`
-   `response_body JSONB NOT NULL`
-   `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`
-   Unique `(actor_id, endpoint_key, idempotency_key)`.
-   Apply a retention policy of at least 24 hours.

### 9.10 Search

Use PostgreSQL full-text search for task title and description. Maintain
a generated `tsvector` column or update a stored vector in a database
trigger/mutation path, and add a GIN index. Search must apply the same
workspace/project authorization and active-task filters as ordinary task
queries.

## 10. API contract

All endpoints require authentication unless explicitly stated. Exact URL
conventions may vary, but semantics and error codes must remain stable.

### 10.1 Workspaces and membership

-   `POST /api/workspaces`
-   `GET /api/workspaces`
-   `GET /api/workspaces/:workspaceId`
-   `PATCH /api/workspaces/:workspaceId`
-   `POST /api/workspaces/:workspaceId/members`
-   `PATCH /api/workspaces/:workspaceId/members/:userId`
-   `DELETE /api/workspaces/:workspaceId/members/:userId`

### 10.2 Projects and boards

-   `POST /api/workspaces/:workspaceId/projects`
-   `GET /api/workspaces/:workspaceId/projects`
-   `GET /api/projects/:projectId`
-   `PATCH /api/projects/:projectId`
-   `POST /api/projects/:projectId/archive`
-   `POST /api/projects/:projectId/restore`
-   `GET /api/projects/:projectId/board`

### 10.3 Tasks and comments

-   `POST /api/projects/:projectId/tasks` --- requires
    `Idempotency-Key`.
-   `GET /api/projects/:projectId/tasks`
-   `GET /api/tasks/:taskId`
-   `PATCH /api/tasks/:taskId` --- requires `expectedVersion`.
-   `POST /api/tasks/:taskId/move` --- requires `expectedVersion`.
-   `POST /api/tasks/:taskId/archive`
-   `POST /api/tasks/:taskId/restore`
-   `POST /api/tasks/:taskId/comments` --- requires `Idempotency-Key`.
-   `DELETE /api/comments/:commentId`

### 10.4 Events and search

-   `GET /api/projects/:projectId/changes?after=<seq>&limit=<n>`
-   `GET /api/projects/:projectId/events?limit=<n>` --- paginated
    activity history.
-   `GET /api/projects/:projectId/search?q=<query>`

### 10.5 Error contract

Use a consistent error envelope:

``` json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "This task changed since you loaded it.",
    "details": {
      "currentVersion": 8
    },
    "requestId": "..."
  }
}
```

Required codes include:

-   `400 VALIDATION_ERROR`
-   `401 UNAUTHENTICATED`
-   `403 FORBIDDEN`
-   `404 NOT_FOUND` (use this rather than exposing the existence of
    unauthorized resources)
-   `409 VERSION_CONFLICT`
-   `409 TASK_ARCHIVED`
-   `409 PROJECT_ARCHIVED`
-   `409 IDEMPOTENCY_KEY_REUSED`
-   `422 INVALID_STATE_TRANSITION` where a request is syntactically
    valid but not allowed by domain rules
-   `429 RATE_LIMITED`
-   `500 INTERNAL_ERROR`

Do not return stack traces, SQL details, or sensitive authorization
information to clients.

## 11. Frontend behavior

-   The board shows columns and ordered task cards.
-   Drag-and-drop submits a move request with destination column, anchor
    task ID, and expected task version.
-   The client uses optimistic UI only if it can revert cleanly when the
    server rejects the operation. On conflict, show a non-blocking
    message and refresh the affected task/column.
-   Task edit forms preserve unsaved input if a conflict occurs; do not
    silently discard the user's changes.
-   Apply WebSocket events per project in ascending `seq` order. Ignore
    duplicates at or below the client's last contiguous applied sequence.
    If an event arrives above the next expected sequence, pause later event
    application and call catch-up to fill the gap before resuming.
-   A task snapshot replaces only the corresponding server-owned task state;
    it must not overwrite unrelated state or an unsaved form draft.
-   Each optimistic mutation retains enough prior local state to roll back
    if rejected. On `409 VERSION_CONFLICT`, preserve unsaved form values,
    refresh authoritative task state, and offer a clear reapply/retry action.
-   Reconcile HTTP responses and WebSocket events by project sequence and
    task version; do not assume the HTTP response arrives before its event.
-   Reconnect uses exponential backoff with jitter and then calls the
    catch-up endpoint from the last contiguous applied sequence.
-   If catch-up fails repeatedly or the sequence gap is too large,
    reload a consistent board snapshot.
-   Show a small connection state indicator: connected, reconnecting, or
    offline.
-   Avoid showing raw technical error messages to end users; log request
    IDs to support debugging.

## 12. Security requirements

1.  Use an established auth library; do not implement custom session
    cryptography.
2.  If local password auth is used, use Argon2id through a maintained
    library.
3.  Use secure, HttpOnly cookies and appropriate `SameSite` settings.
4.  Protect cookie-authenticated state-changing requests against CSRF.
5.  Validate WebSocket `Origin` against an explicit allowlist and
    authenticate before accepting subscriptions.
6.  Check workspace membership and role for every route and
    subscription. Do not rely only on frontend hiding.
7.  Validate all inputs with a schema library at API boundaries.
8.  Use parameterized database access; never interpolate user input into
    SQL.
9.  Rate-limit authentication, membership changes, comments, and
    expensive search requests.
10. Keep secrets in deployment environment variables; never commit them.
11. Redact cookies, tokens, passwords, and sensitive content from logs.
12. Add automated cross-workspace access tests for every resource
    category.
13. PostgreSQL row-level security is **not required for v1**. It may be
    added later as defense in depth after service-layer authorization
    and tenant-isolation tests are correct.

## 13. Architecture and deployment

### 13.1 Stack

-   Frontend: Next.js, React, TypeScript; Next.js is the frontend only.
-   Backend: a separate long-running Node.js server using Fastify or
    Hono for HTTP and WebSockets. Keep domain logic in
    framework-independent service modules; do not run WebSockets inside
    Next.js.
-   Database: PostgreSQL.
-   ORM/query layer: Drizzle, using explicit PostgreSQL transactions and
    `SELECT ... FOR UPDATE` where required.
-   Validation: Zod at API boundaries.
-   Authentication: Better Auth with Argon2id password hashing for
    password-based sign-in. Manage Better Auth auth tables through the same
    Drizzle migration workflow as the application schema: generate or review
    its schema definitions, commit migrations, and apply all schema changes
    through one migration pipeline. Use database-backed sessions for v1. On
    logout or session revocation, reject subsequent HTTP requests and
    re-check/disconnect WebSockets associated with the revoked session.
-   Testing: Vitest plus Playwright, against a real PostgreSQL test
    database.
-   Realtime: WebSocket library compatible with the chosen persistent
    server.
-   Logging: structured JSON logs with request ID, actor ID, project ID,
    operation, and duration, with sensitive fields redacted.

### 13.2 Process model

Run a long-lived Node.js server using Fastify or Hono for HTTP and
WebSocket connections. Next.js is the frontend only; do not host
WebSockets inside Next.js. The per-instance event-delivery loop runs in
the Node.js process behind a module boundary so it can be tested and
monitored independently.

Each application process holds a dedicated, long-lived PostgreSQL
connection for `LISTEN` subscriptions, separate from the ordinary
transaction/query pool. `LISTEN` is session-scoped; do not issue it through
a pool that may release or switch the underlying session after a transaction.
Use a direct PostgreSQL connection or session-pinned pooling, not PgBouncer
transaction pooling, for this listener. On disconnect, reconnect with backoff,
reissue required `LISTEN` subscriptions, then perform catch-up before marking
the listener recovered. Polling remains active while the listener is down.

Do not assume a serverless-only host supports persistent WebSockets or a
durable worker loop. Deploy to a platform that supports long-running
processes, such as Railway, Render, or Fly.io, plus managed PostgreSQL.

### 13.3 Multi-instance behavior

The initial production target is one application instance and one
PostgreSQL database. The architecture must not rely on in-memory state
for durable events or catch-up.

If multiple app instances are deployed:

-   Each instance serves its own connected WebSocket clients.
-   Membership changes issue `NOTIFY` on a dedicated `membership_changes`
    channel in the same transaction. Each instance listens on that channel
    and re-authorizes or disconnects affected sockets immediately. Before
    sending project data, instances query PostgreSQL for current membership
    and role; no membership cache is used in v1.
-   Every instance listens on the same PostgreSQL notification channel.
    A notification wakes each instance, which reads durable events after
    its own local delivery cursor and sends them to its own local
    sockets.
-   Each instance polls active/subscribed projects periodically, so a
    missed notification or listener outage does not permanently lose
    delivery.
-   Do not use a global publication flag or `SKIP LOCKED` claim loop;
    those cannot represent per-instance delivery.
-   Redis is not required for v1.

Before enabling multiple instances, test cross-instance delivery and
reconnect recovery. Do not claim multi-instance correctness until that
test passes.

### 13.4 Environment and operations

Required configuration includes database URL, auth secret, allowed
application origins, and deployment environment. Use managed database
backups and document restoration. Include a health endpoint that checks
process health and a readiness endpoint that checks database
connectivity.

## 14. Testing strategy

Tests are developed alongside each feature, not postponed until the end.

### 14.1 Unit tests

-   Permission policy functions.
-   Input validation and domain-state transitions.
-   Fractional rank calculation and deterministic ordering.
-   Event payload validation and client sequence handling.
-   Idempotency request-hash behavior.

### 14.2 Integration tests with real PostgreSQL

-   Mutation and event insert commit or roll back together.
-   Per-project event sequence is unique, ordered, and gap-free for
    committed events under concurrent transactions.
-   A transaction that rolls back does not leave a committed event or
    consume a committed project sequence.
-   Repeated idempotent requests return the same response and create one
    domain record/event.
-   Reusing a key with a different request body returns `409`.
-   A stale task version returns `409` without changing task state or
    creating a mutation event.
-   Concurrent moves do not produce duplicate effective positions or
    corrupt column membership.
-   A task cannot be moved to a column in another project.
-   Archive blocks edits; restore reintroduces the task to the active
    board.
-   A user cannot access another workspace's projects, tasks, comments,
    events, or WebSocket channel.

### 14.3 Concurrency tests

Use barriers/latches or controlled concurrent promises to make requests
overlap deliberately.

Required scenarios:

1. Two users edit the same task version; one
succeeds and one receives `409`.
2. A task move races with a task field
edit; task-level version policy allows one and rejects the stale
operation.
3. Multiple tasks move to the same destination position
concurrently; final order is deterministic and every task appears
exactly once.
4. Two mutations for the same project allocate event
sequences concurrently; committed sequences have no gaps and are
ordered.
5. An instance misses a PostgreSQL `NOTIFY`; periodic polling
recovers and delivers the missing event.
6. Duplicate event delivery
does not duplicate client state.
7. Client disconnects during several
mutations and catches up to the current sequence after reconnect.
8. Membership is revoked while a WebSocket is connected; subsequent
delivery to that connection is stopped after revocation handling.

### 14.4 End-to-end tests

-   Sign in, create workspace, add member, create project,
    create/edit/move/archive/restore task.
-   Two browser contexts see the same committed task update.
-   Simulate offline/reconnect and verify catch-up.
-   Verify a member cannot administer workspace membership.
-   Verify cross-workspace URLs do not reveal private resource
    existence.

### 14.5 Load and failure tests

For the portfolio baseline:

- 50 concurrent simulated connected clients
across a small number of projects.
- 20 concurrent task mutations per
second for a 60-second run in a documented test environment.
- Measure
HTTP mutation latency, event delivery lag, error rate, database lock
wait, and reconnect catch-up time.
- Simulate an instance listener
interruption or missed notification and verify committed changes remain
recoverable.

These are local benchmark targets, not universal production capacity
claims. Report actual hardware, dataset size, run duration, and results.

## 15. Measurable acceptance criteria

The project is considered complete when the following are demonstrated
in automated tests or a reproducible benchmark:

### Correctness

-   100% of successful project mutations covered by the core mutation
    paths create exactly one durable event in the same transaction.
-   A failed/rolled-back mutation creates no committed domain change and
    no committed event.
-   Under the concurrency test suite, committed event sequences for each
    project are contiguous and strictly increasing.
-   Two conflicting writes using the same expected version cannot both
    succeed.
-   Replaying an idempotent request within the retention period creates
    no duplicate task/comment and returns the original result.
-   No tested user can read or mutate another workspace's resources
    without membership.
-   A client reconnecting from a valid cursor converges to the current
    committed project state without missing an event.

### Performance baseline

On a documented development/deployment test environment, with 50
simulated connected clients and 20 task mutations per second for 60
seconds:

-   HTTP mutation latency: p95 under 300 ms, excluding cold starts and
    external AI calls.
-   Notification-driven commit-to-WebSocket delivery latency: p95 under
    1 second for connected subscribers under documented benchmark load.
-   Recovery after missed notification or listener interruption: no lost
    committed events; report actual recovery latency. With a 1-second poll
    interval, recovery may exceed 1 second and is outside the normal
    notification-driven p95 target.
-   Catch-up endpoint: p95 under 300 ms for a page of up to 100 events.
-   Error rate: under 1% excluding deliberately injected failures and
    expected `409` conflicts.
-   No lost committed changes after a missed notification or listener
    interruption; recovery time through polling is measured and
    reported.

If the hardware cannot meet these targets, report the actual results and
bottleneck honestly rather than weakening correctness assertions.

### Product and delivery

-   All critical flows work in the deployed environment.
-   No critical or high-severity authorization defect remains open.
-   The README includes setup, environment variables, migration/seed
    instructions, architecture diagram, concurrency model, test
    commands, deployment details, known limitations, and benchmark
    methodology.
-   A short demo shows two clients collaborating and a reproducible
    conflict/reconnect scenario.

## 16. Observability

Structured logs should include request ID, operation name, actor ID,
project ID, outcome, duration, and error code. Do not log authentication
secrets or full sensitive payloads.

Track at minimum:

- Request count, latency, and error rate by route.
- `409` conflict rate.
- Database transaction duration and lock-wait duration for project sequence allocation.
- Per-instance event delivery lag (latest committed seq minus instance delivery cursor, per project).
- Polling recovery count and recovery duration.
- WebSocket connections, reconnect count, and catch-up batch sizes.
- Idempotency replays and key-reuse errors.

A dashboard is not required; logs and a few useful metrics are enough
for v1.

## 17. Implementation plan --- 10 weeks

Testing and correctness checks begin with the first feature.

### Week 1 --- Foundation, first deployment, and decisions

-   Create repository, linting, formatting, environment validation, CI,
    and database migrations.
-   Deploy a minimal app to the target persistent-process host, connect
    it to PostgreSQL, and demonstrate one working browser-to-server
    WebSocket connection to expose hosting issues immediately.
-   Integrate auth library and session handling.
-   Define schema, permission policy, and error envelope.
-   Add unit tests for role checks and integration tests for workspace
    isolation.

### Week 2 --- Workspaces and projects

-   Implement workspace creation, membership management, roles, and
    project CRUD.
-   Add authorization tests for every route.
-   Add seed data and a repeatable local setup.

### Week 3 --- Board and task CRUD

-   Implement fixed status columns, task creation/editing, assignee
    validation, archive/restore.
-   Add expected-version checks and `409` conflict responses.
-   Write PostgreSQL integration tests for rollback and stale writes.

### Week 4 --- Ordering and comments

-   Implement fractional rank keys, transactional moves, and comment
    operations.
-   Add idempotency records for task/comment creation.
-   Write deliberate concurrent-move and duplicate-request tests.

### Week 5 --- Unified project event log

-   Implement `projects.last_seq`, `project_events`, and event insertion
    in every mutation transaction.
-   Add catch-up endpoint and activity history UI.
-   Test sequence ordering, rollback behavior, and event/domain
    atomicity.

### Week 6 --- Real-time delivery and recovery

-   Implement per-instance polling, `LISTEN/NOTIFY` wake-ups, WebSocket
    authorization, deduplication, and reconnect catch-up.
-   Add tests for listener interruption/reconnection and polling recovery,
    duplicate event delivery, sequence gaps, and revocation. Verify the
    dedicated listener reissues `LISTEN` after reconnect and performs catch-up.
-   Deploy an early version to the intended persistent-process host.

### Week 7 --- Collaboration UX and buffer

-   Finish board drag-and-drop, optimistic UI rollback, conflict
    messaging, and connection status.
-   Reserve the remainder of the week as an explicit buffer for
    interaction bugs and concurrency regressions.

### Week 8 --- Search, filters, security, and reliability

-   Add filters and PostgreSQL full-text search with a GIN index, plus
    search authorization tests.
-   Run end-to-end flows with two browser contexts.
-   Complete CSRF/origin validation, rate limiting, cross-workspace
    tests, and error handling.
-   Test malformed input, revoked membership, event-delivery failures,
    and reconnect storms.
-   Fix the highest-impact reliability defects.

### Week 9 --- Performance and documentation

-   Run the 50-client/20-mutation-per-second baseline and record
    results.
-   Inspect query plans, indexes, transaction time, and event queue lag.
-   Fix measured bottlenecks; do not prematurely add infrastructure.

### Week 10 --- Polish and portfolio delivery

-   Improve empty/error/loading states and accessibility.
-   Finalize README, architecture and sequence diagrams, API docs, test
    instructions, and demo data.
-   Record a demo of concurrent edits, conflict handling, and reconnect
    recovery.
-   Add the optional AI task-extraction feature only if core acceptance
    criteria are already met.

## 18. Scope priorities

### P0 --- Must ship

-   Auth and sessions.
-   Workspace membership and permission matrix.
-   Projects, fixed status columns, task CRUD, comments,
    archive/restore.
-   Fractional task ordering and optimistic concurrency.
-   Unified `project_events` table for audit history and catch-up;
    per-instance delivery uses NOTIFY plus polling, with no global
    publication flag.
-   WebSockets, catch-up endpoint, reconnect recovery.
-   Idempotency for task/comment creation.
-   PostgreSQL full-text search.
-   Integration, concurrency, authorization, and end-to-end tests.
-   Persistent-process deployment and setup documentation.

### P1 --- Only after P0 is stable

-   AI-assisted task extraction with structured output and evaluation.
-   More polished activity history and filters.
-   Additional performance instrumentation.

### Explicitly out of scope

-   Reservations, presence, guest roles, email notifications, custom
    columns, file uploads, private projects, fine-tuning, and
    microservices.

## 19. Portfolio deliverables

The repository should include:

1.  A clear README with one-command local setup where practical.
2.  An architecture diagram showing HTTP, WebSocket, PostgreSQL, per-instance event delivery loop, and catch-up.
3.  A transaction sequence diagram for a task mutation.
4.  A permission matrix and explanation of tenant isolation.
5.  A documented concurrency policy, including why v1 uses task-level
    version conflicts.
6.  Automated tests demonstrating concurrent writes, duplicate retries,
    missed notification and listener interruption, and reconnect recovery.
7.  A benchmark report with reproducible commands and environment
    details.
8.  A deployed demo and short screen recording.
9.  A concise list of trade-offs and future improvements.

The most important interview story is not "I built a Trello clone." It
is: **"I designed and tested a collaborative system where database
mutations, event ordering, concurrent edits, retries, and reconnect
recovery have explicit guarantees."**

## 20. Known limitations

- Per-project writes are serialized through the project sequence counter.
- Task-level version conflicts can occur between edits and moves on the same task.
- Instance delivery cursors are held in memory and rebuilt through catch-up after restart.
- Workspace-level changes are not delivered as project events; clients refetch workspace/project lists on navigation.
- Single-instance deployment is the tested v1 target; multi-instance correctness requires the specified cross-instance tests before enabling it.
- Event retention compaction is not implemented in v1.
- Rank-key rebalance threshold is fixed at 32 characters for v1; tune only after measuring real workloads.

## 21. Final implementation decisions

For v1, the following decisions are fixed:

-   Modular-monolith backend: one long-running Fastify or Hono Node.js
    HTTP/WebSocket server, plus a Next.js frontend; PostgreSQL is authoritative.
    The listener uses a dedicated long-lived PostgreSQL connection and
    polling recovery runs every 1 second.
-   Workspace membership grants access to all projects in that
    workspace.
-   Roles are owner, admin, and member; no guest role.
-   Columns represent task status; there is no duplicated status field.
-   Task ordering uses fractional rank keys; no-op moves do not
    increment task version or create events.
-   Every successful task mutation that changes persisted task state,
    including a move, increments task version exactly once. A no-op move
    does not increment the version and does not emit an event.
-   Task-level optimistic concurrency is used; stale writes return `409`
    rather than auto-merging.
-   Tasks are archived and restored; normal workflows do not hard-delete
    them.
-   A single `project_events` table serves as audit history and catch-up
    feed; it has no global publication flag because each instance must
    deliver to its own local sockets.
-   Project event sequences are allocated by a transactional per-project
    counter, not a plain PostgreSQL sequence.
-   Domain mutation and event insertion commit in one transaction.
-   PostgreSQL NOTIFY wakes every app instance; each instance reads
    after its local delivery cursor and polls as fallback. Delivery is
    at-least-once; clients deduplicate and recover using the sequence
    cursor.
-   Task/comment creation use persisted idempotency keys with
    duplicate-race handling under `READ COMMITTED`.
-   PostgreSQL full-text search uses a GIN index.
-   Authentication uses Better Auth with Argon2id for password-based
    sign-in; CSRF and WebSocket Origin checks are mandatory.
-   Drizzle handles database access and explicit transactions; Zod
    validates API inputs; Vitest and Playwright test against a real
    PostgreSQL database.
-   PostgreSQL RLS is deferred; service-layer authorization and
    tenant-isolation tests are mandatory.
-   Deployment uses a persistent Node.js process and PostgreSQL.
-   AI task extraction is optional, uses schema validation and
    evaluation, and does not require fine-tuning.
-   Testing is continuous across the 10-week plan, not postponed to the
    end.

This is the implementation contract. Any deviation should be recorded in
the README with the reason and its effect on correctness, scope, or
deployment.
