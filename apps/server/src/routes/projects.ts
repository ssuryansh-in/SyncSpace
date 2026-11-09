import { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db/index.js";
import type { Auth } from "../auth/index.js";
import { createRequireAuth } from "../middleware/auth.js";
import { EventService } from "../services/event.js";
import { ProjectService } from "../services/project.js";
import { TaskService } from "../services/task.js";

const uuidParamSchema = z.string().uuid("Invalid ID format");

const updateProjectSchema = z.object({
  name: z
    .string({ required_error: "Name is required" })
    .trim()
    .min(1, "Name cannot be empty")
    .max(100, "Name cannot exceed 100 characters"),
});

const createTaskSchema = z.object({
  title: z
    .string({ required_error: "Title is required" })
    .trim()
    .min(1, "Title cannot be empty")
    .max(255, "Title cannot exceed 255 characters"),
  columnId: z.string({ required_error: "Column ID is required" }).uuid("Invalid column ID"),
  description: z.string().max(10000, "Description cannot exceed 10000 characters").optional().default(""),
  assigneeId: z.string().uuid("Invalid assignee ID").nullable().optional(),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Due date must be in YYYY-MM-DD format")
    .nullable()
    .optional(),
});

const listTasksQuerySchema = z.object({
  columnId: z.string().uuid("Invalid column ID filter").optional(),
  assigneeId: z.string().uuid("Invalid assignee ID filter").optional(),
});

const changesQuerySchema = z.object({
  after: z
    .string({ required_error: "after query parameter is required" })
    .min(1, "after query parameter cannot be empty")
    .regex(/^\d+$/, "after query parameter must be a non-negative integer")
    .transform(Number)
    .refine(Number.isSafeInteger, {
      message: "after sequence must be a safe integer",
    }),
  limit: z
    .string()
    .min(1, "limit parameter cannot be empty")
    .regex(/^[1-9]\d*$/, "limit must be a positive integer")
    .default("50")
    .transform(Number)
    .refine((val) => val <= 100, {
      message: "limit cannot exceed 100",
    }),
});

const eventsQuerySchema = z.object({
  before: z
    .string()
    .min(1, "before parameter cannot be empty")
    .regex(/^\d+$/, "before must be a positive integer")
    .transform(Number)
    .refine(Number.isSafeInteger, {
      message: "before must be a safe integer",
    })
    .refine((val) => val > 0, {
      message: "before must be a positive integer",
    })
    .optional(),
  limit: z
    .string()
    .min(1, "limit parameter cannot be empty")
    .regex(/^\d+$/, "limit must be a positive integer")
    .transform(Number)
    .refine(Number.isSafeInteger, {
      message: "limit must be a safe integer",
    })
    .refine((val) => val > 0 && val <= 50, {
      message: "limit must be between 1 and 50",
    })
    .optional(),
});

export interface ProjectRouteOptions {
  db: Database;
  auth: Auth;
}

/**
 * Creates and configures the project router (/api/projects).
 * Reference: docs/SPECIFICATION.md Section 10.2
 */
export function createProjectRoutes(options: ProjectRouteOptions): Hono {
  const router = new Hono();
  const db = options.db;

  // Protect all project routes with session authentication
  router.use("*", createRequireAuth(options.auth));

  // 1. GET /api/projects/:projectId - Project metadata
  router.get("/:projectId", async (c) => {
    const user = c.get("user");
    const projectId = c.req.param("projectId");

    if (!projectId || !uuidParamSchema.safeParse(projectId).success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid project ID",
          },
        },
        400
      );
    }

    const project = await ProjectService.getProject(db, {
      projectId,
      callerId: user.id,
    });

    if (!project) {
      return c.json(
        {
          error: {
            code: "NOT_FOUND",
            message: "Project not found",
          },
        },
        404
      );
    }

    return c.json({ project });
  });

  // 2. GET /api/projects/:projectId/board - Board metadata and status columns
  router.get("/:projectId/board", async (c) => {
    const user = c.get("user");
    const projectId = c.req.param("projectId");

    if (!projectId || !uuidParamSchema.safeParse(projectId).success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid project ID",
          },
        },
        400
      );
    }

    const board = await ProjectService.getBoard(db, {
      projectId,
      callerId: user.id,
    });

    if (!board) {
      return c.json(
        {
          error: {
            code: "NOT_FOUND",
            message: "Project not found",
          },
        },
        404
      );
    }

    return c.json(board);
  });

  // 3. GET /api/projects/:projectId/changes - Catch-up event stream
  router.get("/:projectId/changes", async (c) => {
    const user = c.get("user");
    const projectId = c.req.param("projectId");

    if (!projectId || !uuidParamSchema.safeParse(projectId).success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid project ID",
          },
        },
        400
      );
    }

    const parsedQuery = changesQuerySchema.safeParse(c.req.query());
    if (!parsedQuery.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message:
              "Invalid query parameters: " +
              parsedQuery.error.issues.map((i) => i.message).join(", "),
            details: parsedQuery.error.flatten(),
          },
        },
        400
      );
    }

    const result = await EventService.getProjectChanges(db, {
      projectId,
      callerId: user.id,
      after: parsedQuery.data.after,
      limit: parsedQuery.data.limit,
    });

    return c.json(result, 200);
  });

  // 3.5. GET /api/projects/:projectId/events - Paginated project activity history
  router.get("/:projectId/events", async (c) => {
    const user = c.get("user");
    const projectId = c.req.param("projectId");

    if (!projectId || !uuidParamSchema.safeParse(projectId).success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid project ID",
          },
        },
        400
      );
    }

    const parsedQuery = eventsQuerySchema.safeParse(c.req.query());
    if (!parsedQuery.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message:
              "Invalid query parameters: " +
              parsedQuery.error.issues.map((i) => i.message).join(", "),
            details: parsedQuery.error.flatten(),
          },
        },
        400
      );
    }

    const result = await EventService.getProjectEvents(db, {
      projectId,
      callerId: user.id,
      before: parsedQuery.data.before,
      limit: parsedQuery.data.limit,
    });

    return c.json(result, 200);
  });

  // 4. PATCH /api/projects/:projectId - Rename project (Owner/Admin only)
  router.patch("/:projectId", async (c) => {
    const user = c.get("user");
    const projectId = c.req.param("projectId");

    if (!projectId || !uuidParamSchema.safeParse(projectId).success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid project ID",
          },
        },
        400
      );
    }

    const body = await c.req.json().catch(() => ({}));
    const parsed = updateProjectSchema.safeParse(body);

    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid project payload",
            details: parsed.error.flatten(),
          },
        },
        400
      );
    }

    const project = await ProjectService.renameProject(db, {
      projectId,
      callerId: user.id,
      name: parsed.data.name,
    });

    return c.json({ project });
  });

  // 4. POST /api/projects/:projectId/archive - Archive project (Owner/Admin only)
  router.post("/:projectId/archive", async (c) => {
    const user = c.get("user");
    const projectId = c.req.param("projectId");

    if (!projectId || !uuidParamSchema.safeParse(projectId).success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid project ID",
          },
        },
        400
      );
    }

    const project = await ProjectService.archiveProject(db, {
      projectId,
      callerId: user.id,
    });

    return c.json({ project });
  });

  // 5. POST /api/projects/:projectId/restore - Restore archived project (Owner/Admin only)
  router.post("/:projectId/restore", async (c) => {
    const user = c.get("user");
    const projectId = c.req.param("projectId");

    if (!projectId || !uuidParamSchema.safeParse(projectId).success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid project ID",
          },
        },
        400
      );
    }

    const project = await ProjectService.restoreProject(db, {
      projectId,
      callerId: user.id,
    });

    return c.json({ project });
  });

  // 6. POST /api/projects/:projectId/tasks - Create task in project
  router.post("/:projectId/tasks", async (c) => {
    const user = c.get("user");
    const projectId = c.req.param("projectId");

    if (!projectId || !uuidParamSchema.safeParse(projectId).success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid project ID",
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
    const parsed = createTaskSchema.safeParse(body);

    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid task payload",
            details: parsed.error.flatten(),
          },
        },
        400
      );
    }

    const result = await TaskService.createTask(db, {
      projectId,
      callerId: user.id,
      title: parsed.data.title,
      columnId: parsed.data.columnId,
      description: parsed.data.description,
      assigneeId: parsed.data.assigneeId,
      dueDate: parsed.data.dueDate,
      idempotencyKey,
      requestPath: c.req.path,
    });

    return c.json({ task: result.task }, 201);
  });

  // 7. GET /api/projects/:projectId/tasks - List active tasks in project
  router.get("/:projectId/tasks", async (c) => {
    const user = c.get("user");
    const projectId = c.req.param("projectId");

    if (!projectId || !uuidParamSchema.safeParse(projectId).success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid project ID",
          },
        },
        400
      );
    }

    const parsedQuery = listTasksQuerySchema.safeParse(c.req.query());
    if (!parsedQuery.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid query parameter",
            details: parsedQuery.error.flatten(),
          },
        },
        400
      );
    }

    const tasks = await TaskService.listTasks(db, {
      projectId,
      callerId: user.id,
      columnId: parsedQuery.data.columnId,
      assigneeId: parsedQuery.data.assigneeId,
    });

    return c.json({ tasks });
  });

  return router;
}

