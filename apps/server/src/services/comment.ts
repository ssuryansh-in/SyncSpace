import { and, asc, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { comments, projects, tasks, users, workspaceMembers } from "../db/schema/index.js";
import { AppError } from "../errors/index.js";
import { computeRequestHash, IdempotencyService } from "./idempotency.js";

export interface CommentWithAuthor {
  id: string;
  taskId: string;
  authorId: string;
  author: {
    id: string;
    name: string;
  };
  body: string;
  createdAt: Date;
  deletedAt: Date | null;
}

export interface CreateCommentParams {
  taskId: string;
  callerId: string;
  body: string;
  idempotencyKey: string;
  requestPath: string;
}

export interface ListCommentsParams {
  taskId: string;
  callerId: string;
}

export interface DeleteCommentParams {
  commentId: string;
  callerId: string;
}

/**
 * Domain service managing task comments, authorization, soft-deletion, and idempotency.
 * Reference: docs/SPECIFICATION.md Section 4.2, 6.5, 7.5, 9.7, 10.3
 */
export class CommentService {
  /**
   * Helper to resolve task, parent project, and verify caller workspace membership.
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
   * Helper to resolve comment, parent task, parent project, and verify caller workspace membership.
   * Conceals non-existent comments or non-member access with 404 NOT_FOUND.
   * Supports row-level locking via FOR UPDATE when inside a transaction.
   * When forUpdate is true, acquires locks in strict top-down order: projects -> tasks -> comments.
   */
  private static async getCommentWithContext(
    dbOrTx: Database,
    commentId: string,
    callerId: string,
    forUpdate = false
  ) {
    if (!forUpdate) {
      const [comment] = await dbOrTx
        .select()
        .from(comments)
        .where(eq(comments.id, commentId));

      if (!comment) {
        throw AppError.notFound("Comment not found");
      }

      const [task] = await dbOrTx
        .select()
        .from(tasks)
        .where(eq(tasks.id, comment.taskId));

      if (!task) {
        throw AppError.notFound("Comment not found");
      }

      const [project] = await dbOrTx
        .select()
        .from(projects)
        .where(eq(projects.id, task.projectId));

      if (!project) {
        throw AppError.notFound("Comment not found");
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
        throw AppError.notFound("Comment not found");
      }

      return { comment, task, project, membership };
    }

    // Mutating path (forUpdate === true):
    // 1. Initial snapshot metadata lookup to resolve parent entity IDs (read-only, no locks held)
    const [meta] = await dbOrTx
      .select({
        commentId: comments.id,
        taskId: comments.taskId,
        projectId: tasks.projectId,
      })
      .from(comments)
      .innerJoin(tasks, eq(comments.taskId, tasks.id))
      .where(eq(comments.id, commentId));

    if (!meta) {
      throw AppError.notFound("Comment not found");
    }

    // 2. Lock 1: projects row (Top-Level)
    const [project] = await (dbOrTx
      .select()
      .from(projects)
      .where(eq(projects.id, meta.projectId)) as any).for("update");

    if (!project) {
      throw AppError.notFound("Comment not found");
    }

    // 3. Lock 2: tasks row (Mid-Level)
    const [task] = await (dbOrTx
      .select()
      .from(tasks)
      .where(eq(tasks.id, meta.taskId)) as any).for("update");

    if (!task) {
      throw AppError.notFound("Comment not found");
    }

    // 4. Lock 3: comments row (Leaf-Level)
    const [comment] = await (dbOrTx
      .select()
      .from(comments)
      .where(eq(comments.id, commentId)) as any).for("update");

    if (!comment) {
      throw AppError.notFound("Comment not found");
    }

    // 5. Re-validate that the locked records maintain consistent relationships
    if (comment.taskId !== task.id || task.projectId !== project.id) {
      throw AppError.notFound("Comment not found");
    }

    // 6. Verify caller membership in the parent workspace
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
      throw AppError.notFound("Comment not found");
    }

    return { comment, task, project, membership };
  }

  /**
   * Creates a comment on an active task with full database-persisted idempotency.
   * - Author is derived exclusively from authenticated session.
   * - Rejects comments on archived tasks with 409 TASK_ARCHIVED.
   * - Rejects comments in archived projects with 409 PROJECT_ARCHIVED.
   * - Conceals non-existent tasks or non-member access with 404 NOT_FOUND.
   */
  static async createComment(
    db: Database,
    { taskId, callerId, body, idempotencyKey, requestPath }: CreateCommentParams
  ): Promise<{ comment: CommentWithAuthor; replayed: boolean }> {
    const endpointKey = "comments:create";
    const trimmedBody = body.trim();
    const requestHash = computeRequestHash("POST", requestPath, { body: trimmedBody });

    try {
      return await db.transaction(async (tx) => {
        // 1. Lock task row and verify context (task exists, caller is active workspace member)
        const { task, project } = await this.getTaskWithContext(tx, taskId, callerId, true);

        // 2. Reject if task is archived
        if (task.archivedAt !== null) {
          throw AppError.conflict("TASK_ARCHIVED", "Cannot add comments to an archived task");
        }

        // 3. Reject if parent project is archived
        if (project.archivedAt !== null) {
          throw AppError.conflict("PROJECT_ARCHIVED", "Cannot add comments in an archived project");
        }

        // 4. Check idempotency record under task row lock
        const cached = await IdempotencyService.check(tx, {
          actorId: callerId,
          endpointKey,
          idempotencyKey,
          requestHash,
        });

        if (cached) {
          return {
            comment: (cached.body as { comment: CommentWithAuthor }).comment,
            replayed: true,
          };
        }

        // 5. Insert new comment
        const [newComment] = await tx
          .insert(comments)
          .values({
            taskId,
            authorId: callerId,
            body: trimmedBody,
          })
          .returning();

        if (!newComment) {
          throw new Error("Failed to create comment");
        }

        // 6. Fetch author metadata
        const [authorUser] = await tx
          .select({ id: users.id, displayName: users.displayName })
          .from(users)
          .where(eq(users.id, callerId));

        const responseData: CommentWithAuthor = {
          id: newComment.id,
          taskId: newComment.taskId,
          authorId: newComment.authorId,
          author: {
            id: authorUser?.id ?? callerId,
            name: authorUser?.displayName ?? "",
          },
          body: newComment.body,
          createdAt: newComment.createdAt,
          deletedAt: newComment.deletedAt ?? null,
        };

        // 7. Persist idempotency record in the same transaction
        await IdempotencyService.save(tx, {
          actorId: callerId,
          endpointKey,
          idempotencyKey,
          requestHash,
          responseStatus: 201,
          responseBody: { comment: responseData },
        });

        return { comment: responseData, replayed: false };
      });
    } catch (err: any) {
      // Catch concurrent unique constraint violation on idempotency_records (Postgres code 23505)
      if (err?.code === "23505" || err?.message?.includes("idempotency_records_actor_endpoint_key_unique")) {
        const cached = await IdempotencyService.check(db, {
          actorId: callerId,
          endpointKey,
          idempotencyKey,
          requestHash,
        });
        if (cached) {
          return {
            comment: (cached.body as { comment: CommentWithAuthor }).comment,
            replayed: true,
          };
        }
      }
      throw err;
    }
  }

  /**
   * Lists active comments belonging to a task (omits soft-deleted comments).
   * Ordered chronologically by created_at ASC, id ASC.
   * Permitted on both active and archived tasks for workspace members.
   * Conceals non-existent tasks or non-member access with 404 NOT_FOUND.
   */
  static async listComments(
    db: Database,
    { taskId, callerId }: ListCommentsParams
  ): Promise<CommentWithAuthor[]> {
    // 1. Verify task exists and caller is an active workspace member (404 concealment)
    await this.getTaskWithContext(db, taskId, callerId, false);

    // 2. Fetch comments where taskId = taskId AND deletedAt IS NULL, joined with users
    const rows = await db
      .select({
        id: comments.id,
        taskId: comments.taskId,
        authorId: comments.authorId,
        authorName: users.displayName,
        body: comments.body,
        createdAt: comments.createdAt,
        deletedAt: comments.deletedAt,
      })
      .from(comments)
      .innerJoin(users, eq(comments.authorId, users.id))
      .where(and(eq(comments.taskId, taskId), isNull(comments.deletedAt)))
      .orderBy(asc(comments.createdAt), asc(comments.id));

    return rows.map((r) => ({
      id: r.id,
      taskId: r.taskId,
      authorId: r.authorId,
      author: {
        id: r.authorId,
        name: r.authorName,
      },
      body: r.body,
      createdAt: r.createdAt,
      deletedAt: r.deletedAt ?? null,
    }));
  }

  /**
   * Soft-deletes a comment (sets deleted_at = now()).
   * - Author can delete their own comment.
   * - Workspace Owner or Admin can delete any comment.
   * - Regular Member attempting to delete another's comment receives 403 FORBIDDEN.
   * - Repeated deletion of an already deleted comment is an idempotent no-op.
   * - Rejects deletion on archived tasks with 409 TASK_ARCHIVED.
   * - Rejects deletion in archived projects with 409 PROJECT_ARCHIVED.
   * - Conceals non-existent comments or non-member access with 404 NOT_FOUND.
   */
  static async deleteComment(
    db: Database,
    { commentId, callerId }: DeleteCommentParams
  ): Promise<{ status: boolean; message: string }> {
    return await db.transaction(async (tx) => {
      // 1. Resolve comment with context (comment -> task -> project -> workspaceMember)
      const { comment, task, project, membership } = await this.getCommentWithContext(
        tx,
        commentId,
        callerId,
        true
      );

      // 2. Reject if parent project is archived
      if (project.archivedAt !== null) {
        throw AppError.conflict("PROJECT_ARCHIVED", "Cannot delete comments in an archived project");
      }

      // 3. Reject if parent task is archived
      if (task.archivedAt !== null) {
        throw AppError.conflict("TASK_ARCHIVED", "Cannot delete comments on an archived task");
      }

      // 4. Role permission enforcement:
      // Author can delete own comment. Owner and Admin can delete any comment.
      const isAuthor = comment.authorId === callerId;
      const isAdminOrOwner = membership.role === "owner" || membership.role === "admin";

      if (!isAuthor && !isAdminOrOwner) {
        throw AppError.forbidden("You do not have permission to delete this comment");
      }

      // 5. If already soft-deleted, idempotent no-op
      if (comment.deletedAt !== null) {
        return { status: true, message: "Comment deleted" };
      }

      // 6. Soft delete by setting deleted_at = now()
      await tx
        .update(comments)
        .set({ deletedAt: new Date() })
        .where(and(eq(comments.id, commentId), isNull(comments.deletedAt)));

      return { status: true, message: "Comment deleted" };
    });
  }
}
