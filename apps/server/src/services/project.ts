import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import type { Database } from "../db/index.js";
import {
  projectColumns,
  projects,
  tasks,
  workspaceMembers,
  type Project,
  type ProjectColumn,
  type Task,
} from "../db/schema/index.js";
import { AppError } from "../errors/index.js";
import { EventService } from "./event.js";

export const DEFAULT_PROJECT_COLUMNS = [
  { name: "Backlog", position: 0 },
  { name: "Todo", position: 1 },
  { name: "In Progress", position: 2 },
  { name: "Done", position: 3 },
] as const;

export type CanonicalProjectSnapshot = {
  id: string;
  workspaceId: string;
  name: string;
  archivedAt: string | null;
  lastSeq: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type ProjectChanges = Record<
  string,
  { from?: unknown; to?: unknown }
>;

export interface BoardSnapshotResult {
  project: Project;
  columns: ProjectColumn[];
  tasks: Task[];
  snapshotSeq: number;
}

/**
 * Builds the canonical project snapshot carried by every project.* event.
 * Conforms strictly to docs/SPECIFICATION.md Section 8.6 and projectSnapshotSchema.
 * Pure, deterministic, side-effect free.
 */
export function buildProjectSnapshot(
  project: Project,
  overrideLastSeq?: number,
  overrideUpdatedAt?: Date
): CanonicalProjectSnapshot {
  const effectiveLastSeq = overrideLastSeq !== undefined ? overrideLastSeq : project.lastSeq;
  const effectiveUpdatedAt = overrideUpdatedAt !== undefined ? overrideUpdatedAt : project.updatedAt;

  return {
    id: project.id,
    workspaceId: project.workspaceId,
    name: project.name,
    archivedAt: project.archivedAt
      ? project.archivedAt instanceof Date
        ? project.archivedAt.toISOString()
        : new Date(project.archivedAt).toISOString()
      : null,
    lastSeq: effectiveLastSeq,
    createdBy: project.createdBy,
    createdAt:
      project.createdAt instanceof Date
        ? project.createdAt.toISOString()
        : new Date(project.createdAt).toISOString(),
    updatedAt:
      effectiveUpdatedAt instanceof Date
        ? effectiveUpdatedAt.toISOString()
        : new Date(effectiveUpdatedAt).toISOString(),
  };
}

/**
 * Builds the diff (changes) object comparing before-state and after-state of a project.
 * Conforms strictly to docs/SPECIFICATION.md Section 8.3.
 * Pure, deterministic, side-effect free.
 */
export function buildProjectChanges(
  before: Project,
  after: Project
): ProjectChanges {
  const changes: ProjectChanges = {};

  if (before.name !== after.name) {
    changes["name"] = { from: before.name, to: after.name };
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
 * Domain service managing project creation, board initialization, and retrieval.
 * Reference: docs/SPECIFICATION.md Section 4.2, 6.3, 9.4, 9.5, 10.2
 */
export class ProjectService {
  /**
   * Atomically creates a project and seeds the four fixed columns.
   * Requires active workspace membership (owner, admin, or member).
   */
  static async createProject(
    db: Database,
    {
      workspaceId,
      callerId,
      name,
    }: {
      workspaceId: string;
      callerId: string;
      name: string;
    }
  ) {
    return await db.transaction(async (tx) => {
      // 1. Verify caller is an active workspace member (404 concealment)
      const [membership] = await tx
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, callerId)
          )
        );

      if (!membership) {
        throw AppError.notFound("Workspace not found");
      }

      // 2. Insert project row
      const [project] = await tx
        .insert(projects)
        .values({
          workspaceId,
          name: name.trim(),
          createdBy: callerId,
        })
        .returning();

      if (!project) {
        throw new Error("Failed to create project");
      }

      // 3. Atomically seed the 4 fixed status columns in the same transaction
      const columns = await tx
        .insert(projectColumns)
        .values(
          DEFAULT_PROJECT_COLUMNS.map((col) => ({
            projectId: project.id,
            name: col.name,
            position: col.position,
          }))
        )
        .returning();

      return {
        project,
        columns: columns.sort((a, b) => a.position - b.position),
      };
    });
  }

  /**
   * Lists active projects in a workspace for an active member.
   * Non-members receive 404 concealment.
   */
  static async listProjects(
    db: Database,
    {
      workspaceId,
      callerId,
    }: {
      workspaceId: string;
      callerId: string;
    }
  ) {
    // 1. Verify caller is an active member of the workspace
    const [membership] = await db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, callerId)
        )
      );

    if (!membership) {
      throw AppError.notFound("Workspace not found");
    }

    // 2. Query active (non-archived) projects
    const rows = await db
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.workspaceId, workspaceId),
          isNull(projects.archivedAt)
        )
      )
      .orderBy(asc(projects.createdAt));

    return rows;
  }

  /**
   * Retrieves project metadata. Caller must be an active member of the parent workspace.
   * Conceals non-existent projects or non-member access with 404.
   */
  static async getProject(
    db: Database,
    {
      projectId,
      callerId,
    }: {
      projectId: string;
      callerId: string;
    }
  ) {
    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId));

    if (!project) {
      return null;
    }

    // Verify caller membership in the project's parent workspace
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
      return null;
    }

    return project;
  }

  /**
   * Retrieves board snapshot: project metadata, status columns, active tasks, and snapshot sequence.
   * Executes in a single REPEATABLE READ, READ ONLY transaction to guarantee point-in-time MVCC consistency.
   * Conceals non-existent projects or non-member access with 404 (returns null).
   */
  static async getBoard(
    db: Database,
    {
      projectId,
      callerId,
    }: {
      projectId: string;
      callerId: string;
    }
  ): Promise<BoardSnapshotResult | null> {
    return await db.transaction(
      async (tx) => {
        // 1. Fetch project metadata (including lastSeq)
        const [project] = await tx
          .select()
          .from(projects)
          .where(eq(projects.id, projectId));

        if (!project) {
          return null;
        }

        // 2. Verify caller is an active member of the project's parent workspace (tenant concealment)
        const [membership] = await tx
          .select({ role: workspaceMembers.role })
          .from(workspaceMembers)
          .where(
            and(
              eq(workspaceMembers.workspaceId, project.workspaceId),
              eq(workspaceMembers.userId, callerId)
            )
          );

        if (!membership) {
          return null;
        }

        // 3. Query columns ordered by position ASC
        const columns = await tx
          .select()
          .from(projectColumns)
          .where(eq(projectColumns.projectId, projectId))
          .orderBy(asc(projectColumns.position));

        // 4. Query active tasks (archivedAt IS NULL) ordered by rankKey ASC, id ASC
        const activeTasks = await tx
          .select()
          .from(tasks)
          .where(and(eq(tasks.projectId, projectId), isNull(tasks.archivedAt)))
          .orderBy(asc(tasks.rankKey), asc(tasks.id));

        return {
          project,
          columns,
          tasks: activeTasks,
          snapshotSeq: project.lastSeq,
        };
      },
      {
        isolationLevel: "repeatable read",
        accessMode: "read only",
      }
    );
  }

  /**
   * Helper to verify project existence and caller membership/role for lifecycle operations.
   * Conceals non-existent projects or unauthorized non-member access with 404 NOT_FOUND.
   * Throws 403 FORBIDDEN if the caller is not a workspace owner or admin.
   * Acquires an exclusive row lock on the project (FOR UPDATE) within the provided transaction.
   */
  private static async getProjectForLifecycleMutation(
    tx: Database,
    projectId: string,
    callerId: string
  ): Promise<Project> {
    const [project] = await (tx
      .select()
      .from(projects)
      .where(eq(projects.id, projectId)) as any).for("update");

    if (!project) {
      throw AppError.notFound("Project not found");
    }

    const [membership] = await tx
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, project.workspaceId),
          eq(workspaceMembers.userId, callerId)
        )
      );

    if (!membership) {
      // Conceal workspace project existence from non-members
      throw AppError.notFound("Project not found");
    }

    if (membership.role !== "owner" && membership.role !== "admin") {
      throw AppError.forbidden("Only workspace owners and admins can manage project lifecycle");
    }

    return project;
  }

  /**
   * Renames an active project. Owner/Admin only.
   * Rejects rename on archived projects with 409 PROJECT_ARCHIVED.
   * Emits project.updated domain event on genuine rename.
   * Idempotent no-op if name is unchanged (suppresses event emission and preserves version/updatedAt).
   */
  static async renameProject(
    db: Database,
    {
      projectId,
      callerId,
      name,
    }: {
      projectId: string;
      callerId: string;
      name: string;
    }
  ): Promise<Project> {
    return await db.transaction(async (tx) => {
      const project = await this.getProjectForLifecycleMutation(tx, projectId, callerId);

      if (project.archivedAt !== null) {
        throw AppError.conflict("PROJECT_ARCHIVED", "Cannot modify an archived project");
      }

      const trimmedName = name.trim();

      // Idempotent no-op: if name is unchanged, return existing project without DB update or event
      if (trimmedName === project.name) {
        return project;
      }

      const now = new Date();
      const nextSeq = project.lastSeq + 1;

      // Atomic update
      const [updated] = await tx
        .update(projects)
        .set({
          name: trimmedName,
          updatedAt: now,
        })
        .where(
          and(
            eq(projects.id, projectId),
            isNull(projects.archivedAt)
          )
        )
        .returning();

      if (!updated) {
        throw AppError.conflict("PROJECT_ARCHIVED", "Cannot modify an archived project");
      }

      const snapshot = buildProjectSnapshot(updated, nextSeq, now);
      const changes = buildProjectChanges(project, updated);

      await EventService.appendProjectEvent(tx, {
        projectId: project.id,
        actorId: callerId,
        eventType: "project.updated",
        entityType: "project",
        entityId: project.id,
        payload: {
          project: snapshot,
          changes,
        },
        updatedAt: now,
      });

      return {
        ...updated,
        lastSeq: nextSeq,
        updatedAt: now,
      };
    });
  }

  /**
   * Archives a project. Owner/Admin only.
   * Excludes project from default listings while preserving all columns and data.
   * Emits project.archived domain event on genuine archive.
   * Repeated calls on an already archived project are idempotent no-ops returning current record.
   */
  static async archiveProject(
    db: Database,
    {
      projectId,
      callerId,
    }: {
      projectId: string;
      callerId: string;
    }
  ): Promise<Project> {
    return await db.transaction(async (tx) => {
      const project = await this.getProjectForLifecycleMutation(tx, projectId, callerId);

      // If already archived, return current record directly without updating updatedAt or emitting events
      if (project.archivedAt !== null) {
        return project;
      }

      const now = new Date();
      const nextSeq = project.lastSeq + 1;

      // Conditional update: only archive if currently unarchived
      const [updated] = await tx
        .update(projects)
        .set({
          archivedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(projects.id, projectId),
            isNull(projects.archivedAt)
          )
        )
        .returning();

      if (!updated) {
        // Concurrently archived; re-read under lock and return
        const [current] = await tx
          .select()
          .from(projects)
          .where(eq(projects.id, projectId));
        return current ?? project;
      }

      const snapshot = buildProjectSnapshot(updated, nextSeq, now);
      const changes = buildProjectChanges(project, updated);

      await EventService.appendProjectEvent(tx, {
        projectId: project.id,
        actorId: callerId,
        eventType: "project.archived",
        entityType: "project",
        entityId: project.id,
        payload: {
          project: snapshot,
          changes,
        },
        updatedAt: now,
      });

      return {
        ...updated,
        lastSeq: nextSeq,
        updatedAt: now,
      };
    });
  }

  /**
   * Restores an archived project. Owner/Admin only.
   * Clears archivedAt timestamp and returns project to active listings.
   * Emits project.restored domain event on genuine restore.
   * Repeated calls on an already active project are idempotent no-ops returning current record.
   */
  static async restoreProject(
    db: Database,
    {
      projectId,
      callerId,
    }: {
      projectId: string;
      callerId: string;
    }
  ): Promise<Project> {
    return await db.transaction(async (tx) => {
      const project = await this.getProjectForLifecycleMutation(tx, projectId, callerId);

      // If already active, return current record directly without updating updatedAt or emitting events
      if (project.archivedAt === null) {
        return project;
      }

      const now = new Date();
      const nextSeq = project.lastSeq + 1;

      // Conditional update: only restore if currently archived
      const [updated] = await tx
        .update(projects)
        .set({
          archivedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(projects.id, projectId),
            isNotNull(projects.archivedAt)
          )
        )
        .returning();

      if (!updated) {
        // Concurrently restored; re-read under lock and return
        const [current] = await tx
          .select()
          .from(projects)
          .where(eq(projects.id, projectId));
        return current ?? project;
      }

      const snapshot = buildProjectSnapshot(updated, nextSeq, now);
      const changes = buildProjectChanges(project, updated);

      await EventService.appendProjectEvent(tx, {
        projectId: project.id,
        actorId: callerId,
        eventType: "project.restored",
        entityType: "project",
        entityId: project.id,
        payload: {
          project: snapshot,
          changes,
        },
        updatedAt: now,
      });

      return {
        ...updated,
        lastSeq: nextSeq,
        updatedAt: now,
      };
    });
  }
}

