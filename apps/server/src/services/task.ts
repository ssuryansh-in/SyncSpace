import { and, asc, count, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { projectColumns, projects, tasks, workspaceMembers, type Task } from "../db/schema/index.js";
import { AppError } from "../errors/index.js";
import { computeRequestHash, IdempotencyService } from "./idempotency.js";

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
}

export interface ArchiveTaskParams {
  taskId: string;
  callerId: string;
}

export interface RestoreTaskParams {
  taskId: string;
  callerId: string;
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

        // 8. Generate a deterministic initial rank key for ordering
        const [colTasksCount] = await tx
          .select({ value: count() })
          .from(tasks)
          .where(and(eq(tasks.projectId, projectId), eq(tasks.columnId, columnId)));

        const taskIndex = colTasksCount?.value ?? 0;
        const rankKey = `a${taskIndex.toString().padStart(5, "0")}`;

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
      .orderBy(asc(tasks.createdAt));

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

  /**
   * Updates task fields. Requires matching expectedVersion.
   * Rejects mutations on archived tasks with 409 TASK_ARCHIVED.
   * Rejects mutations in archived projects with 409 PROJECT_ARCHIVED.
   * Increments version and updates updatedAt if fields changed; no-op if identical values.
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
      // 1. Lock task row and verify context
      const { task, project } = await this.getTaskWithContext(tx, taskId, callerId, true);

      // 2. Reject if task is archived
      if (task.archivedAt !== null) {
        throw AppError.conflict("TASK_ARCHIVED", "Cannot modify an archived task");
      }

      // 3. Reject if parent project is archived
      if (project.archivedAt !== null) {
        throw AppError.conflict("PROJECT_ARCHIVED", "Cannot modify a task in an archived project");
      }

      // 4. Validate expectedVersion
      if (task.version !== expectedVersion) {
        throw AppError.conflict("VERSION_CONFLICT", "This task changed since you loaded it.", {
          currentVersion: task.version,
        });
      }

      // 5. If assignee is provided and changed, verify assignee is an active workspace member
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

      // 6. Check for actual state changes (identifying no-op edits)
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

      // 7. Atomic update incrementing version exactly once
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
   * Moves a task to a destination column within the same project.
   * Requires matching expectedVersion.
   * Same-column move is an idempotent no-op (preserves version and updatedAt).
   * Cross-column move updates columnId, assigns deterministic rankKey, increments version, and updates updatedAt.
   * Rejects moving an archived task with 409 TASK_ARCHIVED.
   * Rejects moving a task in an archived project with 409 PROJECT_ARCHIVED.
   */
  static async moveTask(
    db: Database,
    {
      taskId,
      callerId,
      columnId,
      expectedVersion,
    }: MoveTaskParams
  ): Promise<Task> {
    return await db.transaction(async (tx) => {
      // 1. Lock task row and verify context
      const { task, project } = await this.getTaskWithContext(tx, taskId, callerId, true);

      // 2. Reject if task is archived
      if (task.archivedAt !== null) {
        throw AppError.conflict("TASK_ARCHIVED", "Cannot move an archived task");
      }

      // 3. Reject if parent project is archived
      if (project.archivedAt !== null) {
        throw AppError.conflict("PROJECT_ARCHIVED", "Cannot move a task in an archived project");
      }

      // 4. Validate expectedVersion (stale version must be rejected even on same-column move)
      if (task.version !== expectedVersion) {
        throw AppError.conflict("VERSION_CONFLICT", "This task changed since you loaded it.", {
          currentVersion: task.version,
        });
      }

      // 5. Verify destination column exists and belongs to the same project
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

      // 6. Check if same-column move (no-op in 6.2)
      if (task.columnId === columnId) {
        // Idempotent no-op: preserves version and updatedAt
        return task;
      }

      // 7. Cross-column move: generate deterministic rank key in target column
      const [colTasksCount] = await tx
        .select({ value: count() })
        .from(tasks)
        .where(and(eq(tasks.projectId, project.id), eq(tasks.columnId, columnId)));

      const taskIndex = colTasksCount?.value ?? 0;
      const rankKey = `a${taskIndex.toString().padStart(5, "0")}`;

      // 8. Atomic update incrementing version exactly once
      const [updatedTask] = await tx
        .update(tasks)
        .set({
          columnId,
          rankKey,
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
   */
  static async archiveTask(
    db: Database,
    {
      taskId,
      callerId,
    }: ArchiveTaskParams
  ): Promise<Task> {
    return await db.transaction(async (tx) => {
      // 1. Lock task row and verify context
      const { task, project } = await this.getTaskWithContext(tx, taskId, callerId, true);

      // 2. Reject if parent project is archived
      if (project.archivedAt !== null) {
        throw AppError.conflict("PROJECT_ARCHIVED", "Cannot modify a task in an archived project");
      }

      // 3. If already archived, idempotent no-op: preserve version and updatedAt
      if (task.archivedAt !== null) {
        return task;
      }

      // 4. Transition from active to archived: increment version and update updatedAt
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
   */
  static async restoreTask(
    db: Database,
    {
      taskId,
      callerId,
    }: RestoreTaskParams
  ): Promise<Task> {
    return await db.transaction(async (tx) => {
      // 1. Lock task row and verify context
      const { task, project } = await this.getTaskWithContext(tx, taskId, callerId, true);

      // 2. Reject if parent project is archived (cannot restore into an archived project)
      if (project.archivedAt !== null) {
        throw AppError.conflict("PROJECT_ARCHIVED", "Cannot restore a task in an archived project");
      }

      // 3. If already active (not archived), idempotent no-op: preserve version and updatedAt
      if (task.archivedAt === null) {
        return task;
      }

      // 4. Transition from archived to active: increment version and update updatedAt
      const [restoredTask] = await tx
        .update(tasks)
        .set({
          archivedAt: null,
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
