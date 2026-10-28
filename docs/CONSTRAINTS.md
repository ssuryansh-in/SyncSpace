# SyncSpace — Engineering Constraints & Boundaries

This document defines the non-negotiable architectural requirements, consistency rules, security constraints, and scope boundaries for SyncSpace, based on [`SPECIFICATION.md`](SPECIFICATION.md) and [`../AGENTS.md`](../AGENTS.md).

---

## 1. Architectural Constraints

1. **Modular Monolith Architecture:** The backend must be structured as a modular monolith running in a single, persistent Node.js process. Microservices, distributed service meshes, and RPC layers are strictly prohibited for v1.
2. **Next.js Frontend Decoupling:** Next.js serves the user interface only. Under no circumstances may WebSockets, background listener loops, or persistent database pools be hosted inside Next.js API routes or serverless functions.
3. **Infrastructure Simplicity:** The v1 technology stack is restricted to:
   - Frontend: Next.js, React, TypeScript.
   - Backend: Node.js (Fastify or Hono).
   - Database: PostgreSQL.
   - Database Access: Drizzle ORM.
   - Authentication: Better Auth.
   - Real-Time Signaling: PostgreSQL `LISTEN/NOTIFY` + WebSockets.
4. **No External Message Brokers:** Redis, Apache Kafka, RabbitMQ, NATS, and external pub/sub services are **strictly forbidden** for v1. All ordering, notification, and event streaming must be handled directly by PostgreSQL.
5. **Persistent Process Requirement:** The hosting platform must support long-lived, continuous Node.js processes. Ephemeral or serverless execution platforms (e.g., AWS Lambda, Vercel Serverless) are architecturally incompatible.

---

## 2. Database & Consistency Constraints

1. **PostgreSQL as Single Source of Truth:** No in-memory cache, WebSocket server state, or client-side storage may ever be treated as authoritative data.
2. **Transaction Isolation:** All database transactions must operate under PostgreSQL `READ COMMITTED` isolation and be explicitly designed to prevent race conditions at this isolation level.
3. **Atomic Co-Commit of Mutations and Events:**
   - Every domain mutation that alters project state must commit in the **exact same database transaction** as its corresponding `project_events` row.
   - A rolled-back domain mutation must **never** leave a committed event row.
   - A committed event row must **never** exist without its corresponding domain state mutation.
4. **Transactional Sequence Allocation:**
   - Client-facing project cursors must **never** be generated from a plain PostgreSQL sequence (`CREATE SEQUENCE`), as sequence allocations can commit out of order.
   - Event sequence numbers must be allocated by acquiring an exclusive row lock (`SELECT last_seq FROM projects WHERE id = :id FOR UPDATE`) within the mutation transaction, guaranteeing monotonic, contiguous, gap-free sequences for committed events.
5. **No Separate Outbox or Publication Flags:**
   - The application must not create a separate outbox table, per-event publication boolean flags, or worker claim loops (`SKIP LOCKED`).
   - The single `project_events` table serves as the audit log, catch-up replay feed, and notification source.
6. **Task Moves Are Atomic:** Moving a task to another column or position must be executed in a single transaction that updates the column, recalculates the fractional rank key, increments the task version, and emits the event.
7. **Client Cannot Supply Arbitrary Rank Keys:** Move endpoints accept destination column IDs and neighboring anchor task IDs. The server computes the fractional rank key; clients are strictly forbidden from supplying arbitrary rank strings.
8. **Soft Deletions in Normal Workflows:**
   - Tasks and projects are archived via `archived_at`. Hard deletes are forbidden in normal application workflows.
   - Comments are soft-deleted via `deleted_at`. Comment bodies are purged from API responses upon deletion, and comment event payloads must **never** contain comment bodies.

---

## 3. Concurrency Constraints

1. **Optimistic Concurrency Control:**
   - Task field edits and moves require an `expectedVersion` parameter.
   - If `expectedVersion != current_version`, the server must reject the request with `409 VERSION_CONFLICT` and return the current task version and snapshot.
   - The server must **never** silently overwrite newer state with outdated client writes.
2. **No Automatic 3-Way Merging:** Field-level merging or CRDT-style auto-reconciliation is explicitly forbidden for task updates. If a priority edit races with a task move, one must fail with `409 VERSION_CONFLICT`.
3. **Idempotency Enforcement:**
   - Task creation (`POST /api/projects/:projectId/tasks`) and comment creation (`POST /api/tasks/:taskId/comments`) require an `Idempotency-Key` header.
   - Replaying a request with the same key and identical `request_hash` within 24 hours must return the cached original response without creating duplicate records or emitting duplicate events.
   - Replaying a key with a conflicting `request_hash` must reject with `409 IDEMPOTENCY_KEY_REUSED`.
4. **Rank Key Rebalancing:** Columns must be rebalanced whenever a newly computed rank key exceeds 32 characters. Rebalancing must occur inside the move transaction, preserve exact visual order, emit a single `column.rebalanced` event, and never increment individual task versions.

---

## 4. Real-Time Delivery Constraints

1. **At-Least-Once Delivery Semantics:** The system must never claim or rely upon exactly-once WebSocket delivery.
2. **Client-Side Deduplication & Gap Handling:** Clients must track their monotonic sequence cursor (`lastAppliedSeq`), discard duplicate events (`seq <= lastAppliedSeq`), and pause processing to fetch missing events via catch-up if a gap is detected.
3. **Dedicated Connection for `LISTEN`:** The PostgreSQL `LISTEN` subscriber must run over a dedicated, long-lived database connection. It must **never** be executed through a connection pool configured for transaction-mode pooling (e.g., PgBouncer).
4. **Fallback Polling Required:** Every application instance must run an independent polling loop (1-second interval) to recover missed `NOTIFY` signals or listener interruptions.
5. **No Project Events for Workspace-Level Changes:** Workspace rename, membership additions/removals, and project creation do not emit project events; clients refetch lists upon navigation. Membership changes emit signals exclusively on the internal `membership_changes` channel for socket eviction.

---

## 5. Security & Authorization Constraints

1. **Authenticate All Protected Endpoints:** Unauthenticated requests to protected API routes or WebSocket handshakes must be rejected immediately.
2. **Service-Layer Authorization:** Authorization checks must be performed in the service layer using the authenticated actor ID and the target resource's workspace ID.
3. **Never Trust Client-Supplied IDs:** Client-provided workspace IDs, project IDs, or user IDs must never be trusted as proof of authorization.
4. **Cross-Workspace Isolation:** A user belonging to Workspace A must never read, mutate, search, or subscribe to resources in Workspace B. Cross-workspace attempts must return `404 NOT_FOUND` to prevent resource existence enumeration.
5. **Admin Cannot Demote Owner:** Admins cannot remove, demote, or alter the role of the workspace Owner. Workspace ownership transfer requires a dedicated single-transaction endpoint accessible only to the current Owner.
6. **Input Schema Validation:** All incoming payloads, queries, and parameters must be strictly validated with Zod schemas at the HTTP and WebSocket boundary.
7. **Parameterized Queries Only:** All database access must use Drizzle ORM parameterized queries. Raw string interpolation into SQL queries is strictly prohibited.
8. **CSRF Protection:** All state-changing, cookie-authenticated HTTP mutations must enforce CSRF protection (validating `Origin` and requiring anti-CSRF tokens).
9. **WebSocket Origin Validation:** WebSocket handshake requests must validate the `Origin` header against an explicit allowed origin whitelist.
10. **Credential Security & Logging:** Passwords must be hashed using Argon2id via Better Auth. Secrets, passwords, session tokens, and cookie values must **never** be logged or committed to version control.

---

## 6. Non-Goals & Scope Restrictions (v1)

The following features and architectures are **strictly out of scope for v1**:
- Workspace deletion (reserved for future soft-deletion via `workspaces.deleted_at`).
- Reservations, bookings, or asset inventory tracking.
- Guest accounts, public boards, or anonymous viewer access.
- Private projects inside a workspace (all members can view all projects in the workspace).
- User presence tracking, live cursor tracking, and typing indicators.
- Email dispatch or push notifications.
- File attachments, cloud storage uploads, and rich text/WYSIWYG document editing.
- Microservices, Kafka, Redis, or Kubernetes.
- AI fine-tuning or custom LLM model training.

