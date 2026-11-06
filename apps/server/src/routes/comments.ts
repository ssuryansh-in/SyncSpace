import { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db/index.js";
import type { Auth } from "../auth/index.js";
import { createRequireAuth } from "../middleware/auth.js";
import { CommentService } from "../services/comment.js";

const uuidParamSchema = z.string().uuid("Invalid ID format");

export interface CommentRouteOptions {
  db: Database;
  auth: Auth;
}

/**
 * Creates and configures the comment router (/api/comments).
 * Reference: docs/SPECIFICATION.md Section 10.3
 */
export function createCommentRoutes(options: CommentRouteOptions): Hono {
  const router = new Hono();
  const db = options.db;

  // Protect all comment routes with session authentication
  router.use("*", createRequireAuth(options.auth));

  // DELETE /api/comments/:commentId - Soft delete comment
  router.delete("/:commentId", async (c) => {
    const user = c.get("user");
    const commentId = c.req.param("commentId");

    if (!commentId || !uuidParamSchema.safeParse(commentId).success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid comment ID",
          },
        },
        400
      );
    }

    const result = await CommentService.deleteComment(db, {
      commentId,
      callerId: user.id,
    });

    return c.json(result);
  });

  return router;
}

