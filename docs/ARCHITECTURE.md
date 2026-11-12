# SyncSpace — System Architecture

This document describes the architectural design, process boundaries, subsystem responsibilities, and data flows for the SyncSpace platform, based on [`SPECIFICATION.md`](SPECIFICATION.md).

---

## 1. High-Level Architecture

SyncSpace is architected as a **modular monolith** consisting of a decoupled Next.js frontend, a persistent Node.js backend server hosting both HTTP APIs and WebSockets, and a single PostgreSQL database acting as the authoritative state store.

```mermaid
flowchart TD
    subgraph Clients["Client Layer (Web Browsers)"]
        BrowserA["Client A (Next.js UI)"]
        BrowserB["Client B (Next.js UI)"]
    end

    subgraph Backend["Application Server (Persistent Node.js Process)"]
        Gateway["HTTP & WebSocket Gateway (Fastify or Hono)"]
        AuthMiddleware["Auth & CSRF Middleware (Better Auth)"]
        ServiceLayer["Service Layer (Domain Logic & Authorization)"]
        EventLoop["Per-Instance Delivery Loop (Cursor + 1s Polling)"]
        WSManager["WebSocket Connection Manager"]
        
        Gateway --> AuthMiddleware
        AuthMiddleware --> ServiceLayer
        Gateway --> WSManager
        EventLoop --> WSManager
    end

    subgraph Storage["Persistence & Signaling (PostgreSQL)"]
        DB[(PostgreSQL Database)]
        ListenNotify["PostgreSQL LISTEN/NOTIFY Bus"]
        
        ServiceLayer -->|Transaction + NOTIFY| DB
        DB -->|Deliver NOTIFY| ListenNotify
        ListenNotify -->|Wakeup Signal| EventLoop
        EventLoop -->|Read project_events| DB
    end

    BrowserA -->|HTTP Mutations / Queries| Gateway
    BrowserB -->|HTTP Mutations / Queries| Gateway
    BrowserA <-->|Persistent WebSocket| WSManager
    BrowserB <-->|Persistent WebSocket| WSManager
```

---

## 2. Process Boundaries & Components

### 2.1 Frontend Client (Next.js, React, TypeScript)
- **Role:** Pure presentation and user interaction layer. Next.js is strictly the frontend; WebSockets and domain logic are **never** hosted in Next.js API routes or serverless lambdas.
- **Kanban Board:** Renders project columns and tasks ordered by fractional rank keys. Handles drag-and-drop operations with destination column, neighboring anchor tasks, and `expectedVersion`.
- **Optimistic UI with Rollback:** Applies local optimistic updates only when reversible. If the server returns `409 VERSION_CONFLICT` or an error, the client rolls back the optimistic UI, retains unsaved form input, and displays clear non-blocking feedback.
- **WebSocket State Machine:** Maintains connection status (`connected`, `reconnecting`, `offline`), tracks the latest contiguous applied sequence cursor (`lastAppliedSeq`), buffers out-of-order events, and triggers catch-up requests upon detecting sequence gaps.

### 2.2 HTTP & WebSocket Server (Node.js Process)
- **Framework:** Long-running Node.js process using Fastify or Hono.
- **Boundary Validation:** Enforces Zod schemas on every incoming request body, query parameter, and path variable.
- **Authentication & CSRF:** Integrates Better Auth. Uses secure, `HttpOnly` session cookies in production. Validates the `Origin` header and enforces CSRF tokens on all cookie-authenticated mutations.
- **WebSocket Gateway:**
  - Validates `Origin` header during handshake against an explicit allowlist.
  - Authenticates the user session prior to connection acceptance.
  - Manages subscription sets per client and per project.
  - Does **not** cache workspace membership; verifies membership against PostgreSQL directly before subscription or event dispatch.

### 2.3 Service Layer (Framework-Agnostic Domain Services)
- Encapsulates business logic across distinct service modules:
  - `WorkspaceService`: Workspace creation, settings, ownership transfer.
  - `MembershipService`: Member invitation, role demotion/promotion, member removal.
  - `ProjectService`: Project creation, renaming, archive, restore.
  - `ColumnService`: Column definitions, fixed statuses, column rebalancing.
  - `TaskService`: Task CRUD, moves, optimistic concurrency checks, archive, restore.
  - `CommentService`: Comment creation, soft deletion.
  - `SearchService`: Full-text search queries using PostgreSQL `tsvector` and GIN index.
- **Strict Authorization Rule:** Authorization is enforced in the service layer using the authenticated user ID and the target resource's workspace ID. Client-provided resource IDs are **never** trusted as proof of authorization.

### 2.4 Data Access Layer (Drizzle ORM & PostgreSQL Connections)
- **Unified Drizzle Schema & Migration Pipeline:** Both domain tables (`users`, `workspaces`, `tasks`, etc.) and Better Auth tables (`sessions`, `accounts`, `verifications`) are managed under a single unified Drizzle ORM schema and migration pipeline (`0000_futuristic_brood.sql`, `0001_auth_tables.sql`).
- **Primary Connection Pool:** Used for ordinary application queries, REST endpoints, and transactional domain mutations. Runs under PostgreSQL `READ COMMITTED` isolation.
- **Dedicated Listener Connection & Consumer Reconciler:** A dedicated, long-lived PostgreSQL connection reserved exclusively for `LISTEN` subscriptions (`project_events` and `membership_changes`). This connection bypasses transaction-level pooling proxies (e.g., PgBouncer transaction mode) because `LISTEN` is session-scoped. Incoming signals on `membership_changes` are handled by `MembershipConsumerService`, which performs authoritative point-in-time state reconciliation against `workspace_members` in PostgreSQL before dispatching domain events (`revoked`, `role_updated`, `added`). Reconciled events are point-in-time observations, preserving the requirement for WebSocket delivery loops to independently verify membership in PostgreSQL immediately before delivering project data.

### 2.5 Unified Project Event & Delivery Subsystem
- **Single Canonical Table:** `project_events` acts simultaneously as the audit log, catch-up replay feed, and real-time notification source.
- **No Outbox Table or Publication Flags:** The system maintains no per-event publication flags, no claim loops (`SKIP LOCKED`), and no separate outbox tables.
- **Per-Instance Delivery Engine (`DeliveryEngine`):**
  - **In-Memory Per-Project State:** Maintains `ProjectDeliveryState` with an in-memory delivery cursor (`localLastDeliveredSeq`) and subscriber registry per active project for locally connected sockets. Projects with zero subscribers are automatically unloaded from memory.
  - **Subscription Protocol C Handoff:**
    - The initial subscriber for a project loads the authoritative `projects.last_seq` from PostgreSQL as the initial `localLastDeliveredSeq` and triggers an immediate catch-up drain to dispatch any events committed during registration.
    - Subsequent subscribers register into the active project state and receive `currentSeq` from `projects.last_seq` in PostgreSQL. Clients use `currentSeq` to fetch missing events via `GET /api/projects/:projectId/changes?after=<snapshotSeq>` while buffering live events.
  - **Single-Drain Lock & Coalescing:** Strictly one asynchronous drain loop (`activeDrain`) executes per project at any moment. Concurrent signals or drain requests coalesce by setting `pendingDrain = true`. When the active drain completes, if `pendingDrain` is set and the engine is running, another drain cycle executes immediately.
  - **Pre-Dispatch PostgreSQL Authorization Gate:** Immediately prior to fan-out of each individual event (inside `dispatchSingleEvent`), the engine performs a fresh batched query against PostgreSQL `workspace_members` for all distinct subscriber user IDs.
    - *Fail-Closed Safety:* If the database query encounters a transient error, event dispatch is halted and the cursor is frozen (`localLastDeliveredSeq` is not advanced), failing closed. While this fresh point-in-time check strongly mitigates the window for delivering events to revoked members, it cannot recall an already-authorized in-flight send or eliminate the theoretical query-to-TCP race.
    - *Immediate Eviction:* Subscribers whose membership is confirmed absent in PostgreSQL are evicted and closed without receiving event data.
  - **Concurrent Fan-Out with Bounded Send Timeout (Option A):**
    - Events are fanned out concurrently to all eligible subscribers using `Promise.allSettled`, isolating synchronous throws and asynchronous rejections so one failing subscriber cannot delay or prevent delivery to others.
    - A per-subscriber shutdown guard checks `isShuttingDown` immediately before each individual subscriber send; any send skipped due to shutdown is neither treated as an error nor evicted as a failure.
    - Subscriber sends are bounded by a configurable timeout (default 5000 ms). If a subscriber rejects or times out, it is evicted and closed idempotently. Late promises are tracked so late resolution or rejection cannot mutate delivery state, advance cursors independently, or leak unhandled promise rejections.
    - The project cursor `localLastDeliveredSeq` is advanced strictly after all send promises settle and the engine verifies it is not shutting down.
  - **Single-Flight Polling Fallback:** A periodic background polling loop runs nominally every 1 second (configurable). A single-flight guard (`isPolling`) prevents overlapping polling sweeps. The loop iterates active projects with registered subscribers and triggers drain cycles, which query `project_events` for sequences beyond `localLastDeliveredSeq`. Missed NOTIFY signals are recovered on the next successful polling cycle, which runs nominally every second. Database or polling failures may delay recovery until a subsequent successful cycle.
  - **Tenant-Scoped Revocation Eviction:** Subscribes to `MembershipConsumerService` domain events. Upon receiving a `revoked` event, immediately evicts all matching subscriber sockets across active projects in that workspace.
  - **Graceful Shutdown Lifecycle:** Checks `isShuttingDown` at subscription entry, drain start, per-event batch processing, immediately before each individual subscriber's send, and prior to cursor advancement. When `stop()` is called, active drains are awaited up to `shutdownTimeoutMs`; if drains complete early, the shutdown timeout handle is cleared immediately via `try/finally` cleanup, and remaining subscribers are closed cleanly without orphan timers or background operations.

---

## 3. Core Architectural Workflows

### 3.1 Project Mutation & Co-Commit Transaction Flow

Every state-changing project mutation executes inside a single PostgreSQL transaction ensuring strict atomicity between the domain mutation and its durable event.

```mermaid
sequenceDiagram
    autonumber
    actor Client
    participant Server as HTTP Handler (Fastify/Hono)
    participant Service as Domain Service Layer
    participant DB as PostgreSQL (READ COMMITTED)

    Client->>Server: POST /api/tasks/:id/move (with expectedVersion)
    Server->>Service: Execute task move
    Service->>DB: BEGIN TRANSACTION
    Service->>DB: Authenticate actor & verify workspace membership
    Service->>DB: Lock project sequence counter row (SELECT last_seq FOR UPDATE)
    Service->>DB: Lock affected task rows & verify expectedVersion == current_version
    Service->>DB: Calculate new fractional rank key & update task (increment version)
    opt Rank Key Length > 32 Chars
        Service->>DB: Rebalance column & INSERT column.rebalanced event (seq = last_seq + 1)
    end
    Service->>DB: Increment last_seq and INSERT project_events (seq = last_seq)
    Service->>DB: pg_notify('project_events', payload: { projectId, seq })
    Service->>DB: COMMIT TRANSACTION
    DB-->>Service: Commit confirmed
    Service-->>Server: Return updated task snapshot & sequence
    Server-->>Client: 200 OK (Task payload)
```

> [!IMPORTANT]
> If any step fails (e.g., version mismatch, constraint violation, or database error), the transaction is completely rolled back. No orphan `project_events` row is ever created, no sequence number is burned, and no `NOTIFY` signal is dispatched by PostgreSQL.

---

### 3.2 Real-Time Event Propagation & Per-Instance Delivery Flow

WebSockets operate under **at-least-once** delivery semantics. Notifications act as a lightweight wake-up trigger, while the database remains authoritative.

```mermaid
sequenceDiagram
    autonumber
    participant DB as PostgreSQL
    participant Listener as Dedicated LISTEN Connection
    participant Consumer as MembershipConsumerService
    participant Delivery as DeliveryEngine (Per-Instance)
    participant Sub as Local ProjectSubscriber (WS Socket)
    actor Client as Browser Client

    Note over DB,Delivery: Wake-up trigger path via LISTEN/NOTIFY
    DB->>Listener: NOTIFY 'project_events' { projectId, seq } [Post-Commit]
    Listener->>Delivery: Wake up for projectId (triggerDrain)

    Note over Delivery,DB: Drain Loop (Coalesced & Single-Flight per project)
    Delivery->>DB: SELECT * FROM project_events WHERE project_id = :id AND seq > :localCursor ORDER BY seq ASC LIMIT :batchSize
    DB-->>Delivery: Return committed event batch

    loop For each event in batch
        Delivery->>DB: Pre-Dispatch Gate: SELECT userId, role FROM workspace_members WHERE workspaceId = :wsId AND userId IN (:distinctSubUserIds)
        alt Transient DB Error
            DB-->>Delivery: Query failure
            Delivery->>Delivery: Halt batch & freeze cursor (fail-closed, no eviction)
        else Confirmed Active Membership
            DB-->>Delivery: Return active members
            opt Subscriber Absent in DB
                Delivery->>Sub: Evict & close unauthorized socket
            end
            Delivery->>Sub: Concurrent fan-out via Promise.allSettled (5s timeout)
            Sub->>Client: Send WebSocket message (seq, eventType, payload)
            Delivery->>Delivery: Settle all send promises & evict timed-out subscribers
            Delivery->>Delivery: Advance localLastDeliveredSeq = event.seq
        end
    end

    Note over Delivery,DB: Fallback: Single-Flight Polling (every 1s)<br/>discovers unnotified events & triggers drain
    opt Membership Revocation Trigger
        DB->>Listener: NOTIFY 'membership_changes' { workspaceId, userId }
        Listener->>Consumer: Reconcile point-in-time membership
        Consumer->>Delivery: emit('revoked', { workspaceId, userId })
        Delivery->>Sub: Evict all matching subscriber sockets in workspace
    end
```

---

### 3.3 Initial Board Hydration & Consistent Real-Time Synchronization

When a client navigates to a project board, it initializes its local state from a consistent point-in-time snapshot and establishes real-time synchronization:

```mermaid
sequenceDiagram
    autonumber
    actor Client
    participant Server as HTTP & WS Gateway
    participant DB as PostgreSQL (REPEATABLE READ)

    Client->>Server: GET /api/projects/:projectId/board
    Server->>DB: BEGIN TRANSACTION (REPEATABLE READ, READ ONLY)
    Server->>DB: Query project metadata (last_seq)
    Server->>DB: Verify caller workspace membership
    Server->>DB: Query status columns (ORDER BY position ASC)
    Server->>DB: Query active tasks (WHERE archived_at IS NULL ORDER BY rank_key ASC, id ASC)
    Server->>DB: COMMIT TRANSACTION
    DB-->>Server: Mutually consistent snapshot data (snapshotSeq = last_seq)
    Server-->>Client: 200 OK ({ project, columns, tasks, snapshotSeq })
    Client->>Client: Hydrate board state & initialize local cursor lastAppliedSeq = snapshotSeq
    Client->>Server: Establish WebSocket connection & subscribe to project
    opt Catch up missed events committed during initial connection
        Client->>Server: GET /api/projects/:projectId/changes?after=snapshotSeq
        Server-->>Client: 200 OK ({ events, nextCursor, hasMore, currentSeq })
        loop For each event
            Client->>Client: Apply contiguous event & advance lastAppliedSeq
        end
    end
```

---

### 3.4 Reconnect & Catch-Up Workflow

When a client loses network connectivity, it uses a monotonic cursor to fetch missed events upon reconnecting, preventing lost updates without requiring full state reloads.

```mermaid
sequenceDiagram
    autonumber
    actor Client
    participant Server as HTTP & WS Gateway
    participant DB as PostgreSQL

    Note over Client: Network drops; Client reconnects with lastAppliedSeq = 42
    Client->>Server: Re-establish WebSocket connection & subscribe (projectId)
    Client->>Server: GET /api/projects/:projectId/changes?after=42&limit=50
    Server->>DB: Verify actor workspace membership
    Server->>DB: SELECT * FROM project_events WHERE project_id = :id AND seq > 42 ORDER BY seq ASC LIMIT 50
    DB-->>Server: Return events (43..65), nextCursor=65, hasMore=false, currentSeq=65
    Server-->>Client: 200 OK (Events 43..65)
    loop For each catch-up event
        Client->>Client: Apply event sequentially to board state
        Client->>Client: Advance lastAppliedSeq = event.seq
    end
    Note over Client: Client is caught up; resumes live WebSocket event consumption
```

If the client detects a sequence gap in the live WebSocket stream (e.g., receives sequence 70 when expecting 66), it buffers incoming messages (up to a small bounded limit) and queries the catch-up endpoint to fill the gap before processing buffered events.

---

### 3.5 Membership Revocation & Socket Eviction Flow

Immediate revocation is enforced via a dedicated PostgreSQL channel without relying on stale in-memory permission caches. Incoming notifications act as edge triggers prompting point-in-time reconciliation against PostgreSQL before dispatching revocation signals.

```mermaid
sequenceDiagram
    autonumber
    actor Admin
    participant Server as Application Server
    participant DB as PostgreSQL
    participant Listener as Dedicated LISTEN Connection
    participant Consumer as MembershipConsumerService
    participant WSManager as WebSocket Connection Manager
    actor RevokedMember as Revoked Member Client

    Admin->>Server: DELETE /api/workspaces/:wsId/members/:userId
    Server->>DB: BEGIN TRANSACTION
    Server->>DB: DELETE FROM workspace_members WHERE workspace_id = :wsId AND user_id = :userId
    Server->>DB: pg_notify('membership_changes', payload: { workspaceId, affectedUsers: [{ userId, action: 'removed' }] })
    Server->>DB: COMMIT TRANSACTION
    DB-->>Listener: NOTIFY 'membership_changes'
    Listener->>Consumer: onMembershipChange(payload)
    Consumer->>DB: SELECT role FROM workspace_members WHERE workspace_id = :wsId AND user_id = :userId
    DB-->>Consumer: Returns isMember === false
    Consumer->>WSManager: onEvent({ type: 'revoked', workspaceId, userId })
    WSManager->>RevokedMember: Terminate active project subscriptions & disconnect socket
    RevokedMember-->>WSManager: Connection Closed
```

---

## 4. Multi-Instance Scaling Model

While SyncSpace targets a single application instance for the v1 baseline, its architecture is fundamentally designed to support multi-instance deployments without introducing Redis:

1. **Independent Sockets:** Each application instance maintains its own set of connected client WebSockets.
2. **Shared Signaling:** All instances listen to the shared PostgreSQL notification channels (`project_events` and `membership_changes`) via dedicated long-lived database connections.
3. **Independent Delivery Cursors:** Every instance maintains its own in-memory delivery cursor per project. An event committed by Instance 1 emits a `NOTIFY` signal that wakes Instances 1, 2, and 3 simultaneously. Each instance queries PostgreSQL for events newer than its own local cursor and dispatches them to its locally connected clients.
4. **Independent Polling:** Each instance independently polls active subscribed projects every 1 second, guaranteeing recovery even if a specific instance's `LISTEN` connection experiences transient network packet loss.
5. **Direct Authorization:** Instances check user membership directly against PostgreSQL before delivering events; no distributed session or permission cache is required.

---

## 5. Deployment & Process Model

SyncSpace is deployed to hosting platforms supporting long-running persistent processes and managed PostgreSQL:

- **Target Platforms:** Railway, Render, or Fly.io with managed PostgreSQL. Serverless lambda platforms (e.g., Vercel Functions, AWS Lambda) are **incompatible** with the backend due to the need for persistent WebSocket connections, dedicated `LISTEN` sessions, and background polling loops.
- **Connection Management:**
  - One standard connection pool (sized appropriately for API traffic).
  - One dedicated, non-pooled connection for the PostgreSQL event listener.
- **Health & Readiness Endpoints:**
  - `GET /health` — Verifies process responsiveness and event loop latency.
  - `GET /ready` — Validates database pool connectivity and listener connection status.

