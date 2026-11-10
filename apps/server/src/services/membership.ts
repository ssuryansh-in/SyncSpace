import { and, eq } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { users, workspaceMembers, workspaces } from "../db/schema/index.js";
import { AppError } from "../errors/index.js";
import { emitMembershipNotification } from "./membership-events.js";

/**
 * Domain service managing workspace membership additions, role updates, and removals.
 * Reference: docs/SPECIFICATION.md Section 4.2, 6.2, 10.1
 */
export class MembershipService {
  /**
   * Adds an existing registered and verified user to the workspace by email.
   * Returns a generic response to prevent account enumeration.
   * Uses ON CONFLICT DO NOTHING to handle concurrent duplicate additions safely.
   */
  static async addMember(
    db: Database,
    {
      workspaceId,
      callerId,
      email,
      role = "member",
    }: {
      workspaceId: string;
      callerId: string;
      email: string;
      role?: "admin" | "member";
    }
  ) {
    return await db.transaction(async (tx) => {
      // 1. Lock workspace row first to conform to established lock hierarchy
      // (workspaces -> projects -> columns -> tasks -> comments)
      const [workspace] = await tx
        .select({ id: workspaces.id, ownerId: workspaces.ownerId })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .for("update");

      if (!workspace) {
        throw AppError.notFound("Workspace not found");
      }

      // 2. Lock and verify caller membership and role FOR UPDATE (404 concealment for non-members)
      const [callerMembership] = await tx
        .select({ role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, callerId)
          )
        )
        .for("update");

      if (!callerMembership) {
        throw AppError.notFound("Workspace not found");
      }

      if (callerMembership.role !== "owner" && callerMembership.role !== "admin") {
        throw AppError.forbidden("Only owners and admins can add members to the workspace");
      }

      const assignedRole = role === "admin" ? "admin" : "member";
      const genericResponse = {
        status: true,
        message: "If the user is registered, they have been added to the workspace.",
      };

      // 3. Lookup user by email (case-insensitive via citext)
      const [targetUser] = await tx
        .select({ id: users.id, emailVerified: users.emailVerified })
        .from(users)
        .where(eq(users.email, email.trim()));

      // Account enumeration protection: suppress notification and return generic response
      if (!targetUser || !targetUser.emailVerified) {
        return genericResponse;
      }

      // 4. Insert membership with conflict suppression for concurrent duplicate requests
      const [inserted] = await tx
        .insert(workspaceMembers)
        .values({
          workspaceId,
          userId: targetUser.id,
          role: assignedRole,
        })
        .onConflictDoNothing()
        .returning({ userId: workspaceMembers.userId });

      // 5. Emit notification ONLY if row was genuinely inserted (not on duplicate / conflict)
      if (inserted) {
        await emitMembershipNotification(tx, {
          workspaceId,
          affectedUsers: [
            {
              userId: targetUser.id,
              action: "added",
            },
          ],
        });
      }

      return genericResponse;
    });
  }

  /**
   * Updates a member's role (admin <-> member).
   * Prevents changing the owner's role or promoting to owner.
   * Uses row locking on the workspace to serialize with concurrent ownership operations.
   */
  static async updateMemberRole(
    db: Database,
    {
      workspaceId,
      callerId,
      targetUserId,
      newRole,
    }: {
      workspaceId: string;
      callerId: string;
      targetUserId: string;
      newRole: "admin" | "member";
    }
  ) {
    return await db.transaction(async (tx) => {
      // 1. Lock workspace row to coordinate atomically with ownership and membership changes
      const [workspace] = await tx
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .for("update");

      if (!workspace) {
        throw AppError.notFound("Workspace not found");
      }

      // 2. Verify caller membership first (404 concealment for non-members)
      const [callerMembership] = await tx
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, callerId)
          )
        )
        .for("update");

      if (!callerMembership) {
        throw AppError.notFound("Workspace not found");
      }

      if (callerMembership.role !== "owner" && callerMembership.role !== "admin") {
        throw AppError.forbidden("Only owners and admins can update member roles");
      }

      // 3. Owner protection: cannot modify owner role
      if (workspace.ownerId === targetUserId) {
        throw AppError.forbidden(
          "Cannot modify the role of the workspace owner. Use transfer-ownership instead."
        );
      }

      if ((newRole as string) === "owner") {
        throw AppError.badRequest(
          "Cannot assign owner role directly. Use transfer-ownership."
        );
      }

      // 4. Verify target member exists in workspace
      const [targetMembership] = await tx
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, targetUserId)
          )
        )
        .for("update");

      if (!targetMembership) {
        throw AppError.notFound("Member not found in workspace");
      }

      if (targetMembership.role === "owner") {
        throw AppError.forbidden(
          "Cannot modify the role of the workspace owner. Use transfer-ownership instead."
        );
      }

      // 5. Apply role update
      const [updatedMember] = await tx
        .update(workspaceMembers)
        .set({ role: newRole })
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, targetUserId)
          )
        )
        .returning();

      // Emit notification only on genuine role change (suppress no-op)
      if (targetMembership.role !== newRole) {
        await emitMembershipNotification(tx, {
          workspaceId,
          affectedUsers: [
            {
              userId: targetUserId,
              action: "role_updated",
            },
          ],
        });
      }

      return updatedMember;
    });
  }

  /**
   * Removes a member from the workspace or allows a member to leave.
   * Atomically locks the workspace row to coordinate with transferOwnership,
   * guaranteeing the workspace owner can never be removed.
   */
  static async removeMember(
    db: Database,
    {
      workspaceId,
      callerId,
      targetUserId,
    }: {
      workspaceId: string;
      callerId: string;
      targetUserId: string;
    }
  ) {
    return await db.transaction(async (tx) => {
      // 1. Lock workspace row to coordinate atomically with transferOwnership
      const [workspace] = await tx
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .for("update");

      if (!workspace) {
        throw AppError.notFound("Workspace not found");
      }

      // 2. Verify caller membership first (404 concealment for non-members)
      const [callerMembership] = await tx
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, callerId)
          )
        )
        .for("update");

      if (!callerMembership) {
        throw AppError.notFound("Workspace not found");
      }

      // 3. Permissions check: non-owners/admins cannot remove other members
      const isLeaving = callerId === targetUserId;
      if (!isLeaving) {
        if (callerMembership.role !== "owner" && callerMembership.role !== "admin") {
          throw AppError.forbidden("Only owners and admins can remove other members");
        }
      }

      // 4. Owner invariant: targetUserId cannot be the current workspace owner
      if (workspace.ownerId === targetUserId) {
        throw AppError.forbidden(
          "The workspace owner cannot be removed. Transfer ownership first."
        );
      }

      // 5. Verify target member exists in workspace
      const [targetMembership] = await tx
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, targetUserId)
          )
        )
        .for("update");

      if (!targetMembership) {
        throw AppError.notFound("Member not found in workspace");
      }

      // Owner cannot be removed or leave
      if (targetMembership.role === "owner") {
        throw AppError.forbidden(
          "The workspace owner cannot be removed. Transfer ownership first."
        );
      }

      // 6. Delete member atomically
      await tx
        .delete(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, targetUserId)
          )
        );

      await emitMembershipNotification(tx, {
        workspaceId,
        affectedUsers: [
          {
            userId: targetUserId,
            action: "removed",
          },
        ],
      });

      return {
        status: true,
        message: isLeaving
          ? "Successfully left the workspace"
          : "Member removed from workspace",
      };
    });
  }
}
