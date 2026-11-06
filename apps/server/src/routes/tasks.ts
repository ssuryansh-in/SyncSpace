import { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db/index.js";
import type { Auth } from "../auth/index.js";
import { createRequireAuth } from "../middleware/auth.js";
import { TaskService } from "../services/task.js";

const uuidParamSchema = z.string().uuid("Invalid ID format");

export interface TaskRouteOptions {
  db: Database;
  auth: Auth;
}

/**
 * Creates and configures the task router (/api/tasks).
 * Reference: docs/SPECIFICATION.md Section 10.3
 */
export function createTaskRoutes(options: TaskRouteOptions): Hono {
  const router = new Hono();
  const db = options.db;

  // Protect all task routes with session authentication
  router.use("*", createRequireAuth(options.auth));

  // 1. GET /api/tasks/:taskId - Retrieve task details
  router.get("/:taskId", async (c) => {
    const user = c.get("user");
    const taskId = c.req.param("taskId");

    if (!taskId || !uuidParamSchema.safeParse(taskId).success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid task ID",
          },
        },
        400
      );
    }

    const task = await TaskService.getTask(db, {
      taskId,
      callerId: user.id,
    });

    return c.json({ task });
  });

  return router;
}

