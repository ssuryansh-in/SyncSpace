import { and, asc, eq } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { users, workspaceMembers, workspaces } from "../db/schema/index.js";
import { AppError } from "../errors/index.js";
import { emitMembershipNotification } from "./membership-events.js";

export interface WorkspaceMemberInfo {
  userId: string;
  displayName: string;
  email: string;
  role: string;
  joinedAt: Date;
}

export interface WorkspaceDetails {
  workspace: typeof workspaces.$inferSelect;
  role: string;
  members: WorkspaceMemberInfo[];
}

/**
 * Domain service managing workspace lifecycles, member access, and ownership.
 * Reference: docs/SPECIFICATION.md Section 4, 6.2, 9.2, 10.1
 */
export class WorkspaceService {
  /**
   * Atomically creates a new workspace and establishes the creator as initial owner.
   */
  static async createWorkspace(
    db: Database,
    params: { name: string; ownerId: string }
  ) {
    return await db.transaction(async (tx) => {
      const [workspace] = await tx
        .insert(workspaces)
        .values({
          name: params.name.trim(),
          ownerId: params.ownerId,
        })
        .returning();

      if (!workspace) {
        throw new Error("Failed to create workspace");
      }

      await tx.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: params.ownerId,
        role: "owner",
      });

      return {
        workspace,
        role: "owner",
      };
    });
  }

  /**
   * Lists all workspaces where the user has active membership.
   */
  static async listWorkspaces(db: Database, { userId }: { userId: string }) {
    const rows = await db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        ownerId: workspaces.ownerId,
        role: workspaceMembers.role,
        createdAt: workspaces.createdAt,
        updatedAt: workspaces.updatedAt,
      })
      .from(workspaces)
      .innerJoin(
        workspaceMembers,
        eq(workspaces.id, workspaceMembers.workspaceId)
      )
      .where(eq(workspaceMembers.userId, userId))
      .orderBy(asc(workspaces.createdAt));

    return rows;
  }

  /**
   * Retrieves workspace details, member list, and the caller's role.
   * Returns null if the caller is not an active member (for 404 concealment).
   */
  static async getWorkspace(
    db: Database,
    { workspaceId, userId }: { workspaceId: string; userId: string }
  ): Promise<WorkspaceDetails | null> {
    const [membership] = await db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, userId)
        )
      );

    if (!membership) {
      return null;
    }

    const [workspace] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));

    if (!workspace) {
      return null;
    }

    const members = await db
      .select({
        userId: users.id,
        displayName: users.displayName,
        email: users.email,
        role: workspaceMembers.role,
        joinedAt: workspaceMembers.joinedAt,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(workspaceMembers.userId, users.id))
      .where(eq(workspaceMembers.workspaceId, workspaceId))
      .orderBy(asc(workspaceMembers.joinedAt));

    return {
      workspace,
      role: membership.role,
      members,
    };
  }

  /**
   * Updates workspace settings (name). Enforces owner or admin permission.
   */
  static async updateWorkspace(
    db: Database,
    {
      workspaceId,
      userId,
      name,
    }: {
      workspaceId: string;
      userId: string;
      name: string;
    }
  ) {
    const [membership] = await db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, userId)
        )
      );

    if (!membership) {
      throw AppError.notFound("Workspace not found");
    }

    if (membership.role !== "owner" && membership.role !== "admin") {
      throw AppError.forbidden("Only owners and admins can update workspace settings");
    }

    const [updated] = await db
      .update(workspaces)
      .set({
        name: name.trim(),
        updatedAt: new Date(),
      })
      .where(eq(workspaces.id, workspaceId))
      .returning();

    if (!updated) {
      throw AppError.notFound("Workspace not found");
    }

    return updated;
  }

  /**
   * Atomically transfers workspace ownership in a single transaction with row locking.
   * Former owner becomes 'admin'; new owner becomes 'owner'.
   */
  static async transferOwnership(
    db: Database,
    {
      workspaceId,
      currentOwnerId,
      newOwnerId,
    }: {
      workspaceId: string;
      currentOwnerId: string;
      newOwnerId: string;
    }
  ) {
    return await db.transaction(async (tx) => {
      // 1. Lock workspace row
      const [workspace] = await tx
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .for("update");

      if (!workspace) {
        throw AppError.notFound("Workspace not found");
      }

      if (workspace.ownerId !== currentOwnerId) {
        throw AppError.forbidden("Only the current workspace owner can transfer ownership");
      }

      if (currentOwnerId === newOwnerId) {
        throw AppError.badRequest("Cannot transfer ownership to yourself");
      }

      // 2. Lock target member row and verify they are an existing member
      const [targetMember] = await tx
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, newOwnerId)
          )
        )
        .for("update");

      if (!targetMember) {
        throw AppError.badRequest("Target user must be an active member of the workspace");
      }

      // 3. Update workspace owner
      const [updatedWorkspace] = await tx
        .update(workspaces)
        .set({
          ownerId: newOwnerId,
          updatedAt: new Date(),
        })
        .where(eq(workspaces.id, workspaceId))
        .returning();

      // 4. Update former owner role to 'admin'
      await tx
        .update(workspaceMembers)
        .set({ role: "admin" })
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, currentOwnerId)
          )
        );

      // 5. Update new owner role to 'owner'
      await tx
        .update(workspaceMembers)
        .set({ role: "owner" })
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, newOwnerId)
          )
        );

      // 6. Emit single notification containing both affected users
      await emitMembershipNotification(tx, {
        workspaceId,
        affectedUsers: [
          { userId: currentOwnerId, action: "role_updated" },
          { userId: newOwnerId, action: "role_updated" },
        ],
      });

      return {
        workspace: updatedWorkspace,
        previousOwnerId: currentOwnerId,
        newOwnerId,
      };
    });
  }
}

