import { and, asc, count, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { projectColumns, projects, tasks, workspaceMembers, type Task } from "../db/schema/index.js";
import { AppError } from "../errors/index.js";

export interface CreateTaskParams {
  projectId: string;
  callerId: string;
  title: string;
  columnId: string;
  description?: string | undefined;
  assigneeId?: string | null | undefined;
  dueDate?: string | null | undefined;
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

/**
 * Domain service managing task creation, retrieval, and relational validation.
 * Reference: docs/SPECIFICATION.md Section 4.2, 6.4, 9.6, 10.3
 */
export class TaskService {
  /**
   * Creates a new task in an active project.
   * Requires active workspace membership (Owner, Admin, or Member).
   * Validates that columnId belongs to the project and assigneeId (if provided) is a workspace member.
   * Rejects task creation in archived projects with 409 PROJECT_ARCHIVED.
   * Conceals non-existent projects or non-member access with 404 NOT_FOUND.
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
    }: CreateTaskParams
  ): Promise<Task> {
    return await db.transaction(async (tx) => {
      // 1. Verify project exists
      const [project] = await tx
        .select()
        .from(projects)
        .where(eq(projects.id, projectId));

      if (!project) {
        throw AppError.notFound("Project not found");
      }

      // 2. Verify caller is an active workspace member (404 concealment)
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

      // 3. Reject task creation if project is archived
      if (project.archivedAt !== null) {
        throw AppError.conflict("PROJECT_ARCHIVED", "Cannot create tasks in an archived project");
      }

      // 4. Verify column exists and belongs to this project
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

      // 5. If assignee is provided, verify assignee is an active member of this workspace
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

      // 6. Generate a deterministic initial rank key for ordering
      const [colTasksCount] = await tx
        .select({ value: count() })
        .from(tasks)
        .where(and(eq(tasks.projectId, projectId), eq(tasks.columnId, columnId)));

      const taskIndex = colTasksCount?.value ?? 0;
      const rankKey = `a${taskIndex.toString().padStart(5, "0")}`;

      // 7. Insert task row
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

      return task;
    });
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
    // 1. Fetch task row
    const [task] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, taskId));

    if (!task) {
      throw AppError.notFound("Task not found");
    }

    // 2. Fetch project to identify parent workspace
    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, task.projectId));

    if (!project) {
      throw AppError.notFound("Task not found");
    }

    // 3. Verify caller membership in the parent workspace (404 concealment)
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
      throw AppError.notFound("Task not found");
    }

    return task;
  }
}

