import { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db/index.js";
import type { Auth } from "../auth/index.js";
import { createRequireAuth } from "../middleware/auth.js";
import { TaskService } from "../services/task.js";
import { CommentService } from "../services/comment.js";

const uuidParamSchema = z.string().uuid("Invalid ID format");

const createCommentSchema = z.object({
  body: z
    .string({ required_error: "Comment body is required" })
    .trim()
    .min(1, "Comment body cannot be empty")
    .max(10000, "Comment body cannot exceed 10000 characters"),
});

const updateTaskSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, "Title cannot be empty")
    .max(255, "Title cannot exceed 255 characters")
    .optional(),
  description: z.string().max(10000, "Description cannot exceed 10000 characters").optional(),
  assigneeId: z.string().uuid("Invalid assignee ID").nullable().optional(),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Due date must be in YYYY-MM-DD format")
    .nullable()
    .optional(),
  expectedVersion: z
    .number({ required_error: "expectedVersion is required" })
    .int("expectedVersion must be an integer")
    .positive("expectedVersion must be a positive integer"),
});

const moveTaskSchema = z.object({
  columnId: z.string({ required_error: "columnId is required" }).uuid("Invalid destination column ID"),
  expectedVersion: z
    .number({ required_error: "expectedVersion is required" })
    .int("expectedVersion must be an integer")
    .positive("expectedVersion must be a positive integer"),
});

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

  // 2. PATCH /api/tasks/:taskId - Edit task fields
  router.patch("/:taskId", async (c) => {
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

    const body = await c.req.json().catch(() => ({}));
    const parsed = updateTaskSchema.safeParse(body);

    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid update payload",
            details: parsed.error.flatten(),
          },
        },
        400
      );
    }

    const task = await TaskService.updateTask(db, {
      taskId,
      callerId: user.id,
      expectedVersion: parsed.data.expectedVersion,
      title: parsed.data.title,
      description: parsed.data.description,
      assigneeId: parsed.data.assigneeId,
      dueDate: parsed.data.dueDate,
    });

    return c.json({ task });
  });

  // 3. POST /api/tasks/:taskId/move - Move task between columns
  router.post("/:taskId/move", async (c) => {
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

    const body = await c.req.json().catch(() => ({}));
    const parsed = moveTaskSchema.safeParse(body);

    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid move payload",
            details: parsed.error.flatten(),
          },
        },
        400
      );
    }

    const task = await TaskService.moveTask(db, {
      taskId,
      callerId: user.id,
      columnId: parsed.data.columnId,
      expectedVersion: parsed.data.expectedVersion,
    });

    return c.json({ task });
  });

  // 4. POST /api/tasks/:taskId/archive - Archive task
  router.post("/:taskId/archive", async (c) => {
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

    const task = await TaskService.archiveTask(db, {
      taskId,
      callerId: user.id,
    });

    return c.json({ task });
  });

  // 5. POST /api/tasks/:taskId/restore - Restore task
  router.post("/:taskId/restore", async (c) => {
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

    const task = await TaskService.restoreTask(db, {
      taskId,
      callerId: user.id,
    });

    return c.json({ task });
  });

  // 6. POST /api/tasks/:taskId/comments - Create comment on task
  router.post("/:taskId/comments", async (c) => {
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

    const rawKey = c.req.header("Idempotency-Key");
    const idempotencyKey = rawKey?.trim();
    if (!idempotencyKey || idempotencyKey.length === 0 || idempotencyKey.length > 128) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Valid Idempotency-Key header is required (1-128 characters)",
          },
        },
        400
      );
    }

    const body = await c.req.json().catch(() => ({}));
    const parsed = createCommentSchema.safeParse(body);

    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid comment payload",
            details: parsed.error.flatten(),
          },
        },
        400
      );
    }

    const result = await CommentService.createComment(db, {
      taskId,
      callerId: user.id,
      body: parsed.data.body,
      idempotencyKey,
      requestPath: c.req.path,
    });

    return c.json({ comment: result.comment }, 201);
  });

  // 7. GET /api/tasks/:taskId/comments - List comments for task
  router.get("/:taskId/comments", async (c) => {
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

    const commentsList = await CommentService.listComments(db, {
      taskId,
      callerId: user.id,
    });

    return c.json({ comments: commentsList });
  });

  return router;
}
