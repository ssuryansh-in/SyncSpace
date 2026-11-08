import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/index.js";
import { projectEvents, projects, type ProjectEvent } from "../db/schema/index.js";
import { AppError } from "../errors/index.js";

export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type DbOrTx = Database | Transaction;

// ============================================================================
// Event Schema Definitions & Privacy Rules
// Reference: docs/SPECIFICATION.md Section 7.1, 7.3, 8.3, 8.6; docs/DATA.md Section 2.4
// ============================================================================

export const uuidSchema = z.string().uuid("Invalid UUID format");

export const dateOrStringSchema = z.union([
  z.string(),
  z.date().transform((d) => d.toISOString()),
]);

export const EVENT_TYPES = [
  "task.created",
  "task.updated",
  "task.moved",
  "task.archived",
  "task.restored",
  "project.updated",
  "project.archived",
  "project.restored",
  "comment.created",
  "comment.deleted",
  "column.rebalanced",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const ENTITY_TYPES = ["task", "project", "comment", "column"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const ENTITY_TYPE_FOR_EVENT_TYPE: Record<EventType, EntityType> = {
  "task.created": "task",
  "task.updated": "task",
  "task.moved": "task",
  "task.archived": "task",
  "task.restored": "task",
  "project.updated": "project",
  "project.archived": "project",
  "project.restored": "project",
  "comment.created": "comment",
  "comment.deleted": "comment",
  "column.rebalanced": "column",
};

// --- Task Snapshot & Diff Schemas ---
// Canonical task snapshot carried by every task.* event (SPEC Section 8.6)
export const taskSnapshotSchema = z.object({
  id: uuidSchema,
  projectId: uuidSchema,
  columnId: uuidSchema,
  title: z.string().min(1, "Title cannot be empty").max(255, "Title cannot exceed 255 characters"),
  description: z.string().max(10000, "Description cannot exceed 10000 characters"),
  createdBy: uuidSchema,
  assigneeId: uuidSchema.nullable(),
  rankKey: z.string().min(1, "Rank key cannot be empty"),
  version: z.number().int().positive("Version must be a positive integer"),
  dueDate: z.string().nullable(),
  createdAt: dateOrStringSchema,
  updatedAt: dateOrStringSchema,
  archivedAt: dateOrStringSchema.nullable(),
});

export type TaskSnapshot = z.infer<typeof taskSnapshotSchema>;

export const descriptionChangeSchema = z.object({
  changed: z.literal(true),
});

export const fieldChangeSchema = z.object({
  from: z.unknown(),
  to: z.unknown(),
});

export const fieldInitialChangeSchema = z.object({
  to: z.unknown(),
});

// Privacy invariant: Task description changes must NEVER embed previous or new description text (SPEC Section 8.3)
export const taskChangesSchema = z
  .record(
    z.string(),
    z.union([
      descriptionChangeSchema,
      fieldChangeSchema,
      fieldInitialChangeSchema,
    ])
  )
  .superRefine((val, ctx) => {
    if ("description" in val) {
      const descVal = val["description"] as Record<string, unknown>;
      if (
        !descVal ||
        descVal["changed"] !== true ||
        "from" in descVal ||
        "to" in descVal
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'Task description changes must strictly be { description: { changed: true } } and cannot contain "from" or "to" text',
          path: ["description"],
        });
      }
    }
  });

export const taskCreatedPayloadSchema = z.object({
  task: taskSnapshotSchema,
  changes: taskChangesSchema,
});

export const taskUpdatedPayloadSchema = z.object({
  task: taskSnapshotSchema,
  changes: taskChangesSchema,
});

export const taskMovedPayloadSchema = z.object({
  task: taskSnapshotSchema,
  changes: taskChangesSchema,
});

export const taskArchivedPayloadSchema = z.object({
  task: taskSnapshotSchema,
  changes: taskChangesSchema,
});

export const taskRestoredPayloadSchema = z.object({
  task: taskSnapshotSchema,
  changes: taskChangesSchema,
});

// --- Project Event Schemas ---
export const projectSnapshotSchema = z.object({
  id: uuidSchema,
  workspaceId: uuidSchema,
  name: z.string().min(1, "Project name cannot be empty").max(100, "Project name cannot exceed 100 characters"),
  archivedAt: dateOrStringSchema.nullable(),
  lastSeq: z.number().int().nonnegative("lastSeq must be non-negative"),
  createdBy: uuidSchema.optional(),
  createdAt: dateOrStringSchema.optional(),
  updatedAt: dateOrStringSchema.optional(),
});

export type ProjectSnapshot = z.infer<typeof projectSnapshotSchema>;

export const projectUpdatedPayloadSchema = z.object({
  project: projectSnapshotSchema,
  changes: z.record(z.string(), fieldChangeSchema),
});

export const projectArchivedPayloadSchema = z.object({
  project: projectSnapshotSchema,
  changes: z.record(z.string(), fieldChangeSchema),
});

export const projectRestoredPayloadSchema = z.object({
  project: projectSnapshotSchema,
  changes: z.record(z.string(), fieldChangeSchema),
});

// --- Comment Event Schemas ---
// Privacy invariant: Comment bodies must NEVER be accepted into event payloads (SPEC Section 8.3, ADR-07)
export const commentCreatedPayloadSchema = z
  .object({
    commentId: uuidSchema,
    taskId: uuidSchema,
    authorId: uuidSchema,
    createdAt: dateOrStringSchema,
  })
  .strict();

export const commentDeletedPayloadSchema = z
  .object({
    commentId: uuidSchema,
    taskId: uuidSchema,
    authorId: uuidSchema,
    deletedAt: dateOrStringSchema,
  })
  .strict();

// --- Column Ordering Event Schema ---
// First-class ordering event emitted before move event during rebalancing (SPEC Section 7.3, DATA.md Section 2.3)
export const columnRebalancedPayloadSchema = z.object({
  columnId: uuidSchema,
  rankKeyMap: z.record(uuidSchema, z.string().min(1, "Rank key cannot be empty")),
});

export const EVENT_PAYLOAD_SCHEMAS: Record<EventType, z.ZodTypeAny> = {
  "task.created": taskCreatedPayloadSchema,
  "task.updated": taskUpdatedPayloadSchema,
  "task.moved": taskMovedPayloadSchema,
  "task.archived": taskArchivedPayloadSchema,
  "task.restored": taskRestoredPayloadSchema,
  "project.updated": projectUpdatedPayloadSchema,
  "project.archived": projectArchivedPayloadSchema,
  "project.restored": projectRestoredPayloadSchema,
  "comment.created": commentCreatedPayloadSchema,
  "comment.deleted": commentDeletedPayloadSchema,
  "column.rebalanced": columnRebalancedPayloadSchema,
};

export const baseEventInputSchema = z.object({
  projectId: uuidSchema,
  actorId: uuidSchema,
  eventType: z.enum(EVENT_TYPES, {
    errorMap: () => ({ message: "Invalid or unsupported event type" }),
  }),
  entityType: z.enum(ENTITY_TYPES, {
    errorMap: () => ({ message: "Invalid entity type" }),
  }),
  entityId: uuidSchema,
  payload: z.record(z.string(), z.unknown()),
});

export interface AppendProjectEventInput<T = Record<string, unknown>> {
  projectId: string;
  actorId: string;
  eventType: string;
  entityType: string;
  entityId: string;
  payload: T;
  updatedAt?: Date | undefined;
}

/**
 * Validates an event input against schema definitions, entity-event consistency, and privacy invariants.
 * Throws AppError.badRequest (VALIDATION_ERROR / 400) if validation fails.
 */
export function validateEventInput<T = Record<string, unknown>>(
  input: AppendProjectEventInput<T>
): AppendProjectEventInput<T> {
  const baseParsed = baseEventInputSchema.safeParse(input);
  if (!baseParsed.success) {
    throw AppError.badRequest(
      "Invalid event input: " +
        baseParsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", "),
      baseParsed.error.flatten()
    );
  }

  const { eventType, entityType } = baseParsed.data;
  const expectedEntityType = ENTITY_TYPE_FOR_EVENT_TYPE[eventType as EventType];

  if (!expectedEntityType) {
    throw AppError.badRequest(`Unsupported event type: "${eventType}"`);
  }

  if (entityType !== expectedEntityType) {
    throw AppError.badRequest(
      `Entity type mismatch: event type "${eventType}" requires entity type "${expectedEntityType}", received "${entityType}"`
    );
  }

  const payloadSchema = EVENT_PAYLOAD_SCHEMAS[eventType as EventType];
  const payloadParsed = payloadSchema.safeParse(input.payload);
  if (!payloadParsed.success) {
    throw AppError.badRequest(
      `Invalid payload for event type "${eventType}": ` +
        payloadParsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", "),
      payloadParsed.error.flatten()
    );
  }

  return {
    ...input,
    payload: payloadParsed.data as T,
  };
}

// ============================================================================
// Event Service
// Reference: docs/SPECIFICATION.md Section 8.1 - 8.4; docs/DECISIONS.md ADR-02, 03, 04
// ============================================================================

export class EventService {
  /**
   * Appends a validated domain event to project_events strictly inside the caller's transaction.
   *
   * Transaction & Locking Architecture:
   * 1. Requires an existing caller-owned Drizzle transaction (`tx`). Never creates or commits transactions.
   * 2. Acquires an exclusive row lock on the project (SELECT id, last_seq FROM projects WHERE id = :id FOR UPDATE).
   *    In accordance with the established lock hierarchy (workspaces -> projects -> columns -> tasks -> comments),
   *    callers modifying child entities must ensure this lock is acquired before child row locks.
   * 3. Increments projects.last_seq by exactly one.
   * 4. Inserts the event row into project_events using the allocated sequence number.
   * 5. Issues a transactional PostgreSQL notification: pg_notify('project_events', '{"projectId":"...","seq":...}').
   * 6. PostgreSQL guarantees that notifications are buffered and delivered only upon successful transaction commit.
   *    If the caller's transaction rolls back, all sequence increments, event rows, and notifications are discarded.
   *
   * @param tx Caller-owned Drizzle transaction
   * @param input Event data including projectId, actorId, eventType, entityType, entityId, payload
   * @returns Persisted ProjectEvent record
   */
  static async appendProjectEvent(
    tx: DbOrTx,
    input: AppendProjectEventInput
  ): Promise<ProjectEvent> {
    // 1. Validate event schema, entity-event agreement, and privacy rules
    const validated = validateEventInput(input);

    // 2. Lock project row and read current sequence
    const [project] = await (tx
      .select({ id: projects.id, lastSeq: projects.lastSeq })
      .from(projects)
      .where(eq(projects.id, validated.projectId)) as any).for("update");

    if (!project) {
      throw AppError.notFound("Project not found");
    }

    // 3. Allocate next sequence number
    const nextSeq = project.lastSeq + 1;

    // 4. Update project last_seq
    await tx
      .update(projects)
      .set({
        lastSeq: nextSeq,
        updatedAt: input.updatedAt ?? new Date(),
      })
      .where(eq(projects.id, validated.projectId));

    // 5. Insert event row into project_events
    const [event] = await tx
      .insert(projectEvents)
      .values({
        projectId: validated.projectId,
        seq: nextSeq,
        actorId: validated.actorId,
        eventType: validated.eventType,
        entityType: validated.entityType,
        entityId: validated.entityId,
        payload: validated.payload,
      })
      .returning();

    if (!event) {
      throw new Error("Failed to insert project event");
    }

    // 6. Issue PostgreSQL transactional notification
    const notificationPayload = JSON.stringify({
      projectId: validated.projectId,
      seq: nextSeq,
    });

    await tx.execute(
      sql`SELECT pg_notify('project_events', ${notificationPayload})`
    );

    return event;
  }

  /**
   * Appends multiple validated domain events sequentially within the same transaction.
   * Each event receives a strictly consecutive sequence number (e.g. S, S+1).
   * Used for operations such as column rebalancing followed by task movement.
   */
  static async appendProjectEvents(
    tx: DbOrTx,
    inputs: AppendProjectEventInput[]
  ): Promise<ProjectEvent[]> {
    const results: ProjectEvent[] = [];
    for (const input of inputs) {
      const event = await this.appendProjectEvent(tx, input);
      results.push(event);
    }
    return results;
  }
}

export const appendProjectEvent = EventService.appendProjectEvent.bind(EventService);
export const appendProjectEvents = EventService.appendProjectEvents.bind(EventService);
