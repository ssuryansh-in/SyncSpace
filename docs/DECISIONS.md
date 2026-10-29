# SyncSpace — Architectural Decisions

This document records the confirmed architectural decisions, design rationale, accepted trade-offs, and unresolved engineering choices for SyncSpace, based on [`SPECIFICATION.md`](SPECIFICATION.md).

---

## 1. Confirmed Decisions (Explicitly Established by `docs/SPECIFICATION.md`)

The decisions in this section are mandatory engineering requirements established directly by the specification. They must be preserved across all implementations.

### ADR-01: Modular Monolith with Decoupled Next.js Frontend
- **Specification Reference:** Sections 1, 13.1, 13.2, 21.
- **Confirmed Requirement:** Deploy the backend as a single long-running Node.js process for HTTP and WebSockets, completely decoupled from the Next.js frontend. Next.js serves the UI only; WebSockets and domain logic are **never** hosted in Next.js API routes or serverless functions.
- **Design Rationale:** Next.js serverless and edge runtimes do not support persistent WebSocket connections, background event-loop polling, or dedicated PostgreSQL `LISTEN` connections. Decoupling preserves a clean boundary: Next.js is pure presentation; the persistent Node.js server owns domain logic, APIs, and real-time synchronization.
- **Framework Status:** Provisionally resolved to **Hono** using `@hono/node-server` (see Section 2, Decision 1 for full rationale, trade-offs, and historical evaluation).
- **Rejected Alternatives:**
  - *Unified Next.js Monolith with custom server:* Adds operational fragility, breaks standard Next.js build optimizations, and complicates independent scaling.
  - *Microservices:* Explicit non-goal for v1; distributed transactions across services compromise atomicity.

---

### ADR-02: PostgreSQL as the Single Authoritative Source of Truth
- **Specification Reference:** Sections 1, 3.2, 13.1, 21.
- **Confirmed Requirement:** Rely exclusively on PostgreSQL for domain persistence, event ordering, and signaling. Explicitly exclude Redis, Kafka, RabbitMQ, and external streaming platforms for v1.
- **Design Rationale:** Eliminates the dual-write problem. Coordinating state between PostgreSQL and an external message broker requires distributed consensus or two-phase commits. PostgreSQL provides transactional co-commit, monotonic sequences, and notification primitives in a single engine.
- **Accepted Trade-off:** High write loads on a single project are bound by PostgreSQL row-lock contention on the sequence counter.

---

### ADR-03: Single Unified `project_events` Table (No Outbox Table or Publication Flags)
- **Specification Reference:** Sections 8.1, 8.4, 21.
- **Confirmed Requirement:** Maintain exactly one append-only `project_events` table that serves three distinct roles: (1) audit log, (2) catch-up feed for reconnecting clients, and (3) real-time notification source. Do not maintain a separate outbox table, per-event publication flags, or claim loops (`SKIP LOCKED`).
- **Design Rationale:** In a multi-instance architecture, a global "published" flag cannot represent per-instance delivery state (Instance A may have delivered an event while Instance B has not). Instead, each instance tracks its own in-memory cursor, and PostgreSQL provides the single ordered log.

---

### ADR-04: Per-Project Transactional Sequence Allocation via Row Lock
- **Specification Reference:** Sections 7.1, 8.2, 21.
- **Confirmed Requirement:** Allocate event sequences strictly inside the domain mutation transaction by acquiring an exclusive row lock (`SELECT last_seq FROM projects WHERE id = :id FOR UPDATE`) and incrementing `last_seq`. Do not use PostgreSQL `CREATE SEQUENCE`.
- **Design Rationale:** Native PostgreSQL sequences can commit out-of-order under concurrent transactions. If Transaction A gets sequence 5 and Transaction B gets sequence 6, Transaction B might commit before Transaction A. A client consuming sequence 6 would advance its cursor, permanently missing sequence 5. Row-locking the project counter enforces strictly monotonic, contiguous, gap-free committed sequences.
- **Accepted Trade-off:** Serializes write mutations per project. This is an intentional v1 trade-off favoring absolute correctness over concurrent write throughput on a single project.

---

### ADR-05: Task-Level Optimistic Concurrency Control (`409 VERSION_CONFLICT`)
- **Specification Reference:** Sections 7.2, 10.5, 21.
- **Confirmed Requirement:** Track an integer `version` on every task. Clients must submit `expectedVersion` for edits and moves. The server verifies `expectedVersion == version`; if outdated, the mutation is rejected with `409 VERSION_CONFLICT`.
- **Design Rationale:** SyncSpace deliberately favors simple, predictable conflict semantics over complex automatic 3-way merging or Operational Transformation / CRDTs. A move colliding with a title edit is rejected so the user can rebase their change against authoritative current state.
- **Rejected Alternatives:**
  - *Last-Write-Wins (LWW):* Silently overwrites concurrent edits, causing catastrophic data loss in collaborative workspaces.
  - *Field-Level Merging / CRDTs:* Tremendous implementation and debugging complexity for v1; creates confusing semantic anomalies when fields are conceptually interdependent.

---

### ADR-06: Fractional Indexing for Task Ordering with Rebalancing
- **Specification Reference:** Sections 7.3, 21.
- **Confirmed Requirement:** Order tasks within columns using fractional indexing rank keys (lexicographically sortable strings). Rebalance the column when any newly computed rank key exceeds 32 characters.
- **Design Rationale:** Allows arbitrary insertions and reordering without shifting all subsequent rows in the database (avoiding $O(N)$ row updates on every move). Rebalancing runs within the move transaction and emits an atomic `column.rebalanced` event containing the complete rebalanced rank map.
- **Accepted Trade-off:** Rebalancing introduces a larger single transaction when a column exceeds the key length threshold, but keeps rank keys compact and query performance fast.

---

### ADR-07: Soft Deletion Policy
- **Specification Reference:** Sections 3.2, 6.5, 7.4, 21.
- **Confirmed Requirement:** In normal product workflows, tasks and projects are archived via `archived_at TIMESTAMPTZ`, and comments are soft-deleted via `deleted_at TIMESTAMPTZ`. Hard deletion is excluded from v1.
- **Design Rationale:** Preserves audit trail integrity in `project_events`. Hard-deleting rows would leave broken foreign keys or phantom references in historical event streams.

---

### ADR-08: Workspace-Scoped Authorization Model
- **Specification Reference:** Sections 4.1, 4.2, 21.
- **Confirmed Requirement:** Workspace membership grants access to all projects inside that workspace. Roles are strictly `Owner`, `Admin`, and `Member`.
- **Design Rationale:** Eliminates nested permissions and ACL fragmentation in v1. Workspace boundaries provide clean multi-tenant isolation.
- **Explicit Non-Goals:** No private projects within workspaces, no project-specific overrides, and no guest/anonymous accounts in v1.

---

### ADR-09: Task Status Defined by Column ID
- **Specification Reference:** Sections 6.3, 9.5, 21.
- **Confirmed Requirement:** A task's status is represented exclusively by its `column_id`. There is no separate `status` column in the `tasks` table. Fixed columns in v1 are `Backlog`, `Todo`, `In Progress`, and `Done`.
- **Design Rationale:** Having both a `column_id` and a `status` enum introduces the risk of state disagreement and desynchronization bugs.

---

### ADR-10: At-Least-Once Real-Time Delivery with Monotonic Client Catch-Up
- **Specification Reference:** Sections 6.6, 8.4, 8.5, 21.
- **Confirmed Requirement:** WebSockets deliver real-time notifications with at-least-once semantics. The server never claims exactly-once delivery. Clients deduplicate events by `(project_id, seq)` and fetch missing events via the `GET /api/projects/:projectId/changes?after=<seq>` catch-up endpoint.
- **Design Rationale:** Exactly-once distributed delivery across unreliable browser networks is impossible without distributed two-phase commits. Combining at-least-once delivery with client-side deduplication and sequence catch-up guarantees eventual consistency and fault tolerance.

---

### ADR-11: Dedicated Session-Pinned PostgreSQL Connection for `LISTEN`
- **Specification Reference:** Sections 13.2, 21.
- **Confirmed Requirement:** The application maintains a dedicated, non-pooled connection to PostgreSQL exclusively for `LISTEN project_events` and `LISTEN membership_changes`.
- **Design Rationale:** PostgreSQL `LISTEN` is session-scoped. In transaction-pooled database proxies (such as PgBouncer), connections are released back to the pool after each transaction, silently terminating listener subscriptions. A dedicated direct connection ensures uninterrupted event receipt.

---

### ADR-12: Mandatory Idempotency Keys for Entity Creation
- **Specification Reference:** Sections 7.1, 7.5, 10.3, 21.
- **Confirmed Requirement:** `POST /api/projects/:projectId/tasks` and `POST /api/tasks/:taskId/comments` require an `Idempotency-Key` HTTP header.
- **Design Rationale:** Prevents duplicate tasks or comments created by client retries or network timeouts. Handlers acquire the project row lock, compare the SHA-256 `request_hash`, and catch unique constraint races under `READ COMMITTED` isolation, returning the original response upon duplicate retries.

---

### ADR-13: Authentication via Better Auth with Argon2id
- **Specification Reference:** Sections 6.1, 12, 13.1, 21.
- **Confirmed Requirement:** Use Better Auth for authentication, with Argon2id password hashing and database-backed revocable sessions.
- **Design Rationale:** Eliminates the security risk of custom cryptography and password hashing. Database-backed sessions allow immediate revocation upon member removal or security events.
- **Implementation Status (Phase 3.1 Completed):** Runtime initialized with Drizzle ORM PostgreSQL persistence, native `name -> displayName` field mapping, RFC 4122 v4 UUID identifiers, Argon2id hashing (`$argon2id$v=19$m=65536,p=4,t=3`), mandatory email verification (`requireEmailVerification: true`, `autoSignIn: false`), in-memory rate limiting for single-instance v1 deployment, and minimal Resend email dispatch with safe dev/test simulation.

---

### ADR-14: PostgreSQL Full-Text Search
- **Specification Reference:** Sections 6.4, 9.10, 21.
- **Confirmed Requirement:** Implement task search using PostgreSQL's built-in full-text search with generated `tsvector` columns and a GIN index on `title` and `description`.
- **Design Rationale:** Avoids introducing an external search cluster (Elasticsearch/Typesense). Provides fast, indexed, tenant-isolated search within the primary database.

---

### ADR-15: PostgreSQL Row-Level Security (RLS) Deferred Post-v1
- **Specification Reference:** Sections 12.13, 21.
- **Confirmed Requirement:** Enforce multi-tenant authorization in the application service layer for v1; defer database RLS.
- **Design Rationale:** Service-layer authorization paired with rigorous cross-workspace automated tests provides transparent, testable, and maintainable permission enforcement. RLS will be evaluated as defense-in-depth after core correctness is proven.

---

### ADR-16: AI Task Extraction as Optional Post-Core Feature
- **Specification Reference:** Sections 6.8, 18, 21.
- **Confirmed Requirement:** Treat AI task extraction as a P1 feature, implemented only after P0 core correctness criteria are verified. AI suggestions are never committed directly to the database and must be reviewed and confirmed by a human.
- **Design Rationale:** Prevents AI hallucinations or third-party API dependencies from endangering core consistency, authorization, and project milestones.

---

## 2. Unresolved Technical Choices & Engineering Recommendations

The choices in this section represent areas where the specification leaves multiple valid options open or does not mandate a single implementation detail. These are labeled as **OPEN QUESTION**, with advisory recommendations provided for team review.

### DECISION 1: Backend Framework Selection (Provisional: Hono)
- **Specification Status:** Fully compliant with `docs/SPECIFICATION.md` Sections 13.1 and 21 (which explicitly permit either Fastify or Hono).
- **Decision:** Proceed provisionally with **Hono** as the backend framework, running in a persistent Node.js process via `@hono/node-server` and utilizing its documented Node.js WebSocket support.
- **Historical Analysis & Options Evaluated:**
  - *Option A: Fastify.* Highly mature Node.js framework with built-in schema compilation, rich plugin ecosystem, official `@fastify/websocket` support, and long production history (previously advisory-recommended during early exploration).
  - *Option B: Hono.* Modern, lightweight framework with standard Web Request/Response APIs and first-class TypeScript ergonomics.
- **Rationale & Architectural Trade-offs:**
  1. **Web Standard APIs:** Hono is built upon Web Standard `Request` and `Response` interfaces, reducing framework-specific lock-in and keeping HTTP handlers aligned with standard Fetch API paradigms.
  2. **Validation Architecture:** Input validation at route boundaries uses the separate `@hono/zod-validator` package rather than framework-internal JSON schema compilation.
  3. **Better Auth Compatibility:** Better Auth provides official integrations for both Fastify and Hono; therefore, Better Auth compatibility was evaluated as neutral and is not the sole reason for choosing Hono.
  4. **Process Model:** The backend will run strictly as a persistent Node.js process using `@hono/node-server` (not edge or serverless runtimes), maintaining compatibility with long-lived background loops and PostgreSQL `LISTEN/NOTIFY`.
  5. **WebSocket Support & Testing Mandate:** Real-time communication will leverage documented Node.js WebSocket support for Hono. WebSocket connection lifecycle hooks, graceful shutdown, authentication handshakes, authorization re-checks, and connection management must be explicitly implemented and comprehensively tested when those subsystems are built.
  6. **Dependency Management:** The project will use currently supported, compatible, patched dependency versions and strictly commit the package-manager lockfile (`pnpm-lock.yaml`) for deterministic builds.
  7. **Security & Testing Discipline:** Selecting Hono does not eliminate or lessen the need for rigorous service-layer authorization checks, security reviews, CSRF defenses, or real PostgreSQL integration testing.

---

### OPEN QUESTION 2: Fractional Indexing Implementation
- **Specification Status:** **UNRESOLVED IN SPECIFICATION.**
  - Section 7.3 requires *"fractional rank keys (lexicographically sortable strings generated by a well-tested fractional-indexing implementation)"*, but leaves the exact library choice open.
- **Option Analysis:**
  - *Option A:* Adopt an established, well-tested npm library (such as `fractional-indexing` by Figma/David Greenspan).
  - *Option B:* Implement a custom lexicographical string generator.
- **Advisory Recommendation (Pending Team Approval):** **Option A (`fractional-indexing`).** Fractional indexing algorithms have subtle edge cases regarding string growth, base-62 encoding, and boundary conditions. Leveraging an established, thoroughly tested algorithm prevents ordering regressions.

---

### OPEN QUESTION 3: Better Auth Drizzle Migration Management Strategy
- **Specification Status:** **UNRESOLVED IN SPECIFICATION.**
  - Section 13.1 states: *"Manage Better Auth auth tables through the same Drizzle migration workflow as the application schema: generate or review its schema definitions, commit migrations, and apply all schema changes through one migration pipeline."*
  - The exact tooling mechanism for reconciling Better Auth's schema with Drizzle migrations is not specified.
- **Option Analysis:**
  - *Option A:* Generate Better Auth schema definitions via Better Auth CLI into Drizzle schema files and manage them in the central migration pipeline.
  - *Option B:* Hand-author Drizzle schema definitions matching Better Auth's expected model.
- **Advisory Recommendation (Pending Team Approval):** **Option A.** Generating schema via CLI and checking the resulting Drizzle migrations into version control ensures 100% compatibility with Better Auth while fulfilling the spec mandate of a single unified migration pipeline.

---

### OPEN QUESTION 4: Target Deployment Host Selection
- **Specification Status:** **UNRESOLVED IN SPECIFICATION.**
  - Section 13.2 states: *"Deploy to a platform that supports long-running processes, such as Railway, Render, or Fly.io, plus managed PostgreSQL."*
- **Option Analysis:** Railway, Render, or Fly.io with managed PostgreSQL.
- **Advisory Recommendation (Pending Team Approval):** **Render or Railway.** Both provide native support for long-running Node.js Docker/process containers, persistent WebSockets, and direct PostgreSQL connections suitable for `LISTEN/NOTIFY`.

---

### OPEN QUESTION 5: Race Condition Between Membership Revocation and In-Flight WebSocket Delivery
- **Specification Status:** **UNRESOLVED IN SPECIFICATION & IMPLEMENTATION.**
  - Sections 6.6, 12, 13.1, and 21 require immediate revocation of workspace access and socket disconnection upon membership removal or role demotion.
- **Open Security Dilemma:**
  - When a user's workspace membership is revoked or demoted in PostgreSQL, a concurrent in-flight WebSocket delivery loop on another thread or process instance could potentially dispatch an event immediately before receiving or processing the `membership_changes` notification.
  - A batched PostgreSQL membership query has been discussed as a potential performance optimization, but caching or batching must not weaken the strict authorization guarantee required by the specification.
- **Engineering Status:**
  - This security question is **strictly unresolved**.
  - It will not be marked as resolved, nor will an unverified workaround be accepted, without an explicitly defined concurrency guarantee and latch-based integration tests verifying behavior under race conditions.
