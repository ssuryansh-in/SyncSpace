# SyncSpace — Engineering Rules

## 1. Project Mission

Build SyncSpace, a dependable real-time collaborative project-management application.

The approved engineering specification is `docs/SPECIFICATION.md`. Treat it as the source of truth for product scope and required engineering behavior.

Before implementation, inspect the specification and identify its applicable requirements.

Do not silently change approved architectural decisions or remove requirements to simplify implementation.

## 2. Required Engineering Principles

- Understand existing code before modifying it.
- Prefer simple, maintainable solutions over unnecessary abstractions.
- Make small, reviewable changes.
- Explain significant decisions and trade-offs.
- Never claim that untested code works.
- Distinguish verified facts from assumptions.
- Document limitations and unresolved questions.
- Do not add features outside the approved scope without asking.

## 3. Technology Stack

Follow the project specification:

- Frontend: Next.js, React, TypeScript.
- Backend: long-running Node.js server using Fastify or Hono.
- Database: PostgreSQL.
- Database access: Drizzle ORM.
- Authentication: Better Auth.
- Input validation: Zod.
- Unit and integration testing: Vitest.
- Browser end-to-end testing: Playwright.
- Real-time communication: WebSockets.
- Durable project events: PostgreSQL project_events table.
- Event notifications and recovery: PostgreSQL LISTEN/NOTIFY plus polling.

Do not introduce Redis, Kafka, microservices, Kubernetes, or a separate event-streaming platform for v1.

If a technology choice remains unresolved in the specification, explain the options and recommend one before implementation.

## 4. Security Requirements

- Authenticate users before accessing protected resources.
- Enforce workspace membership and role permissions on the server.
- Never trust a client-supplied resource ID as proof of authorization.
- Validate all API inputs using schemas.
- Use parameterized database queries.
- Protect cookie-authenticated mutations against CSRF.
- Validate WebSocket Origin and authenticate connections.
- Recheck authorization for WebSocket subscriptions and data delivery.
- Rate-limit sensitive and expensive endpoints.
- Never commit secrets or expose credentials in logs.
- Do not implement custom password hashing or session cryptography.
- Do not access production systems or deploy without explicit approval.

Every resource category must have cross-workspace authorization tests.

## 5. Database and Consistency Rules

- PostgreSQL is the source of truth.
- Use explicit transactions for domain mutations.
- A successful project mutation and its corresponding durable event must commit in the same transaction.
- A rolled-back mutation must not leave a committed event.
- Use task versions and expectedVersion checks to prevent stale writes.
- Return the specified conflict response rather than silently overwriting newer changes.
- Make task moves atomic.
- Use idempotency keys for task and comment creation as specified.
- Allocate project event sequences transactionally.
- Do not claim exactly-once WebSocket delivery.
- Clients must handle duplicate events and recover missing events.
- Follow the approved schema, authorization, and consistency requirements.

Database migrations must be reviewed before application. Never run destructive database commands without explicit approval.

## 6. Implementation Workflow

Before a significant task:

1. Read the relevant specification sections.
2. Inspect the existing implementation.
3. Explain the intended change and affected files.
4. Identify alternatives, security risks, and failure modes.
5. Identify tests that will verify the change.
6. Ask for approval before high-risk or irreversible operations.

For approved changes:

1. Implement one small, coherent unit of work.
2. Add or update tests.
3. Run the relevant checks.
4. Inspect the final diff.
5. Update documentation where necessary.
6. Summarize the result.

Do not bundle unrelated refactoring into feature work.

## 7. Testing Rules

Write tests alongside features.

Prioritize:

- Permission policy tests.
- Input validation tests.
- Cross-workspace isolation tests.
- PostgreSQL transaction and rollback tests.
- Stale-write and concurrency tests.
- Idempotency tests.
- Event ordering and recovery tests.
- WebSocket authorization and revocation tests.
- Browser end-to-end tests.

Report the exact test commands executed and their actual outcomes.

Never describe a test as passing if it was not run successfully.

Do not use production data for testing.

## 8. Documentation

Keep relevant project documentation current:

- README.md: setup, commands, environment variables, and usage.
- docs/SPECIFICATION.md: approved requirements.
- docs/ARCHITECTURE.md: components, boundaries, and data flow.
- docs/DECISIONS.md: architectural decisions and rationale.
- docs/CONSTRAINTS.md: fixed requirements and restrictions.
- docs/TESTING.md: test strategy and verification commands.
- docs/THREAT.md: security boundaries and abuse scenarios.
- docs/FAILURE.md: failure handling and recovery.
- docs/DATA.md: data model, ownership, and sensitive-data handling.
- docs/ROLLBACK.md: safe rollback and recovery procedures.
- docs/defense/DEFENSE.md: explanations needed to defend engineering choices.

Do not invent implementation details in documentation. Mark unverified details as unknown or planned.

## 9. Approval Boundaries

Always pause and request explicit approval before:

- Deleting or destructively changing data.
- Applying risky or irreversible migrations.
- Changing authentication or authorization boundaries substantially.
- Changing production configuration or infrastructure.
- Deploying the application.
- Force-pushing or rewriting shared Git history.
- Introducing a major dependency or changing an approved architectural decision.

Routine, reversible work can proceed within an explicitly approved task.

## 10. Completion Report

At the end of each task, report:

- What changed.
- Why it changed.
- Files affected.
- Tests actually executed and their results.
- Security implications.
- Assumptions and remaining limitations.
- Documentation updated.
- Rollback considerations, where relevant.

## 11. Whiteboard Defense

For every important feature, be prepared to explain:

1. What problem does it solve?
2. How does data flow through the system?
3. Why was this approach chosen?
4. What alternatives were considered?
5. What happens during concurrent requests?
6. How could someone abuse or break it?
7. How does the system detect and recover from failure?
8. How can we verify the behavior?
9. How can the change be safely reversed?

If these questions cannot be answered, investigate before declaring the feature complete.