# SyncSpace — Failure Handling & Recovery

This document specifies the expected failure scenarios, blast radiuses, detection mechanisms, and automated recovery procedures for SyncSpace, based on [`SPECIFICATION.md`](SPECIFICATION.md) and [`../AGENTS.md`](../AGENTS.md).

---

## 1. Failure Handling Principles

1. **PostgreSQL Authoritative Recovery:** The persistent database state is the single source of truth. Transient component failures (dropped sockets, missed signals, crashed instances) must be fully recoverable by reconciling against PostgreSQL.
2. **Explicit Atomic Boundaries:** State mutations must either completely commit or completely abort. Partial state or orphan events are unacceptable.
3. **Graceful Client Degradation:** Clients must anticipate disconnections, sequence gaps, and concurrency conflicts, providing clear user feedback while preserving unsaved form drafts.

---

## 2. Failure Scenarios & Recovery Workflows

### 2.1 Database Transaction Failure or Rollback
- **Scenario:** A database constraint violation, connection drop, deadlock, or validation check triggers a transaction rollback during a project mutation.
- **Blast Radius:** Limited strictly to the failing HTTP request.
- **Recovery & Invariants:**
  - PostgreSQL rolls back all mutations atomically.
  - No domain row is updated.
  - The project sequence counter (`projects.last_seq`) is **not** incremented.
  - No `project_events` row is inserted.
  - No PostgreSQL `NOTIFY` is delivered to listeners (PostgreSQL delivers notifications only upon successful commit).
  - The API returns an appropriate client error (e.g., `409` or `500`); the client displays a non-blocking notification.

---

### 2.2 Dropped or Coalesced PostgreSQL `NOTIFY` Signal
- **Scenario:** Under heavy load or transient network hiccups between PostgreSQL and the Node.js process, a `NOTIFY` signal is dropped or coalesced.
- **Blast Radius:** Ephemeral notification delay for connected WebSocket clients.
- **Recovery & Invariants:**
  - `NOTIFY` is merely a wake-up signal; it is **never** relied upon for durable delivery.
  - Every application instance runs an independent background polling loop every 1 second.
  - The polling loop queries:
    ```sql
    SELECT * FROM project_events 
    WHERE project_id = :id AND seq > :instance_cursor 
    ORDER BY seq ASC;
    ```
  - Any committed event not processed via `NOTIFY` is discovered, dispatched to local subscribers, and the instance cursor is advanced.
  - Maximum recovery latency: ~1 second plus query execution time.

---

### 2.3 Dedicated `LISTEN` Connection Interruption
- **Scenario:** The dedicated database connection running `LISTEN project_events` and `LISTEN membership_changes` disconnects due to database maintenance, idle timeout, or proxy restart.
- **Blast Radius:** Transient cessation of push notifications across all connected clients on that application instance.
- **Recovery & Invariants:**
  - The application detects the connection drop via connection error/close handlers.
  - The application initiates reconnect with exponential backoff and jitter.
  - Polling continues running on the standard query pool every 1 second, maintaining event delivery during the listener outage.
  - Upon reconnection, the listener reissues `LISTEN project_events` and `LISTEN membership_changes`, then performs a reconciliation query before resuming normal operation.

---

### 2.4 WebSocket Client Disconnection & Network Partition
- **Scenario:** A client laptop sleeps, switches Wi-Fi networks, or experiences mobile packet loss.
- **Blast Radius:** The disconnected client misses live events while offline.
- **Recovery & Invariants:**
  - The client detects socket closure and transitions UI state to `reconnecting`.
  - The client initiates reconnection using exponential backoff with jitter.
  - Upon re-establishing the WebSocket connection, the client issues a catch-up request:
    `GET /api/projects/:projectId/changes?after=<lastAppliedSeq>&limit=100`
  - The server returns all committed events after `lastAppliedSeq`.
  - The client applies the missing events sequentially, advances its cursor, and transitions to `connected`.

---

### 2.5 Sequence Gap or Out-of-Order WebSocket Delivery
- **Scenario:** Network packet reordering causes a client on sequence 50 to receive sequence 52 before sequence 51.
- **Blast Radius:** Potential visual inconsistency if the out-of-order event is applied prematurely.
- **Recovery & Invariants:**
  - The client verifies that incoming `seq == lastAppliedSeq + 1`.
  - Upon detecting a gap, the client places the forward event (seq 52) into a bounded in-memory buffer.
  - The client immediately queries the catch-up endpoint starting from `lastAppliedSeq`.
  - Once missing events (seq 51) are retrieved and applied, the client drains the buffered event (seq 52).
  - If the buffer overflows or the gap is too large, the client reloads a full project snapshot inside a `REPEATABLE READ` transaction and resets its cursor.

---

### 2.6 Stale-Write Collision (`409 VERSION_CONFLICT`)
- **Scenario:** Two collaborators simultaneously modify the same task (e.g., User A changes the assignee while User B edits the title).
- **Blast Radius:** The second request is rejected.
- **Recovery & Invariants:**
  - The server verifies `expectedVersion == task.version`.
  - The lagging mutation fails with `409 VERSION_CONFLICT`, returning the current authoritative version and task snapshot.
  - The client UI catches the 409, rolls back any optimistic UI changes, preserves the user's unsaved form text in place, and alerts the user to rebase or reapply their edit.

---

### 2.7 Concurrent Task Move Collision & Rank Key Bloat
- **Scenario:** Multiple users drag different tasks into the same column position concurrently, or high-frequency moves between adjacent tasks cause rank key strings to expand.
- **Blast Radius:** Temporary lock wait on the project sequence counter.
- **Recovery & Invariants:**
  - Task moves serialize through the per-project sequence row lock.
  - The server re-reads the neighboring tasks' current rank keys after acquiring the lock, computing a fresh valid midpoint.
  - If the computed rank key exceeds 32 characters, the transaction triggers an automatic column rebalancing:
    - Normalizes all active tasks in that column to clean, compact fractional keys.
    - Emits a `column.rebalanced` event with consecutive sequence before the move event.
    - Clients apply the rebalance map atomically.

---

### 2.8 Concurrent Duplicate Request Race on Idempotency Key
- **Scenario:** Two identical requests with the same `Idempotency-Key` are submitted simultaneously and race through the API gateway.
- **Blast Radius:** One request wins; the other hits the database unique constraint on `(actor_id, endpoint_key, idempotency_key)`.
- **Recovery & Invariants:**
  - Under `READ COMMITTED` isolation, the losing request catches the specific unique constraint violation.
  - The handler re-reads the committed idempotency record in a new statement or transaction.
  - It compares the stored `request_hash` with the current request:
    - If hashes match: returns the cached response (200/201) without re-executing the domain logic.
    - If hashes differ: returns `409 IDEMPOTENCY_KEY_REUSED`.
  - Raw database errors are never exposed to the client.

---

### 2.9 Application Server Process Crash
- **Scenario:** The Node.js application process crashes or is restarted during deployment.
- **Blast Radius:** All connected WebSockets are terminated. In-flight HTTP transactions are aborted by PostgreSQL.
- **Recovery & Invariants:**
  - In-memory instance delivery cursors are discarded.
  - A new Node.js instance boots, initializes database pools, connects the dedicated listener, and reissues `LISTEN`.
  - Disconnected clients automatically reconnect and execute catch-up queries against PostgreSQL.
  - The new instance reads initial project snapshots in `REPEATABLE READ` transactions and initializes fresh instance delivery cursors.

---

### 2.10 High Contention on Project Sequence Counter
- **Scenario:** Excessive concurrent write mutations on a single hot project cause lock-wait queues on `projects.last_seq`.
- **Blast Radius:** Increased HTTP mutation latency for that specific project.
- **Recovery & Invariants:**
  - Transactions hold row locks for minimal duration (locking the counter immediately before inserting the event and committing).
  - Fast fail: database transaction timeouts abort stalled transactions before connection pool exhaustion occurs.
  - Measured contention will inform whether to separate the counter into a dedicated `project_event_counters` table post-v1.

