# SyncSpace — Testing Strategy & Acceptance Criteria

This document defines the comprehensive testing methodology, verification suites, concurrency harnesses, and measurable acceptance criteria for SyncSpace, based on [`SPECIFICATION.md`](SPECIFICATION.md) and [`../AGENTS.md`](../AGENTS.md).

---

## 1. Testing Philosophy & Core Principles

1. **Continuous Verification:** Tests are developed alongside each feature, never postponed until the end of the project.
2. **Real PostgreSQL Authoritative Testing:** Unit tests test pure logic in memory. Integration and concurrency tests **must run against a real PostgreSQL test database**. Mocking PostgreSQL transactions, row-level locks (`FOR UPDATE`), or notification channels is strictly prohibited.
3. **No False Claims:** Never claim a test works unless it has been executed against the actual test environment with a reported exit code of 0.
4. **Isolated Test Environments:** Tests execute against dedicated test schemas or transient test databases. Production data is never used for testing.

---

## 2. Test Suites & Verification Levels

### 2.1 Unit Tests (Vitest)
Unit tests verify deterministic domain algorithms, schema validators, and authorization logic without network or database overhead:
- **Permission Matrix Rules:** Tests the pure authorization matrix across all roles (`Owner`, `Admin`, `Member`) for all actions (workspace settings, member invite/remove, ownership transfer, project creation/archival, task moves, comment deletion).
- **Zod Schema Validation:** Tests valid and malformed payloads, boundary constraints, string lengths, and unexpected fields across all API endpoints.
- **Fractional Indexing Algorithm:** Verifies lexicographical sort orders, midpoint calculations, boundary insertions, and edge cases (e.g., insertion between identical keys triggering tie-breaking).
- **Idempotency Request Hashing:** Verifies that SHA-256 request hashes deterministically capture HTTP method, parameterized route paths, and canonicalized JSON bodies (ignoring trivial whitespace variations).
- **Client Event Application & Deduplication:** Tests client-side state machine handling of out-of-order sequence arrivals, duplicate arrivals, and sequence gap detection.

---

### 2.2 Integration Tests with Real PostgreSQL (Vitest)
Integration tests verify ACID transaction boundaries, constraint enforcement, and cross-workspace tenant isolation:
- **Atomic Co-Commit & Rollback:**
  - Verify that a successful task mutation inserts both the domain row and the `project_events` row in the same transaction.
  - Verify that an injected database error or transaction rollback leaves 0 domain changes, 0 committed events, and does not increment `projects.last_seq`.
- **Per-Project Monotonic Sequences:**
  - Under concurrent writes, verify that committed `project_events.seq` values are strictly contiguous integers without gaps.
- **Idempotency Key Enforcement:**
  - Verify that repeating a creation request with identical key and body returns the cached HTTP response and creates exactly one domain record and one event.
  - Verify that reusing an idempotency key with a modified request body returns `409 IDEMPOTENCY_KEY_REUSED`.
- **Stale Write & Concurrency Protection:**
  - Submitting an update with `expectedVersion != task.version` rejects with `409 VERSION_CONFLICT` and leaves task state untouched.
- **Task Moves & Boundaries:**
  - Verify that moving a task updates column and rank key atomically and increments version.
  - Verify that attempting to move a task to a `column_id` belonging to a different project fails with a validation/foreign-key violation.
- **Cross-Workspace Tenant Isolation (Mandatory for ALL Categories):**
  - Verify that User A (Workspace A) cannot read, create, update, delete, search, or subscribe to:
    1. Workspace settings of Workspace B.
    2. Projects of Workspace B.
    3. Columns of Workspace B.
    4. Tasks of Workspace B.
    5. Comments of Workspace B.
    6. `project_events` of Workspace B.
    7. Full-text search results of Workspace B.
    8. WebSocket live updates for projects in Workspace B.
  - All unauthorized cross-workspace queries must return `404 NOT_FOUND` to prevent resource existence enumeration.

---

### 2.3 Concurrency Tests (Latches, Barriers, & Promise.all)
Concurrency tests use synchronization barriers to force concurrent requests to overlap at the database layer.

| Scenario ID | Test Description | Required Behavioral Outcome |
| :--- | :--- | :--- |
| **CONC-01** | Two concurrent edits to the same task version | One request succeeds (200 OK); the other is rejected with `409 VERSION_CONFLICT`. |
| **CONC-02** | A task move races with a field edit | Task-level version policy permits one mutation to commit; the lagging mutation receives `409 VERSION_CONFLICT`. |
| **CONC-03** | Multiple concurrent task moves to the exact same destination position | The per-project sequence row lock serializes the moves. The final order is deterministic, rank keys are distinct, and no task is duplicated or lost. |
| **CONC-04** | Concurrent mutations allocating project event sequences | All committed sequence numbers for the project are strictly contiguous, ordered, and gap-free. |
| **CONC-05** | Simulated dropped PostgreSQL `NOTIFY` signal | The 1-second per-instance polling loop detects the un-notified committed event and delivers it to local subscribers. |
| **CONC-06** | Duplicate event delivery to client | Client deduplicates by `(project_id, seq)` and does not apply duplicate state transitions. |
| **CONC-07** | Client disconnects during multiple mutations and reconnects | Client queries `GET /api/projects/:projectId/changes?after=<seq>` and catches up completely to the latest committed sequence. |
| **CONC-08** | Workspace membership revoked while WebSocket is connected | The `membership_changes` notification triggers immediate session invalidation; subsequent project events are blocked from delivery to that socket. |

---

### 2.4 End-to-End Tests (Playwright)
Browser-driven multi-context tests verify complete collaborative user workflows:
1. **Multi-User Collaboration Journey:**
   - User 1 (Owner) creates a workspace and invites User 2 (Member).
   - User 1 creates a project and adds a task.
   - User 2 (in a separate browser context) immediately observes the new task appear via WebSocket without refreshing.
   - User 2 drags the task to "In Progress"; User 1 observes the card move smoothly across columns.
2. **Offline & Reconnect Journey:**
   - Browser 2 disables network connectivity.
   - Browser 1 moves two tasks and adds a comment.
   - Browser 2 reconnects; the UI shows the "reconnecting" indicator, executes a catch-up request, and updates the board to the exact state of Browser 1.
3. **Role Enforcement Journey:**
   - Member attempts to navigate to workspace member management; UI and API reject administrative actions.
4. **URL Probing & Information Leakage:**
   - A logged-in user navigates directly to a private project URL belonging to another workspace; the application returns a generic 404 page.

---

### 2.5 Performance Baseline & Benchmark Criteria

The portfolio benchmark evaluates system stability under sustained concurrent load:
- **Workload:** 50 simulated concurrent WebSocket clients across multiple projects; 20 task mutations per second sustained for 60 seconds.
- **Latency Thresholds:**
  - HTTP mutation latency: p95 < 300 ms (excluding cold starts).
  - Commit-to-WebSocket delivery latency: p95 < 1,000 ms for connected subscribers.
  - Catch-up endpoint: p95 < 300 ms for a page of 100 events.
- **Error Budget:** Unhandled server error rate < 1% (excluding deliberate test conflicts).
- **Recovery Latency:** 100% of committed events recovered after listener interruption or missed notifications via 1-second polling.

---

## 3. Test Execution Commands & Environment

When test infrastructure is established, test commands must be executed as follows:

```bash
# Run unit tests
pnpm test:unit

# Run PostgreSQL integration tests
pnpm test:integration

# Run concurrency tests
pnpm test:concurrency

# Run Playwright end-to-end tests
pnpm test:e2e

# Run portfolio benchmark harness
pnpm benchmark
```
*(Commands are to be added to `package.json` during implementation.)*

