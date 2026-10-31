import { describe, expect, it } from "vitest";
import { AppError } from "../src/errors/index.js";
import { createRateLimiter } from "../src/middleware/rate-limit.js";

describe("Workspace Permissions & AppError Unit Tests", () => {
  describe("AppError Class", () => {
    it("creates standard badRequest error", () => {
      const err = AppError.badRequest("Invalid name", { field: "name" });
      expect(err.code).toBe("VALIDATION_ERROR");
      expect(err.statusCode).toBe(400);
      expect(err.message).toBe("Invalid name");
      expect(err.details).toEqual({ field: "name" });
    });

    it("creates standard unauthenticated error", () => {
      const err = AppError.unauthenticated();
      expect(err.code).toBe("UNAUTHENTICATED");
      expect(err.statusCode).toBe(401);
      expect(err.message).toBe("Authentication required");
    });

    it("creates standard forbidden error", () => {
      const err = AppError.forbidden("Admin only");
      expect(err.code).toBe("FORBIDDEN");
      expect(err.statusCode).toBe(403);
      expect(err.message).toBe("Admin only");
    });

    it("creates standard notFound error", () => {
      const err = AppError.notFound("Workspace not found");
      expect(err.code).toBe("NOT_FOUND");
      expect(err.statusCode).toBe(404);
      expect(err.message).toBe("Workspace not found");
    });

    it("creates standard rateLimited error", () => {
      const err = AppError.rateLimited();
      expect(err.code).toBe("RATE_LIMITED");
      expect(err.statusCode).toBe(429);
    });

    it("creates standard conflict error", () => {
      const err = AppError.conflict("VERSION_CONFLICT", "Task has changed", { version: 5 });
      expect(err.code).toBe("VERSION_CONFLICT");
      expect(err.statusCode).toBe(409);
      expect(err.details).toEqual({ version: 5 });
    });
  });

  describe("In-Memory Rate Limiter Middleware", () => {
    it("allows requests under the rate limit threshold", async () => {
      const limiter = createRateLimiter({ windowMs: 1000, max: 3 });
      let nextCalled = 0;
      const fakeNext = async () => {
        nextCalled++;
      };

      const fakeContext = {
        get: () => ({ id: "user-123" }),
        req: { header: () => undefined },
        json: (data: unknown, status: number) => ({ data, status }),
      } as any;

      await limiter(fakeContext, fakeNext);
      await limiter(fakeContext, fakeNext);
      await limiter(fakeContext, fakeNext);

      expect(nextCalled).toBe(3);
    });

    it("blocks requests that exceed the rate limit threshold with 429", async () => {
      const limiter = createRateLimiter({ windowMs: 1000, max: 2 });
      let nextCalled = 0;
      const fakeNext = async () => {
        nextCalled++;
      };

      const responses: any[] = [];
      const fakeContext = {
        get: () => ({ id: "user-spam" }),
        req: { header: () => undefined },
        json: (data: unknown, status: number) => {
          responses.push({ data, status });
          return { data, status };
        },
      } as any;

      await limiter(fakeContext, fakeNext);
      await limiter(fakeContext, fakeNext);
      const blocked = await limiter(fakeContext, fakeNext);

      expect(nextCalled).toBe(2);
      expect(blocked).toEqual({
        data: {
          error: {
            code: "RATE_LIMITED",
            message: "Too many member addition attempts. Please try again later.",
          },
        },
        status: 429,
      });
    });

    it("passes through immediately when disabled", async () => {
      const limiter = createRateLimiter({ enabled: false, max: 0 });
      let nextCalled = 0;
      const fakeNext = async () => {
        nextCalled++;
      };

      const fakeContext = {
        get: () => ({ id: "user-disabled" }),
        req: { header: () => undefined },
        json: () => {},
      } as any;

      await limiter(fakeContext, fakeNext);
      expect(nextCalled).toBe(1);
    });

    it("prunes expired timestamps when window elapses", async () => {
      const limiter = createRateLimiter({ windowMs: 50, max: 2 });
      let nextCalled = 0;
      const fakeNext = async () => {
        nextCalled++;
      };

      const fakeContext = {
        get: () => ({ id: "user-expire" }),
        req: { header: () => undefined },
        json: (data: unknown, status: number) => ({ data, status }),
      } as any;

      await limiter(fakeContext, fakeNext);
      await limiter(fakeContext, fakeNext);
      expect(nextCalled).toBe(2);

      // Wait for window to elapse
      await new Promise((resolve) => setTimeout(resolve, 60));

      // Next request should succeed after expiration, rather than being blocked
      await limiter(fakeContext, fakeNext);
      expect(nextCalled).toBe(3);
    });
  });
});

