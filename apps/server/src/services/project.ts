import { and, asc, eq, isNull } from "drizzle-orm";
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
}

