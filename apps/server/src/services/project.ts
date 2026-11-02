import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { projectColumns, projects, workspaceMembers } from "../db/schema/index.js";
import { AppError } from "../errors/index.js";

export const DEFAULT_PROJECT_COLUMNS = [
  { name: "Backlog", position: 0 },
  { name: "Todo", position: 1 },
  { name: "In Progress", position: 2 },
  { name: "Done", position: 3 },
] as const;

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
   * Retrieves board columns and project metadata.
   * Conceals non-existent projects or non-member access with 404.
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
  ) {
    const project = await this.getProject(db, { projectId, callerId });
    if (!project) {
      return null;
    }

    const columns = await db
      .select()
      .from(projectColumns)
      .where(eq(projectColumns.projectId, projectId))
      .orderBy(asc(projectColumns.position));

    return {
      project,
      columns,
    };
  }

  /**
   * Helper to verify project existence and caller membership/role for lifecycle operations.
   * Conceals non-existent projects or unauthorized non-member access with 404 NOT_FOUND.
   * Throws 403 FORBIDDEN if the caller is not a workspace owner or admin.
   */
  private static async getProjectForLifecycleMutation(
    db: Database,
    projectId: string,
    callerId: string
  ) {
    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId));

    if (!project) {
      throw AppError.notFound("Project not found");
    }

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
  ) {
    const project = await this.getProjectForLifecycleMutation(db, projectId, callerId);

    if (project.archivedAt !== null) {
      throw AppError.conflict("PROJECT_ARCHIVED", "Cannot modify an archived project");
    }

    const trimmedName = name.trim();

    // Atomic conditional update ensuring project has not been archived concurrently
    const [updated] = await db
      .update(projects)
      .set({
        name: trimmedName,
        updatedAt: new Date(),
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

    return updated;
  }

  /**
   * Archives a project. Owner/Admin only.
   * Excludes project from default listings while preserving all columns and data.
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
  ) {
    const project = await this.getProjectForLifecycleMutation(db, projectId, callerId);

    // If already archived, return current record directly without updating updatedAt
    if (project.archivedAt !== null) {
      return project;
    }

    const now = new Date();
    // Conditional update: only archive if currently unarchived
    const [updated] = await db
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
      // Another concurrent archive succeeded; re-read and return current record
      const [current] = await db
        .select()
        .from(projects)
        .where(eq(projects.id, projectId));
      return current ?? project;
    }

    return updated;
  }

  /**
   * Restores an archived project. Owner/Admin only.
   * Clears archivedAt timestamp and returns project to active listings.
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
  ) {
    const project = await this.getProjectForLifecycleMutation(db, projectId, callerId);

    // If already active, return current record directly without updating updatedAt
    if (project.archivedAt === null) {
      return project;
    }

    const now = new Date();
    // Conditional update: only restore if currently archived
    const [updated] = await db
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
      // Another concurrent restore succeeded; re-read and return current record
      const [current] = await db
        .select()
        .from(projects)
        .where(eq(projects.id, projectId));
      return current ?? project;
    }

    return updated;
  }
}

