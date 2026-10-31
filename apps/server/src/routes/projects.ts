import { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db/index.js";
import type { Auth } from "../auth/index.js";
import { createRequireAuth } from "../middleware/auth.js";
import { ProjectService } from "../services/project.js";

const uuidParamSchema = z.string().uuid("Invalid ID format");

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

  return router;
}

