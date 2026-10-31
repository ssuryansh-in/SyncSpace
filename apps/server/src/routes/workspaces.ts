import { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db/index.js";
import type { Auth } from "../auth/index.js";
import { createRequireAuth } from "../middleware/auth.js";
import { createRateLimiter } from "../middleware/rate-limit.js";
import { WorkspaceService } from "../services/workspace.js";
import { MembershipService } from "../services/membership.js";
import { ProjectService } from "../services/project.js";

const createWorkspaceSchema = z.object({
  name: z
    .string({ required_error: "Name is required" })
    .trim()
    .min(1, "Name cannot be empty")
    .max(100, "Name cannot exceed 100 characters"),
});

const updateWorkspaceSchema = z.object({
  name: z
    .string({ required_error: "Name is required" })
    .trim()
    .min(1, "Name cannot be empty")
    .max(100, "Name cannot exceed 100 characters"),
});

const addMemberSchema = z.object({
  email: z
    .string({ required_error: "Email is required" })
    .trim()
    .email("Invalid email address"),
  role: z.enum(["admin", "member"]).default("member"),
});

const updateRoleSchema = z.object({
  role: z.enum(["admin", "member"], {
    errorMap: () => ({ message: "Role must be 'admin' or 'member'" }),
  }),
});

const transferOwnershipSchema = z.object({
  newOwnerId: z
    .string({ required_error: "newOwnerId is required" })
    .uuid("Invalid user ID format"),
});

const createProjectSchema = z.object({
  name: z
    .string({ required_error: "Name is required" })
    .trim()
    .min(1, "Name cannot be empty")
    .max(100, "Name cannot exceed 100 characters"),
});

const uuidParamSchema = z.string().uuid("Invalid ID format");

export interface WorkspaceRouteOptions {
  db: Database;
  auth: Auth;
  rateLimit?: {
    enabled?: boolean | undefined;
    windowMs?: number | undefined;
    max?: number | undefined;
  } | undefined;
}

/**
 * Creates and configures the workspace router.
 * Reference: docs/SPECIFICATION.md Section 10.1
 */
export function createWorkspaceRoutes(options: WorkspaceRouteOptions): Hono {
  const router = new Hono();
  const db = options.db;

  // Protect all workspace routes with session authentication
  router.use("*", createRequireAuth(options.auth));

  // Rate limiter for member addition to protect against account enumeration
  const memberAdditionRateLimiter = createRateLimiter({
    enabled: options.rateLimit?.enabled ?? true,
    windowMs: options.rateLimit?.windowMs ?? 60_000,
    max: options.rateLimit?.max ?? 10,
  });

  // 1. POST /api/workspaces - Create workspace
  router.post("/", async (c) => {
    const user = c.get("user");
    const body = await c.req.json().catch(() => ({}));
    const parsed = createWorkspaceSchema.safeParse(body);

    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid workspace payload",
            details: parsed.error.flatten(),
          },
        },
        400
      );
    }

    const result = await WorkspaceService.createWorkspace(db, {
      name: parsed.data.name,
      ownerId: user.id,
    });

    return c.json(result, 201);
  });

  // 2. GET /api/workspaces - List user's workspaces
  router.get("/", async (c) => {
    const user = c.get("user");
    const workspaces = await WorkspaceService.listWorkspaces(db, {
      userId: user.id,
    });

    return c.json({ workspaces });
  });

  // 3. GET /api/workspaces/:workspaceId - Workspace details & members
  router.get("/:workspaceId", async (c) => {
    const user = c.get("user");
    const workspaceId = c.req.param("workspaceId");

    if (!workspaceId || !uuidParamSchema.safeParse(workspaceId).success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid workspace ID",
          },
        },
        400
      );
    }

    const details = await WorkspaceService.getWorkspace(db, {
      workspaceId,
      userId: user.id,
    });

    if (!details) {
      return c.json(
        {
          error: {
            code: "NOT_FOUND",
            message: "Workspace not found",
          },
        },
        404
      );
    }

    return c.json(details);
  });

  // 4. PATCH /api/workspaces/:workspaceId - Update workspace name
  router.patch("/:workspaceId", async (c) => {
    const user = c.get("user");
    const workspaceId = c.req.param("workspaceId");

    if (!workspaceId || !uuidParamSchema.safeParse(workspaceId).success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid workspace ID",
          },
        },
        400
      );
    }

    const body = await c.req.json().catch(() => ({}));
    const parsed = updateWorkspaceSchema.safeParse(body);

    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid workspace payload",
            details: parsed.error.flatten(),
          },
        },
        400
      );
    }

    const workspace = await WorkspaceService.updateWorkspace(db, {
      workspaceId,
      userId: user.id,
      name: parsed.data.name,
    });

    return c.json({ workspace });
  });

  // 5. POST /api/workspaces/:workspaceId/transfer-ownership - Transfer ownership
  router.post("/:workspaceId/transfer-ownership", async (c) => {
    const user = c.get("user");
    const workspaceId = c.req.param("workspaceId");

    if (!workspaceId || !uuidParamSchema.safeParse(workspaceId).success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid workspace ID",
          },
        },
        400
      );
    }

    const body = await c.req.json().catch(() => ({}));
    const parsed = transferOwnershipSchema.safeParse(body);

    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid transfer ownership payload",
            details: parsed.error.flatten(),
          },
        },
        400
      );
    }

    const result = await WorkspaceService.transferOwnership(db, {
      workspaceId,
      currentOwnerId: user.id,
      newOwnerId: parsed.data.newOwnerId,
    });

    return c.json(result);
  });

  // 6. POST /api/workspaces/:workspaceId/members - Add member by email
  router.post("/:workspaceId/members", memberAdditionRateLimiter, async (c) => {
    const user = c.get("user");
    const workspaceId = c.req.param("workspaceId");

    if (!workspaceId || !uuidParamSchema.safeParse(workspaceId).success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid workspace ID",
          },
        },
        400
      );
    }

    const body = await c.req.json().catch(() => ({}));
    const parsed = addMemberSchema.safeParse(body);

    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid member addition payload",
            details: parsed.error.flatten(),
          },
        },
        400
      );
    }

    const result = await MembershipService.addMember(db, {
      workspaceId,
      callerId: user.id,
      email: parsed.data.email,
      role: parsed.data.role,
    });

    return c.json(result);
  });

  // 7. PATCH /api/workspaces/:workspaceId/members/:userId - Update member role
  router.patch("/:workspaceId/members/:userId", async (c) => {
    const user = c.get("user");
    const workspaceId = c.req.param("workspaceId");
    const targetUserId = c.req.param("userId");

    if (
      !workspaceId ||
      !targetUserId ||
      !uuidParamSchema.safeParse(workspaceId).success ||
      !uuidParamSchema.safeParse(targetUserId).success
    ) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid workspace or user ID",
          },
        },
        400
      );
    }

    const body = await c.req.json().catch(() => ({}));
    const parsed = updateRoleSchema.safeParse(body);

    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid role update payload",
            details: parsed.error.flatten(),
          },
        },
        400
      );
    }

    const member = await MembershipService.updateMemberRole(db, {
      workspaceId,
      callerId: user.id,
      targetUserId,
      newRole: parsed.data.role,
    });

    return c.json({ member });
  });

  // 8. DELETE /api/workspaces/:workspaceId/members/:userId - Remove member or leave
  router.delete("/:workspaceId/members/:userId", async (c) => {
    const user = c.get("user");
    const workspaceId = c.req.param("workspaceId");
    const targetUserId = c.req.param("userId");

    if (
      !workspaceId ||
      !targetUserId ||
      !uuidParamSchema.safeParse(workspaceId).success ||
      !uuidParamSchema.safeParse(targetUserId).success
    ) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid workspace or user ID",
          },
        },
        400
      );
    }

    const result = await MembershipService.removeMember(db, {
      workspaceId,
      callerId: user.id,
      targetUserId,
    });

    return c.json(result);
  });

  // 9. POST /api/workspaces/:workspaceId/projects - Create project & seed fixed columns
  router.post("/:workspaceId/projects", async (c) => {
    const user = c.get("user");
    const workspaceId = c.req.param("workspaceId");

    if (!workspaceId || !uuidParamSchema.safeParse(workspaceId).success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid workspace ID",
          },
        },
        400
      );
    }

    const body = await c.req.json().catch(() => ({}));
    const parsed = createProjectSchema.safeParse(body);

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

    const result = await ProjectService.createProject(db, {
      workspaceId,
      callerId: user.id,
      name: parsed.data.name,
    });

    return c.json(result, 201);
  });

  // 10. GET /api/workspaces/:workspaceId/projects - List workspace projects
  router.get("/:workspaceId/projects", async (c) => {
    const user = c.get("user");
    const workspaceId = c.req.param("workspaceId");

    if (!workspaceId || !uuidParamSchema.safeParse(workspaceId).success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid workspace ID",
          },
        },
        400
      );
    }

    const projectsList = await ProjectService.listProjects(db, {
      workspaceId,
      callerId: user.id,
    });

    return c.json({ projects: projectsList });
  });

  return router;
}
