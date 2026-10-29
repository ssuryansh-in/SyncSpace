# SyncSpace

> A dependable, real-time collaborative project-management application built for small teams to coordinate work on shared boards with explicit consistency, authorization, and recovery guarantees.

---

## 1. Project Overview

SyncSpace provides a collaborative kanban board where workspace members organize tasks across status columns, assign work, add comments, and observe real-time updates from collaborators without manual page refreshes.

Unlike typical project-management applications where concurrent updates overwrite each other, socket disconnects silently drop events, and weak authorization leaks tenant data, SyncSpace is built around explicit engineering guarantees:
- **PostgreSQL is the single source of truth.** No in-memory state or external streaming platform is relied upon for durable state or event ordering.
- **Atomic domain mutations and durable events.** Every state-changing project mutation and its corresponding project event commit in the exact same PostgreSQL database transaction.
- **Task-level optimistic concurrency control.** Edits and moves enforce expected version checks (`expectedVersion`), rejecting stale writes with `409 VERSION_CONFLICT` instead of silently overwriting concurrent changes.
- **Deterministic ordering.** Task positioning within columns is governed by fractional rank keys, with transactionally locked serial moves and automatic column rebalancing when keys exceed 32 characters.
- **At-least-once real-time delivery with client recovery.** WebSockets provide ephemeral notifications; clients track monotonic project sequence cursors, deduplicate events, and recover missed events via a catch-up HTTP endpoint.
- **Strict tenant isolation.** Workspace membership and role permissions are validated on the server for every HTTP route and WebSocket subscription.

---

## 2. Technology Stack

SyncSpace is architected as a modular monolith with a clean separation between the frontend application and the persistent backend server:

| Component | Technology | Rationale & Boundaries |
| :--- | :--- | :--- |
| **Frontend** | Next.js (React, TypeScript) | Next.js serves the frontend UI only. WebSockets are **never** hosted inside Next.js API routes or serverless functions. |
| **Backend** | Node.js (Fastify or Hono) | Long-running Node.js process hosting both HTTP REST endpoints and the persistent WebSocket server. |
| **Database** | PostgreSQL | Authoritative data store operating under `READ COMMITTED` transaction isolation. |
| **Database Access** | Drizzle ORM | Type-safe schema definition and explicit transactional queries (`SELECT ... FOR UPDATE`). |
| **Authentication** | Better Auth | Session-based authentication with Argon2id password hashing and database-backed revocable sessions. |
| **Input Validation** | Zod | Strict schema validation at all HTTP request and WebSocket message boundaries. |
| **Real-Time Transport**| WebSockets (`ws`) | Ephemeral notification transport over persistent connections managed by the Node.js backend. |
| **Event Notifications**| PostgreSQL `LISTEN/NOTIFY` | In-transaction wake-up notifications delivered across app instances upon transaction commit. |
| **Notification Fallback**| Periodic Polling (1s) | Per-instance polling loop querying active subscribed projects for events past local cursors. |
| **Testing** | Vitest & Playwright | Vitest for unit, integration, and concurrency tests against a real PostgreSQL database; Playwright for multi-user E2E tests. |

> [!IMPORTANT]
> **Out of Scope for v1 Infrastructure:**
> SyncSpace does **not** introduce Redis, Kafka, RabbitMQ, Kubernetes, microservices, or external event streaming platforms for v1. All ordering, pub/sub signaling, and persistence are provided directly by PostgreSQL.

---

## 3. Repository & Documentation Guide

The project documentation establishes the engineering specifications, architectural boundaries, and verification criteria:

- [`AGENTS.md`](AGENTS.md) — Mandatory engineering rules, security guidelines, and development principles.
- [`docs/SPECIFICATION.md`](docs/SPECIFICATION.md) — The approved engineering blueprint and authoritative source of truth.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — Detailed system architecture, component responsibilities, process model, and message flow diagrams.
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — Confirmed architectural decisions, trade-offs, rejected alternatives, and open questions.
- [`docs/CONSTRAINTS.md`](docs/CONSTRAINTS.md) — Non-negotiable technical requirements, consistency rules, and non-goals.
- [`docs/TESTING.md`](docs/TESTING.md) — Required testing strategy, integration suites, concurrency latch tests, and acceptance criteria.
- [`docs/THREAT.md`](docs/THREAT.md) — Threat model, security boundaries, attack vectors, and mandatory mitigations.
- [`docs/FAILURE.md`](docs/FAILURE.md) — Failure scenarios, blast radiuses, detection mechanisms, and automated recovery paths.
- [`docs/DATA.md`](docs/DATA.md) — Conceptual data model, entity schemas, transaction isolation, sequence allocation, and indexing.
- [`docs/ROLLBACK.md`](docs/ROLLBACK.md) — Rollback principles, transactional reversibility, optimistic UI rollback, and operational recovery.
- [`docs/defense/DEFENSE.md`](docs/defense/DEFENSE.md) — Whiteboard defense answering the 9 critical architectural review questions.

---

## 4. Scope and Non-Goals (v1)

### Core Features (P0)
1. **Workspaces & Roles:** Workspace creation, member management with three roles (`Owner`, `Admin`, `Member`), and strict authorization checks.
2. **Projects & Kanban Board:** Fixed status columns (`Backlog`, `Todo`, `In Progress`, `Done`), column-scoped task ordering via fractional indexing.
3. **Tasks & Comments:** Full task lifecycle (create, edit, move, archive, restore), markdown comments with soft deletion, and assignees.
4. **Optimistic Concurrency:** Task-level `expectedVersion` validation returning `409 VERSION_CONFLICT` upon concurrent conflicting updates.
5. **Unified Event Log:** Canonical `project_events` table acting as audit history, catch-up feed, and notification source.
6. **Real-Time Sync & Recovery:** Ephemeral WebSocket updates, PostgreSQL `LISTEN/NOTIFY` waking per-instance dispatchers, 1-second polling fallback, and client sequence catch-up.
7. **Idempotency:** Mandatory `Idempotency-Key` headers for task and comment creation with duplicate race handling under `READ COMMITTED`.
8. **Full-Text Search:** PostgreSQL full-text search with generated `tsvector` columns and a GIN index.

### Explicit Non-Goals for v1
- Workspace deletion in normal workflows (reserved for future soft-deletion via `workspaces.deleted_at`).
- Reservations, bookings, or inventory management.
- Guest accounts, public boards, or unauthenticated/anonymous access.
- Private projects inside a workspace (all members have access to all projects within the workspace).
- Presence indicators, typing indicators, and live collaborative cursors.
- Outbound email notifications or push notifications.
- File attachments, cloud storage, and rich document editing.
- Microservices, Kafka, Redis, or Kubernetes.
- AI fine-tuning or custom LoRA training.

---

## 5. Configuration & Environment Variables

The backend application requires the following environment variables:

| Variable | Description | Example / Default |
| :--- | :--- | :--- |
| `NODE_ENV` | Application runtime environment | `development` \| `production` \| `test` |
| `PORT` | HTTP & WebSocket server port | `4000` |
| `DATABASE_URL` | PostgreSQL connection string | `postgres://user:password@localhost:5432/syncspace` |
| `BETTER_AUTH_SECRET` | Secret key used for session signing and crypto | `super-secret-random-key-at-least-32-chars` |
| `BETTER_AUTH_URL` | Base URL for auth callbacks and session cookies | `http://localhost:4000` |
| `ALLOWED_ORIGINS` | Comma-separated allowlist for CORS and WebSockets | `http://localhost:3000` |

---

## 6. Measurable Acceptance Criteria

The system baseline requires passing the following criteria under a documented benchmark (50 simulated connected clients, 20 task mutations/sec for 60 seconds):
- **Transactional Integrity:** 100% of successful project mutations produce exactly one durable event in the same transaction. Rolled-back mutations leave 0 events and consume no sequence numbers.
- **Monotonic Sequences:** Committed event sequences per project are strictly contiguous and increasing without gaps.
- **Concurrency Protection:** Two concurrent updates using the same `expectedVersion` cannot both succeed; one must receive `409 VERSION_CONFLICT`.
- **Idempotency Safety:** Replaying an idempotent creation request returns the original response without duplicating records or events.
- **Tenant Isolation:** Cross-workspace requests across all resource categories strictly return `404 NOT_FOUND` (or `403 FORBIDDEN` where resource existence is verified).
- **Latency Benchmarks:**
  - HTTP mutation latency: p95 < 300 ms (excluding cold starts).
  - WebSocket notification delivery: p95 < 1,000 ms for connected subscribers.
  - Catch-up endpoint latency: p95 < 300 ms for a page of 100 events.
  - Unhandled error rate: < 1% (excluding deliberate test conflicts).
  - Recovery from missed notifications via 1-second polling: 0 lost committed events.

---

## 7. Development & Verification Commands

### Prerequisites
- Node.js (v20+ supported; tested on Node.js v26.1.0)
- pnpm (tested on pnpm v12.3.4)
- Docker Desktop or PostgreSQL 16 (for database and integration tests)

### Database & Migration Pipeline (Milestones 2 & 3)
- **Start PostgreSQL container:** `docker compose up -d`
- **Stop PostgreSQL container:** `docker compose down`
- **Generate migrations:** `pnpm --filter @syncspace/server db:generate`
- **Apply migrations:** `pnpm --filter @syncspace/server db:migrate`
  - `0000_futuristic_brood.sql`: Nine canonical domain tables, CITEXT extension, and core foreign keys.
  - `0001_auth_tables.sql`: Better Auth authentication tables (`sessions`, `accounts`, `verifications`) and `users` extensions (`email_verified`, `image`, `updated_at`).

### Package & Workspace Commands
- **Install dependencies:** `pnpm install`
- **Run unit test suite:** `pnpm test` (or `pnpm --filter @syncspace/server test:unit`)
- **Run database integration tests:** `pnpm --filter @syncspace/server test:integration`
- **Build TypeScript server:** `pnpm build`
- **Start development server with live watch:** `pnpm dev`
- **Start built production server:** `pnpm --filter @syncspace/server start`

