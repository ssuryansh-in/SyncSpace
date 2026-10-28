# SyncSpace — Whiteboard Defense & Skeptical Engineering Review

This document provides the foundational engineering defense for SyncSpace, addressing the 9 critical whiteboard review questions defined in [`../../AGENTS.md`](../../AGENTS.md) and [`../SPECIFICATION.md`](../SPECIFICATION.md).

---

## 1. The 9 Whiteboard Defense Questions

### Question 1: What problem does SyncSpace solve?
**Defense:**  
Modern collaborative boards often suffer from subtle, critical failures under concurrency: edits overwrite each other without warning (lost updates), task ordering breaks when two users reorder cards simultaneously, socket disconnections silently lose updates, and weak multi-tenant boundaries expose data across workspaces.

SyncSpace solves this by establishing explicit, verifiable engineering guarantees:
- PostgreSQL is the sole authoritative source of truth.
- State mutations and event publication commit atomically in the same database transaction.
- Task-level optimistic concurrency (`expectedVersion`) prevents silent overwrites with `409 VERSION_CONFLICT`.
- Fractional indexing with transactional row locking guarantees deterministic, atomic task moves.
- Real-time WebSockets deliver at-least-once notifications with monotonic client-side catch-up to ensure zero lost updates after reconnects.
- Strict service-layer authorization guarantees multi-tenant workspace isolation.

---

### Question 2: How does data flow through the system?
**Defense:**  
Data flows through three distinct, coordinated pathways:

```mermaid
flowchart TD
    subgraph Path1["1. State Mutation Pathway (HTTP)"]
        ClientA["Client A"] -->|POST /api/tasks/:id/move + expectedVersion| Gateway["API Gateway (Fastify/Hono)"]
        Gateway -->|Validate Zod + Better Auth| Service["Service Layer"]
        Service -->|Begin TX: Lock last_seq + Update Task + Insert Event + NOTIFY| DB[(PostgreSQL)]
        DB -->|Commit Confirmed| Service
        Service -->|200 OK + Updated Snapshot| ClientA
    end

    subgraph Path2["2. Real-Time Notification Pathway (WebSockets)"]
        DB -->|Post-Commit NOTIFY 'project_events'| Listener["Dedicated LISTEN Connection"]
        Listener -->|Wakeup| DeliveryLoop["Per-Instance Delivery Loop"]
        DeliveryLoop -->|Read project_events past local cursor| DB
        DeliveryLoop -->|Direct DB check: Verify subscriber membership| DB
        DeliveryLoop -->|Deliver event (seq, snapshot) to local sockets| ClientB["Client B (Subscribed)"]
        DeliveryLoop -->|Advance local instance cursor| DeliveryLoop
    end

    subgraph Path3["3. Recovery Pathway (Catch-up / Polling)"]
        ClientOffline["Reconnecting Client"] -->|GET /api/projects/:id/changes?after=lastAppliedSeq| CatchUpAPI["Catch-Up Endpoint"]
        CatchUpAPI -->|Query project_events| DB
        CatchUpAPI -->|Return missed event stream| ClientOffline
        FallbackPoll["1s Background Poll Loop"] -->|Query events past instance cursor| DB
        FallbackPoll -->|Recover dropped NOTIFY signals| DeliveryLoop
    end
```

---

### Question 3: Why was this approach chosen?
**Defense:**  
The modular monolith architecture with PostgreSQL as the unified persistence and signaling layer was chosen because:
1. **Elimination of the Dual-Write Problem:** In systems using external message brokers (e.g., PostgreSQL + Kafka/Redis), writing to the database and publishing to the broker cannot be made atomic without complex two-phase commit protocols or outbox polling lag. In SyncSpace, domain changes and events commit in the exact same PostgreSQL transaction.
2. **Operational Simplicity:** A single database engine provides storage, ACID transactions, monotonic sequences, full-text search, and pub/sub signaling (`LISTEN/NOTIFY`), dramatically lowering operational overhead.
3. **Decoupled Process Boundaries:** Separating the persistent Node.js backend from the Next.js frontend avoids the architectural flaws of running stateful WebSockets or long-lived database listeners in ephemeral serverless functions.

---

### Question 4: What alternatives were considered and why were they rejected?
**Defense:**  
- **Alternative A: Redis Pub/Sub + External Cache.**  
  *Rejected:* Redis is not durable by default, does not participate in PostgreSQL ACID transactions, and introduces split-brain risks and cache invalidation complexities. PostgreSQL `LISTEN/NOTIFY` plus fallback polling provides equal signaling capability with zero added infrastructure.
- **Alternative B: Microservices with Kafka.**  
  *Rejected:* Distributed architectures introduce eventual consistency across service boundaries, distributed transactions (sagas), network serialization latency, and immense deployment overhead unnecessary for v1.
- **Alternative C: Native PostgreSQL Sequences (`CREATE SEQUENCE`).**  
  *Rejected:* Native sequences allocate numbers before commit and do not guarantee contiguous, ordered commits under concurrent transactions. Transaction B can allocate sequence 6 and commit before Transaction A (sequence 5), causing clients to skip sequence 5. Row-locking `projects.last_seq` guarantees gap-free, monotonic sequence commits.
- **Alternative D: Automatic 3-Way Field Merging / CRDTs.**  
  *Rejected:* Operational Transformation and CRDTs introduce massive code complexity and produce confusing semantic states (e.g., merging a task move with a task deletion). SyncSpace prioritizes simple, predictable, and testable optimistic concurrency: first write wins, second write receives `409` and reapplies.

---

### Question 5: What happens during concurrent requests?
**Defense:**  
- **Concurrent Edits on the Same Task:**  
  Both requests supply `expectedVersion = N`. The first transaction to acquire the task row lock succeeds, updates the task, and increments `version = N + 1`. The second transaction evaluates `WHERE version = N`, finds 0 matching rows, and aborts with `409 VERSION_CONFLICT`.
- **Concurrent Moves to the Same Position:**  
  Both transactions attempt to move tasks into the same column slot. Moves serialize on the project's sequence counter (`SELECT last_seq FOR UPDATE`). The second move re-evaluates the neighboring anchor tasks' rank keys after acquiring the lock, computing a distinct midpoint key. If key length exceeds 32 characters, column rebalancing normalizes keys cleanly.
- **Concurrent Creation with Same Idempotency Key:**  
  Both requests race under `READ COMMITTED`. The first transaction acquires the project lock, inserts the task, and inserts the idempotency record. The second transaction hits the unique constraint on `(actor_id, endpoint_key, idempotency_key)`, catches the conflict, re-reads the committed record in a fresh query, verifies matching request hashes, and returns the cached response without creating a duplicate.

---

### Question 6: How could someone abuse or break it?
**Defense:**  
| Attack Vector | Potential Impact | Built-in Mitigation |
| :--- | :--- | :--- |
| **Cross-Tenant ID Probing (IDOR)** | Exfiltrate private tasks from another workspace | Service layer validates workspace membership on every request; unauthorized queries return `404 NOT_FOUND` to prevent UUID enumeration. |
| **Cross-Site WebSocket Hijacking (CSWSH)** | Steal live event stream via victim's browser | Strict handshake validation checks `Origin` against an explicit allowlist and authenticates session cookies. |
| **Hot Project Contention Abuse** | DoS attack by flooding concurrent mutations on one project | Serialized sequence row locks queue writers; database transaction timeouts terminate stalled requests; rate limiting throttles abusive clients. |
| **Rank Key Growth Bloating** | Degrading sort performance by generating massive string keys | Columns automatically trigger rebalancing within the move transaction whenever any rank key exceeds 32 characters. |
| **Zombie Connection Exploitation** | Removed member retains active WebSocket connection | Member removal emits `NOTIFY 'membership_changes'`; dispatcher immediately terminates affected sockets and checks PostgreSQL before every event dispatch. |

---

### Question 7: How does the system detect and recover from failure?
**Defense:**  
- **Dropped `NOTIFY` Signals:** The 1-second per-instance polling loop detects un-notified committed events in `project_events` and delivers them to local sockets within ~1 second.
- **WebSocket Disconnects / Network Drops:** Clients detect disconnection, reconnect with exponential backoff and jitter, and call `GET /api/projects/:projectId/changes?after=<lastAppliedSeq>` to replay missed events.
- **Out-of-Order Events / Sequence Gaps:** Clients buffer forward events; if a sequence gap is detected, they pause event processing and query the catch-up endpoint to fill the gap.
- **Server Process Crashes:** Application state is stateless except for ephemeral local socket connections; all durable state is in PostgreSQL. Rebooted instances reconnect, re-register `LISTEN`, and clients reconnect and catch up from PostgreSQL.

---

### Question 8: How can we verify the behavior?
**Defense:**  
Verification is executed through automated, reproducible test suites against a real PostgreSQL test database:
- **Unit Tests:** Verify permission matrices, Zod schemas, fractional indexing midpoints, and idempotency hashing algorithms.
- **Integration Tests:** Verify atomic co-commit and rollback (verifying 0 orphan events on error), gap-free monotonic sequence allocation, stale-write rejection, and cross-workspace isolation across all 8 resource categories.
- **Concurrency Latch Tests:** Use synchronization latches to force deliberate database overlaps (simultaneous edits, moves, sequence allocations, dropped notifications, duplicate event deduplication, and active socket revocation).
- **End-to-End Tests:** Playwright tests running two isolated browser contexts observing real-time updates and verifying catch-up after simulated offline periods.
- **Performance Benchmark:** 50 simulated concurrent clients, 20 mutations/second sustained for 60 seconds, measuring p95 latencies and zero lost events.

---

### Question 9: How can the change be safely reversed?
**Defense:**  
- **Transaction Rollback:** PostgreSQL automatically aborts partial mutations upon error; no committed rows or sequence increments persist.
- **Optimistic UI Rollback:** Clients retain local pre-mutation snapshots; upon receiving `409 VERSION_CONFLICT`, the UI reverts the visual card while preserving typed form input in place.
- **Non-Destructive Migrations:** Database schema migrations adhere to expand-and-contract patterns; columns are added as nullable or with defaults before application code deployment.
- **Decoupled Application Rollbacks:** Persistent Node.js container images can be rolled back to prior Git tags without breaking database compatibility or frontend presentation.

---

## 2. Skeptical Reviewer Checklist

Before declaring any architectural milestone complete, verify every item:
- [ ] Is PostgreSQL the single source of truth? (No state required from Redis or in-memory caches).
- [ ] Does every project mutation commit atomically with its `project_events` row?
- [ ] Is `expectedVersion` validated on all task edits and moves?
- [ ] Are cross-workspace requests rejected with `404 NOT_FOUND`?
- [ ] Does WebSocket origin validation strictly reject unauthorized origins?
- [ ] Are event sequence numbers strictly contiguous and gap-free?
- [ ] Does client catch-up cleanly recover missed events after a network drop?
- [ ] Does the 1-second polling loop successfully recover dropped notifications?
- [ ] Are idempotency keys enforced on task and comment creation?
- [ ] Are all database queries parameterized through Drizzle ORM?

