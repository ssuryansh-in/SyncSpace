import { and, asc, count, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { projectColumns, projects, tasks, workspaceMembers, type Task } from "../db/schema/index.js";
import { AppError } from "../errors/index.js";
import { computeRequestHash, IdempotencyService } from "./idempotency.js";
import {
  generateRankKey,
  generateNRankKeys,
  REBALANCE_THRESHOLD_LENGTH,
} from "../utils/fractional-indexing.js";

export interface CreateTaskParams {
  projectId: string;
  callerId: string;
  title: string;
  columnId: string;
  description?: string | undefined;
  assigneeId?: string | null | undefined;
  dueDate?: string | null | undefined;
  idempotencyKey: string;
  requestPath: string;
}

export interface ListTasksParams {
  projectId: string;
  callerId: string;
  columnId?: string | undefined;
  assigneeId?: string | undefined;
}

export interface GetTaskParams {
  taskId: string;
  callerId: string;
}

export interface UpdateTaskParams {
  taskId: string;
  callerId: string;
  expectedVersion: number;
  title?: string | undefined;
  description?: string | undefined;
  assigneeId?: string | null | undefined;
  dueDate?: string | null | undefined;
}

export interface MoveTaskParams {
  taskId: string;
  callerId: string;
  expectedVersion: number;
  columnId: string;
  prevTaskId?: string | null | undefined;
  nextTaskId?: string | null | undefined;
}

export interface ArchiveTaskParams {
  taskId: string;
  callerId: string;
}

export interface RestoreTaskParams {
  taskId: string;
  callerId: string;
}

// ============================================================================
// Canonical Task Snapshot & Diff Helpers (Milestone 7.2A)
// Reference: docs/SPECIFICATION.md Section 8.3, 8.6; docs/DATA.md Section 2.4
// ============================================================================

export interface CanonicalTaskSnapshot {
  id: string;
  projectId: string;
  columnId: string;
  title: string;
  description: string;
  createdBy: string;
  assigneeId: string | null;
  rankKey: string;
  version: number;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export type TaskChangeValue =
  | { changed: true }
  | { from: unknown; to: unknown }
  | { to: unknown };

export type TaskChanges = Record<string, TaskChangeValue>;

/**
 * Builds the canonical task snapshot carried by every task.* project event.
 * Conforms strictly to docs/SPECIFICATION.md Section 8.6.
 * Pure, deterministic, side-effect free.
 */
export function buildTaskSnapshot(task: Task): CanonicalTaskSnapshot {
  return {
    id: task.id,
    projectId: task.projectId,
    columnId: task.columnId,
    title: task.title,
    description: task.description,
    createdBy: task.createdBy,
    assigneeId: task.assigneeId ?? null,
    rankKey: task.rankKey,
    version: task.version,
    dueDate: task.dueDate ?? null,
    createdAt: task.createdAt instanceof Date ? task.createdAt.toISOString() : new Date(task.createdAt).toISOString(),
    updatedAt: task.updatedAt instanceof Date ? task.updatedAt.toISOString() : new Date(task.updatedAt).toISOString(),
    archivedAt: task.archivedAt
      ? task.archivedAt instanceof Date
        ? task.archivedAt.toISOString()
        : new Date(task.archivedAt).toISOString()
      : null,
  };
}

/**
 * Builds the diff (changes) object comparing before-state and after-state of a task.
 * Conforms strictly to docs/SPECIFICATION.md Section 8.3.
 * Privacy Invariant: Description text NEVER appears in changes; strictly uses { description: { changed: true } }.
 * Pure, deterministic, side-effect free.
 */
export function buildTaskChanges(before: Task, after: Task): TaskChanges {
  const changes: TaskChanges = {};

  if (before.title !== after.title) {
    changes["title"] = { from: before.title, to: after.title };
  }

  if (before.description !== after.description) {
    changes["description"] = { changed: true };
  }

  if (before.columnId !== after.columnId) {
    changes["columnId"] = { from: before.columnId, to: after.columnId };
  }

  const beforeAssignee = before.assigneeId ?? null;
  const afterAssignee = after.assigneeId ?? null;
  if (beforeAssignee !== afterAssignee) {
    changes["assigneeId"] = { from: beforeAssignee, to: afterAssignee };
  }

  const beforeDueDate = before.dueDate ?? null;
  const afterDueDate = after.dueDate ?? null;
  if (beforeDueDate !== afterDueDate) {
    changes["dueDate"] = { from: beforeDueDate, to: afterDueDate };
  }

  if (before.rankKey !== after.rankKey) {
    changes["rankKey"] = { from: before.rankKey, to: after.rankKey };
  }

  const beforeArchived = before.archivedAt
    ? before.archivedAt instanceof Date
      ? before.archivedAt.toISOString()
      : new Date(before.archivedAt).toISOString()
    : null;
  const afterArchived = after.archivedAt
    ? after.archivedAt instanceof Date
      ? after.archivedAt.toISOString()
      : new Date(after.archivedAt).toISOString()
    : null;
  if (beforeArchived !== afterArchived) {
    changes["archivedAt"] = { from: beforeArchived, to: afterArchived };
  }

  return changes;
}

/**
 * Builds the initial changes object for task.created.
 * In accordance with docs/SPECIFICATION.md Section 8.3, omits 'from' and includes only 'to'.
 * Privacy Invariant: Description uses { changed: true }, never raw text.
 * Pure, deterministic, side-effect free.
 */
export function buildTaskCreatedChanges(task: Task): TaskChanges {
  const changes: TaskChanges = {
    title: { to: task.title },
    columnId: { to: task.columnId },
    rankKey: { to: task.rankKey },
  };

  if (task.description && task.description.length > 0) {
    changes["description"] = { changed: true };
  }

  if (task.assigneeId) {
    changes["assigneeId"] = { to: task.assigneeId };
  }

  if (task.dueDate) {
    changes["dueDate"] = { to: task.dueDate };
  }

  return changes;
}

/**
 * Domain service managing task creation, retrieval, editing, movement, and lifecycle.
 * Reference: docs/SPECIFICATION.md Section 4.2, 6.4, 7.2, 7.3, 7.4, 9.6, 10.3
 */
export class TaskService {
  /**
   * Helper to retrieve a task, its parent project, and verify caller workspace membership.
   * Conceals non-existent tasks or non-member access with 404 NOT_FOUND.
   * Supports row-level locking via FOR UPDATE when inside a transaction.
   */
  private static async getTaskWithContext(
    dbOrTx: Database,
    taskId: string,
    callerId: string,
    forUpdate = false
  ) {
    let taskQuery = dbOrTx
      .select()
      .from(tasks)
      .where(eq(tasks.id, taskId));

    if (forUpdate) {
      taskQuery = (taskQuery as any).for("update");
    }

    const [task] = await taskQuery;

    if (!task) {
      throw AppError.notFound("Task not found");
    }

    const [project] = await dbOrTx
      .select()
      .from(projects)
      .where(eq(projects.id, task.projectId));

    if (!project) {
      throw AppError.notFound("Task not found");
    }

    const [membership] = await dbOrTx
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, project.workspaceId),
          eq(workspaceMembers.userId, callerId)
        )
      );

    if (!membership) {
      throw AppError.notFound("Task not found");
    }

    return { task, project, membership };
  }

  /**
   * Rebalances fractional rank keys of active tasks within a specific column.
   * Triggered when a newly generated candidate rank key exceeds REBALANCE_THRESHOLD_LENGTH (32 chars).
   * - Only active tasks (archivedAt IS NULL) in destination column are rebalanced.
   * - Optionally excludes a moving task (excludeTaskId) so its intermediate state does not interfere.
   * - Locks all affected task rows in ascending ID order within the caller's project-locked transaction.
   * - Preserves existing task versions and timestamps (only rankKey is updated).
   * - Returns a mapping of taskId -> newRankKey so callers can immediately resolve fresh anchor rank keys.
   */
  private static async rebalanceColumnActiveTasks(
    tx: Database,
    {
      projectId,
      columnId,
      excludeTaskId,
    }: {
      projectId: string;
      columnId: string;
      excludeTaskId?: string | undefined;
    }
  ): Promise<Map<string, string>> {
    const conditions = [
      eq(tasks.projectId, projectId),
      eq(tasks.columnId, columnId),
      isNull(tasks.archivedAt),
    ];

    if (excludeTaskId) {
      conditions.push(ne(tasks.id, excludeTaskId));
    }

    const activeTasks = await tx
      .select({ id: tasks.id, rankKey: tasks.rankKey })
      .from(tasks)
      .where(and(...conditions))
      .orderBy(asc(tasks.rankKey), asc(tasks.id));

    if (activeTasks.length === 0) {
      return new Map();
    }

    const sortedTaskIds = activeTasks.map((t) => t.id).sort();
    await (tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(inArray(tasks.id, sortedTaskIds))
      .orderBy(asc(tasks.id)) as any).for("update");

    const newKeys = generateNRankKeys(null, null, activeTasks.length);
    const rebalancedMap = new Map<string, string>();

    for (let i = 0; i < activeTasks.length; i++) {
      const task = activeTasks[i]!;
      const newKey = newKeys[i]!;
      rebalancedMap.set(task.id, newKey);

      if (task.rankKey !== newKey) {
        await tx
          .update(tasks)
          .set({ rankKey: newKey })
          .where(eq(tasks.id, task.id));
      }
    }

    return rebalancedMap;
  }

  /**
   * Creates a new task in a project with full database-persisted idempotency.
   * - Requires an active project and an active workspace member (caller).
   * - Acquires exclusive row lock on projects table before idempotency check.
   * - Replays cached response if matching idempotency record exists (even if project was archived subsequently).
   * - Rejects conflicting request payload on existing idempotency key with 409 IDEMPOTENCY_KEY_REUSED.
   * - Rejects fresh task creation in archived projects with 409 PROJECT_ARCHIVED.
   * - Validates that columnId belongs to the project and assigneeId (if provided) is a workspace member.
   * - Conceals non-existent projects or non-member access with 404 NOT_FOUND.
   */
  static async createTask(
    db: Database,
    {
      projectId,
      callerId,
      title,
      columnId,
      description,
      assigneeId,
      dueDate,
      idempotencyKey,
      requestPath,
    }: CreateTaskParams
  ): Promise<{ task: Task; replayed: boolean }> {
    const endpointKey = "tasks:create";
    const payloadToHash = {
      title: title.trim(),
      columnId,
      description: description?.trim() ?? "",
      assigneeId: assigneeId ?? null,
      dueDate: dueDate ?? null,
    };
    const requestHash = computeRequestHash("POST", requestPath, payloadToHash);

    try {
      return await db.transaction(async (tx) => {
        // 1. Lock project row
        const [project] = await (tx
          .select()
          .from(projects)
          .where(eq(projects.id, projectId)) as any).for("update");

        // 2. Verify project exists
        if (!project) {
          throw AppError.notFound("Project not found");
        }

        // 3. Verify caller is an active workspace member (404 concealment)
        const [callerMembership] = await tx
          .select()
          .from(workspaceMembers)
          .where(
            and(
              eq(workspaceMembers.workspaceId, project.workspaceId),
              eq(workspaceMembers.userId, callerId)
            )
          );

        if (!callerMembership) {
          throw AppError.notFound("Project not found");
        }

        // 4. Check idempotency record under project row lock
        const cached = await IdempotencyService.check(tx, {
          actorId: callerId,
          endpointKey,
          idempotencyKey,
          requestHash,
        });

        if (cached) {
          return {
            task: (cached.body as { task: Task }).task,
            replayed: true,
          };
        }

        // 5. Fresh creation attempt: reject if project is archived
        if (project.archivedAt !== null) {
          throw AppError.conflict("PROJECT_ARCHIVED", "Cannot create tasks in an archived project");
        }

        // 6. Verify column exists and belongs to this project
        const [column] = await tx
          .select()
          .from(projectColumns)
          .where(eq(projectColumns.id, columnId));

        if (!column) {
          throw AppError.badRequest("Invalid column ID or column does not exist");
        }

        if (column.projectId !== projectId) {
          throw AppError.badRequest("Column does not belong to this project");
        }

        // 7. If assignee is provided, verify assignee is an active member of this workspace
        if (assigneeId) {
          const [assigneeMembership] = await tx
            .select()
            .from(workspaceMembers)
            .where(
              and(
                eq(workspaceMembers.workspaceId, project.workspaceId),
                eq(workspaceMembers.userId, assigneeId)
              )
            );

          if (!assigneeMembership) {
            throw AppError.badRequest("Assignee must be an active member of the workspace");
          }
        }

        // 8. Generate fractional rank key: append after the last active task in target column
        const [lastActiveTask] = await tx
          .select({ rankKey: tasks.rankKey })
          .from(tasks)
          .where(
            and(
              eq(tasks.projectId, projectId),
              eq(tasks.columnId, columnId),
              isNull(tasks.archivedAt)
            )
          )
          .orderBy(desc(tasks.rankKey), desc(tasks.id))
          .limit(1);

        let rankKey = generateRankKey(lastActiveTask ? lastActiveTask.rankKey : null, null);

        if (rankKey.length > REBALANCE_THRESHOLD_LENGTH) {
          await this.rebalanceColumnActiveTasks(tx, { projectId, columnId });
          const [freshLastActive] = await tx
            .select({ rankKey: tasks.rankKey })
            .from(tasks)
            .where(
              and(
                eq(tasks.projectId, projectId),
                eq(tasks.columnId, columnId),
                isNull(tasks.archivedAt)
              )
            )
            .orderBy(desc(tasks.rankKey), desc(tasks.id))
            .limit(1);

          rankKey = generateRankKey(freshLastActive ? freshLastActive.rankKey : null, null);
        }

        // 9. Insert task row
        const [task] = await tx
          .insert(tasks)
          .values({
            projectId,
            columnId,
            title: title.trim(),
            description: description?.trim() ?? "",
            createdBy: callerId,
            assigneeId: assigneeId ?? null,
            dueDate: dueDate ? dueDate : null,
            rankKey,
            version: 1,
          })
          .returning();

        if (!task) {
          throw new Error("Failed to create task");
        }

        // 10. Persist idempotency record in the same transaction
        await IdempotencyService.save(tx, {
          actorId: callerId,
          endpointKey,
          idempotencyKey,
          requestHash,
          responseStatus: 201,
          responseBody: { task },
        });

        return { task, replayed: false };
      });
    } catch (err: any) {
      // Catch concurrent unique constraint violation on idempotency_records (Postgres code 23505)
      if (
        err?.code === "23505" &&
        (err?.constraint === "idempotency_records_actor_endpoint_key_unique" ||
          err?.message?.includes("idempotency_records_actor_endpoint_key_unique"))
      ) {
        const cached = await IdempotencyService.check(db, {
          actorId: callerId,
          endpointKey,
          idempotencyKey,
          requestHash,
        });
        if (cached) {
          return {
            task: (cached.body as { task: Task }).task,
            replayed: true,
          };
        }
      }
      throw err;
    }
  }

  /**
   * Lists active tasks in a project for an active workspace member.
   * Excludes archived tasks by default (archived_at IS NULL).
   * Supports optional columnId and assigneeId filtering.
   * Conceals non-existent projects or non-member access with 404 NOT_FOUND.
   */
  static async listTasks(
    db: Database,
    {
      projectId,
      callerId,
      columnId,
      assigneeId,
    }: ListTasksParams
  ): Promise<Task[]> {
    // 1. Verify project exists
    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId));

    if (!project) {
      throw AppError.notFound("Project not found");
    }

    // 2. Verify caller is an active member of the parent workspace (404 concealment)
    const [membership] = await db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, project.workspaceId),
          eq(workspaceMembers.userId, callerId)
        )
      );

    if (!membership) {
      throw AppError.notFound("Project not found");
    }

    // 3. If columnId filter is provided, verify it belongs to this project
    if (columnId) {
      const [column] = await db
        .select()
        .from(projectColumns)
        .where(eq(projectColumns.id, columnId));

      if (!column || column.projectId !== projectId) {
        throw AppError.badRequest("Column does not belong to this project");
      }
    }

    // 4. Build query filters
    const conditions = [
      eq(tasks.projectId, projectId),
      isNull(tasks.archivedAt),
    ];

    if (columnId) {
      conditions.push(eq(tasks.columnId, columnId));
    }

    if (assigneeId) {
      conditions.push(eq(tasks.assigneeId, assigneeId));
    }

    const rows = await db
      .select()
      .from(tasks)
      .where(and(...conditions))
      .orderBy(asc(tasks.rankKey), asc(tasks.id));

    return rows;
  }

  /**
   * Retrieves task details by task ID.
   * Verifies caller membership in the task's parent workspace.
   * Non-members receive 404 NOT_FOUND.
   * Archived tasks can be retrieved for read-only history inspection.
   */
  static async getTask(
    db: Database,
    {
      taskId,
      callerId,
    }: GetTaskParams
  ): Promise<Task> {
    const { task } = await this.getTaskWithContext(db, taskId, callerId, false);
    return task;
  }

  static buildSnapshot = buildTaskSnapshot;
  static buildChanges = buildTaskChanges;
  static buildCreatedChanges = buildTaskCreatedChanges;

  /**
   * Updates task fields. Requires matching expectedVersion.
   * Rejects mutations on archived tasks with 409 TASK_ARCHIVED.
   * Rejects mutations in archived projects with 409 PROJECT_ARCHIVED.
   * Increments version and updates updatedAt if fields changed; no-op if identical values.
   *
   * Lock Hierarchy: workspaces -> projects -> columns -> tasks -> comments
   * Establishes project-first locking:
   * 1. Unlocked metadata lookup to discover projectId
   * 2. Project row lock using FOR UPDATE
   * 3. Authorization and tenant-concealment checks
   * 4. Task row lock using FOR UPDATE (verifying task.projectId === project.id)
   * 5. Archived-state and optimistic-version checks
   * 6. Assignee membership validation
   * 7. No-op detection
   * 8. Atomic task update
   */
  static async updateTask(
    db: Database,
    {
      taskId,
      callerId,
      expectedVersion,
      title,
      description,
      assigneeId,
      dueDate,
    }: UpdateTaskParams
  ): Promise<Task> {
    return await db.transaction(async (tx) => {
      // 1. Perform an unlocked lookup of the task to discover its projectId
      const [taskSnapshot] = await tx
        .select({ id: tasks.id, projectId: tasks.projectId })
        .from(tasks)
        .where(eq(tasks.id, taskId));

      if (!taskSnapshot) {
        throw AppError.notFound("Task not found");
      }

      // 2. Lock the project row using FOR UPDATE (establishing project-first lock order)
      const [project] = await (tx
        .select()
        .from(projects)
        .where(eq(projects.id, taskSnapshot.projectId)) as any).for("update");

      if (!project) {
        throw AppError.notFound("Task not found");
      }

      // 3. Authorization & Tenant Isolation check (conceals private projects from non-members)
      const [callerMembership] = await tx
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, project.workspaceId),
            eq(workspaceMembers.userId, callerId)
          )
        );

      if (!callerMembership) {
        throw AppError.notFound("Task not found");
      }

      if (project.archivedAt !== null) {
        throw AppError.conflict("PROJECT_ARCHIVED", "Cannot modify a task in an archived project");
      }

      // 4. Lock task row using FOR UPDATE (after project lock is held)
      const [task] = await (tx
        .select()
        .from(tasks)
        .where(eq(tasks.id, taskId)) as any).for("update");

      if (!task || task.projectId !== project.id) {
        throw AppError.notFound("Task not found");
      }

      // 5. Reject if task is archived
      if (task.archivedAt !== null) {
        throw AppError.conflict("TASK_ARCHIVED", "Cannot modify an archived task");
      }

      // 6. Validate expectedVersion
      if (task.version !== expectedVersion) {
        throw AppError.conflict("VERSION_CONFLICT", "This task changed since you loaded it.", {
          currentVersion: task.version,
        });
      }

      // 7. If assignee is provided and changed, verify assignee is an active workspace member
      if (assigneeId !== undefined && assigneeId !== null && assigneeId !== task.assigneeId) {
        const [assigneeMembership] = await tx
          .select()
          .from(workspaceMembers)
          .where(
            and(
              eq(workspaceMembers.workspaceId, project.workspaceId),
              eq(workspaceMembers.userId, assigneeId)
            )
          );

        if (!assigneeMembership) {
          throw AppError.badRequest("Assignee must be an active member of the workspace");
        }
      }

      // 8. Check for actual state changes (identifying no-op edits)
      const nextTitle = title !== undefined ? title.trim() : task.title;
      const nextDesc = description !== undefined ? description.trim() : task.description;
      const nextAssignee = assigneeId !== undefined ? assigneeId : task.assigneeId;
      const nextDueDate = dueDate !== undefined ? (dueDate || null) : task.dueDate;

      const hasChanged =
        nextTitle !== task.title ||
        nextDesc !== task.description ||
        nextAssignee !== task.assigneeId ||
        nextDueDate !== task.dueDate;

      if (!hasChanged) {
        // Idempotent no-op: preserve version and updatedAt
        return task;
      }

      // 9. Atomic update incrementing version exactly once
      const [updatedTask] = await tx
        .update(tasks)
        .set({
          title: nextTitle,
          description: nextDesc,
          assigneeId: nextAssignee,
          dueDate: nextDueDate,
          version: task.version + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(tasks.id, taskId),
            eq(tasks.version, task.version)
          )
        )
        .returning();

      if (!updatedTask) {
        throw AppError.conflict("VERSION_CONFLICT", "This task changed since you loaded it.", {
          currentVersion: task.version,
        });
      }

      return updatedTask;
    });
  }

  /**
   * Moves a task to a destination column and/or position using fractional indexing anchors.
   * Requires matching expectedVersion.
   * Anchor semantics:
   * - Both omitted/null: append to destination column.
   * - Only prevTaskId: insert immediately after it.
   * - Only nextTaskId: insert immediately before it.
   * - Both supplied: insert between them (must be adjacent after excluding moving task).
   * Same-position move in the same column is an idempotent no-op (preserves version, rankKey, and updatedAt).
   * Genuine move updates columnId, assigns fractional rankKey, increments version, and updates updatedAt.
   * Rejects moving an archived task with 409 TASK_ARCHIVED.
   * Rejects moving a task in an archived project with 409 PROJECT_ARCHIVED.
   * Rejects invalid/cross-project/archived/non-adjacent anchors with 400 VALIDATION_ERROR.
   */
  static async moveTask(
    db: Database,
    {
      taskId,
      callerId,
      columnId,
      expectedVersion,
      prevTaskId,
      nextTaskId,
    }: MoveTaskParams
  ): Promise<Task> {
    // 0. Anchor validation: self-anchor and duplicate check
    if (prevTaskId && prevTaskId === taskId) {
      throw AppError.badRequest("Moving task cannot be used as its own anchor");
    }
    if (nextTaskId && nextTaskId === taskId) {
      throw AppError.badRequest("Moving task cannot be used as its own anchor");
    }
    if (prevTaskId && nextTaskId && prevTaskId === nextTaskId) {
      throw AppError.badRequest("Anchors must be distinct");
    }

    return await db.transaction(async (tx) => {
      // 1. Perform an unlocked lookup of the moving task only to discover its project ID
      const [taskSnapshot] = await tx
        .select({ id: tasks.id, projectId: tasks.projectId })
        .from(tasks)
        .where(eq(tasks.id, taskId));

      if (!taskSnapshot) {
        throw AppError.notFound("Task not found");
      }

      // 2. Lock the project row using FOR UPDATE (top-level project serialization)
      const [project] = await (tx
        .select()
        .from(projects)
        .where(eq(projects.id, taskSnapshot.projectId)) as any).for("update");

      if (!project) {
        throw AppError.notFound("Task not found");
      }

      // 3. Validate caller membership and project lifecycle
      const [callerMembership] = await tx
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, project.workspaceId),
            eq(workspaceMembers.userId, callerId)
          )
        );

      if (!callerMembership) {
        // Conceal private resource existence from non-members
        throw AppError.notFound("Task not found");
      }

      if (project.archivedAt !== null) {
        throw AppError.conflict("PROJECT_ARCHIVED", "Cannot move a task in an archived project");
      }

      // 4. Lock moving task and supplied anchors in ascending task ID order (deduplicating IDs)
      const taskIdsToLock = [taskId];
      if (prevTaskId) taskIdsToLock.push(prevTaskId);
      if (nextTaskId) taskIdsToLock.push(nextTaskId);
      const sortedUniqueIds = Array.from(new Set(taskIdsToLock)).sort();

      const lockedTaskRows = await (tx
        .select()
        .from(tasks)
        .where(inArray(tasks.id, sortedUniqueIds))
        .orderBy(asc(tasks.id)) as any).for("update");

      // 5. Re-read and validate moving task under the lock
      const task = lockedTaskRows.find((t: Task) => t.id === taskId);
      if (!task || task.projectId !== project.id) {
        throw AppError.notFound("Task not found");
      }

      if (task.archivedAt !== null) {
        throw AppError.conflict("TASK_ARCHIVED", "Cannot move an archived task");
      }

      // 6. Validate expectedVersion before evaluating no-op
      if (task.version !== expectedVersion) {
        throw AppError.conflict("VERSION_CONFLICT", "This task changed since you loaded it.", {
          currentVersion: task.version,
        });
      }

      // 7. Validate destination column belongs to the same project
      const [destColumn] = await tx
        .select()
        .from(projectColumns)
        .where(eq(projectColumns.id, columnId));

      if (!destColumn) {
        throw AppError.badRequest("Invalid destination column ID or column does not exist");
      }

      if (destColumn.projectId !== project.id) {
        throw AppError.badRequest("Column does not belong to this project");
      }

      // 8. Fetch active destination tasks ordered by rank_key ASC, id ASC
      const destActiveTasks = await tx
        .select({ id: tasks.id, rankKey: tasks.rankKey, columnId: tasks.columnId })
        .from(tasks)
        .where(
          and(
            eq(tasks.projectId, project.id),
            eq(tasks.columnId, columnId),
            isNull(tasks.archivedAt)
          )
        )
        .orderBy(asc(tasks.rankKey), asc(tasks.id));

      // 9. Exclude the moving task from destination ordering
      const otherDestTasks = destActiveTasks.filter((t) => t.id !== taskId);

      // 10. Validate anchors and determine effective neighboring tasks
      let targetPrev: { id: string; rankKey: string } | null = null;
      let targetNext: { id: string; rankKey: string } | null = null;

      if (prevTaskId) {
        const prevIndex = otherDestTasks.findIndex((t) => t.id === prevTaskId);
        if (prevIndex === -1) {
          throw AppError.badRequest("Previous anchor task not found in destination column");
        }
        targetPrev = otherDestTasks[prevIndex] ?? null;
      }

      if (nextTaskId) {
        const nextIndex = otherDestTasks.findIndex((t) => t.id === nextTaskId);
        if (nextIndex === -1) {
          throw AppError.badRequest("Next anchor task not found in destination column");
        }
        targetNext = otherDestTasks[nextIndex] ?? null;
      }

      if (prevTaskId && nextTaskId) {
        const prevIndex = otherDestTasks.findIndex((t) => t.id === prevTaskId);
        const nextIndex = otherDestTasks.findIndex((t) => t.id === nextTaskId);
        if (nextIndex !== prevIndex + 1) {
          throw AppError.badRequest("Anchor tasks are not adjacent in destination column");
        }
      } else if (prevTaskId && !nextTaskId) {
        const prevIndex = otherDestTasks.findIndex((t) => t.id === prevTaskId);
        targetNext = prevIndex + 1 < otherDestTasks.length ? (otherDestTasks[prevIndex + 1] ?? null) : null;
      } else if (!prevTaskId && nextTaskId) {
        const nextIndex = otherDestTasks.findIndex((t) => t.id === nextTaskId);
        targetPrev = nextIndex > 0 ? (otherDestTasks[nextIndex - 1] ?? null) : null;
      } else {
        targetPrev = otherDestTasks.length > 0 ? (otherDestTasks[otherDestTasks.length - 1] ?? null) : null;
        targetNext = null;
      }

      // 11. Detect no-op by comparing target neighbors with moving task's current active neighbors in same column
      if (task.columnId === columnId) {
        const currentIndex = destActiveTasks.findIndex((t) => t.id === taskId);
        const currentPrev = currentIndex > 0 ? (destActiveTasks[currentIndex - 1] ?? null) : null;
        const currentNext =
          currentIndex >= 0 && currentIndex + 1 < destActiveTasks.length
            ? (destActiveTasks[currentIndex + 1] ?? null)
            : null;

        const currentPrevId = currentPrev ? currentPrev.id : null;
        const currentNextId = currentNext ? currentNext.id : null;
        const targetPrevId = targetPrev ? targetPrev.id : null;
        const targetNextId = targetNext ? targetNext.id : null;

        if (currentPrevId === targetPrevId && currentNextId === targetNextId) {
          // Idempotent no-op: preserve version, rankKey, and updatedAt
          return task;
        }
      }

      // 12. Generate fractional rank key between effective neighboring rank keys
      let newRankKey = generateRankKey(
        targetPrev ? targetPrev.rankKey : null,
        targetNext ? targetNext.rankKey : null
      );

      if (newRankKey.length > REBALANCE_THRESHOLD_LENGTH) {
        const rebalancedMap = await this.rebalanceColumnActiveTasks(tx, {
          projectId: project.id,
          columnId,
          excludeTaskId: taskId,
        });

        const freshPrevRank = targetPrev
          ? (rebalancedMap.get(targetPrev.id) ?? targetPrev.rankKey)
          : null;
        const freshNextRank = targetNext
          ? (rebalancedMap.get(targetNext.id) ?? targetNext.rankKey)
          : null;

        newRankKey = generateRankKey(freshPrevRank, freshNextRank);
      }

      // 13. Update task atomically incrementing version exactly once
      const [updatedTask] = await tx
        .update(tasks)
        .set({
          columnId,
          rankKey: newRankKey,
          version: task.version + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(tasks.id, taskId),
            eq(tasks.version, task.version)
          )
        )
        .returning();

      if (!updatedTask) {
        throw AppError.conflict("VERSION_CONFLICT", "This task changed since you loaded it.", {
          currentVersion: task.version,
        });
      }

      return updatedTask;
    });
  }

  /**
   * Archives a task (soft delete via archivedAt).
   * Active -> archived increments version and updates updatedAt.
   * Repeated archive calls on an already archived task are idempotent no-ops.
   * Rejects archiving a task in an archived project with 409 PROJECT_ARCHIVED.
   * Follows project-first locking: workspaces -> projects -> tasks -> comments.
   */
  static async archiveTask(
    db: Database,
    {
      taskId,
      callerId,
    }: ArchiveTaskParams
  ): Promise<Task> {
    return await db.transaction(async (tx) => {
      // 1. Perform an unlocked task lookup to discover its projectId
      const [taskSnapshot] = await tx
        .select({ id: tasks.id, projectId: tasks.projectId })
        .from(tasks)
        .where(eq(tasks.id, taskId));

      if (!taskSnapshot) {
        throw AppError.notFound("Task not found");
      }

      // 2. Acquire project row lock (FOR UPDATE)
      const [project] = await (tx
        .select()
        .from(projects)
        .where(eq(projects.id, taskSnapshot.projectId)) as any).for("update");

      if (!project) {
        throw AppError.notFound("Task not found");
      }

      // 3. Perform existing membership and project lifecycle checks
      const [callerMembership] = await tx
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, project.workspaceId),
            eq(workspaceMembers.userId, callerId)
          )
        );

      if (!callerMembership) {
        // Conceal private resource existence from non-members
        throw AppError.notFound("Task not found");
      }

      if (project.archivedAt !== null) {
        throw AppError.conflict("PROJECT_ARCHIVED", "Cannot modify a task in an archived project");
      }

      // 4. Acquire task row lock (FOR UPDATE)
      const [task] = await (tx
        .select()
        .from(tasks)
        .where(eq(tasks.id, taskId)) as any).for("update");

      if (!task || task.projectId !== project.id) {
        throw AppError.notFound("Task not found");
      }

      // 5. If already archived, idempotent no-op: preserve version and updatedAt
      if (task.archivedAt !== null) {
        return task;
      }

      // 6. Transition from active to archived: increment version and update updatedAt
      const [archivedTask] = await tx
        .update(tasks)
        .set({
          archivedAt: new Date(),
          version: task.version + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(tasks.id, taskId),
            eq(tasks.version, task.version)
          )
        )
        .returning();

      if (!archivedTask) {
        throw new Error("Failed to archive task");
      }

      return archivedTask;
    });
  }

  /**
   * Restores an archived task (sets archivedAt = null).
   * Archived -> active increments version and updates updatedAt.
   * Repeated restore calls on an already active task are idempotent no-ops.
   * Restoring into an archived project is rejected with 409 PROJECT_ARCHIVED.
   * Follows project-first locking: workspaces -> projects -> tasks -> comments.
   * Collision-safe: if another active task in the destination column already uses
   * this task's rankKey, appends after the last active task with a new rankKey.
   */
  static async restoreTask(
    db: Database,
    {
      taskId,
      callerId,
    }: RestoreTaskParams
  ): Promise<Task> {
    return await db.transaction(async (tx) => {
      // 1. Perform an unlocked task lookup to discover its projectId
      const [taskSnapshot] = await tx
        .select({ id: tasks.id, projectId: tasks.projectId })
        .from(tasks)
        .where(eq(tasks.id, taskId));

      if (!taskSnapshot) {
        throw AppError.notFound("Task not found");
      }

      // 2. Acquire project row lock (FOR UPDATE)
      const [project] = await (tx
        .select()
        .from(projects)
        .where(eq(projects.id, taskSnapshot.projectId)) as any).for("update");

      if (!project) {
        throw AppError.notFound("Task not found");
      }

      // 3. Perform existing membership and project lifecycle checks
      const [callerMembership] = await tx
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, project.workspaceId),
            eq(workspaceMembers.userId, callerId)
          )
        );

      if (!callerMembership) {
        // Conceal private resource existence from non-members
        throw AppError.notFound("Task not found");
      }

      if (project.archivedAt !== null) {
        throw AppError.conflict("PROJECT_ARCHIVED", "Cannot restore a task in an archived project");
      }

      // 4. Acquire task row lock (FOR UPDATE)
      const [task] = await (tx
        .select()
        .from(tasks)
        .where(eq(tasks.id, taskId)) as any).for("update");

      if (!task || task.projectId !== project.id) {
        throw AppError.notFound("Task not found");
      }

      // 5. If already active (not archived), idempotent no-op: preserve version, rankKey, and updatedAt
      if (task.archivedAt === null) {
        return task;
      }

      // 6. Collision-safe restoration: check if any active task in destination column already uses task's rankKey
      const [collisionTask] = await tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(
            eq(tasks.projectId, project.id),
            eq(tasks.columnId, task.columnId),
            isNull(tasks.archivedAt),
            eq(tasks.rankKey, task.rankKey)
          )
        )
        .limit(1);

      let newRankKey = task.rankKey;

      if (collisionTask) {
        // Collision exists: append restored task after the last active task in the column
        const [lastActiveTask] = await tx
          .select({ rankKey: tasks.rankKey })
          .from(tasks)
          .where(
            and(
              eq(tasks.projectId, project.id),
              eq(tasks.columnId, task.columnId),
              isNull(tasks.archivedAt)
            )
          )
          .orderBy(desc(tasks.rankKey), desc(tasks.id))
          .limit(1);

        newRankKey = generateRankKey(lastActiveTask ? lastActiveTask.rankKey : null, null);

        if (newRankKey.length > REBALANCE_THRESHOLD_LENGTH) {
          await this.rebalanceColumnActiveTasks(tx, {
            projectId: project.id,
            columnId: task.columnId,
            excludeTaskId: taskId,
          });

          const [freshLastActive] = await tx
            .select({ rankKey: tasks.rankKey })
            .from(tasks)
            .where(
              and(
                eq(tasks.projectId, project.id),
                eq(tasks.columnId, task.columnId),
                isNull(tasks.archivedAt)
              )
            )
            .orderBy(desc(tasks.rankKey), desc(tasks.id))
            .limit(1);

          newRankKey = generateRankKey(freshLastActive ? freshLastActive.rankKey : null, null);
        }
      }

      // 7. Transition from archived to active: update rankKey if changed, increment version, and update updatedAt
      const [restoredTask] = await tx
        .update(tasks)
        .set({
          archivedAt: null,
          rankKey: newRankKey,
          version: task.version + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(tasks.id, taskId),
            eq(tasks.version, task.version)
          )
        )
        .returning();

      if (!restoredTask) {
        throw new Error("Failed to restore task");
      }

      return restoredTask;
    });
  }
}
