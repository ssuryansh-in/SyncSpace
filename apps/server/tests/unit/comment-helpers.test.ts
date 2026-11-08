import { describe, expect, it } from "vitest";
import {
  buildCommentCreatedPayload,
  buildCommentDeletedPayload,
} from "../../src/services/comment.js";
import {
  commentCreatedPayloadSchema,
  commentDeletedPayloadSchema,
} from "../../src/services/event.js";
import type { Comment } from "../../src/db/schema/index.js";

describe("Comment Event Payload Helpers (Unit - Milestone 7.3-2)", () => {
  const mockComment: Comment = {
    id: "33333333-3333-3333-3333-333333333333",
    taskId: "44444444-4444-4444-4444-444444444444",
    authorId: "55555555-5555-5555-5555-555555555555",
    body: "Confidential comment body text that must never leak into event log",
    createdAt: new Date("2026-11-08T10:00:00.000Z"),
    deletedAt: null,
  };

  describe("buildCommentCreatedPayload", () => {
    it("produces a strict payload with exactly 4 fields and valid ISO timestamp", () => {
      const payload = buildCommentCreatedPayload(mockComment);

      expect(payload).toEqual({
        commentId: "33333333-3333-3333-3333-333333333333",
        taskId: "44444444-4444-4444-4444-444444444444",
        authorId: "55555555-5555-5555-5555-555555555555",
        createdAt: "2026-11-08T10:00:00.000Z",
      });

      // Strict validation against official Zod event schema
      expect(() => commentCreatedPayloadSchema.parse(payload)).not.toThrow();
    });

    it("strictly excludes comment body text from the payload", () => {
      const payload = buildCommentCreatedPayload(mockComment);

      expect(payload).not.toHaveProperty("body");
      expect(JSON.stringify(payload)).not.toContain("Confidential");
    });

    it("handles string or Date input for createdAt deterministically", () => {
      const commentWithStringDate = {
        ...mockComment,
        createdAt: "2026-11-08T10:00:00.000Z" as any,
      };

      const payload = buildCommentCreatedPayload(commentWithStringDate);
      expect(payload.createdAt).toBe("2026-11-08T10:00:00.000Z");
      expect(() => commentCreatedPayloadSchema.parse(payload)).not.toThrow();
    });
  });

  describe("buildCommentDeletedPayload", () => {
    it("produces a strict payload with exactly 4 fields and valid ISO timestamp", () => {
      const deleteTime = new Date("2026-11-08T12:30:00.000Z");
      const payload = buildCommentDeletedPayload(mockComment, deleteTime);

      expect(payload).toEqual({
        commentId: "33333333-3333-3333-3333-333333333333",
        taskId: "44444444-4444-4444-4444-444444444444",
        authorId: "55555555-5555-5555-5555-555555555555",
        deletedAt: "2026-11-08T12:30:00.000Z",
      });

      // Strict validation against official Zod event schema
      expect(() => commentDeletedPayloadSchema.parse(payload)).not.toThrow();
    });

    it("strictly excludes comment body text from the payload", () => {
      const deleteTime = new Date("2026-11-08T12:30:00.000Z");
      const payload = buildCommentDeletedPayload(mockComment, deleteTime);

      expect(payload).not.toHaveProperty("body");
      expect(JSON.stringify(payload)).not.toContain("Confidential");
    });

    it("handles string or Date input for deletedAt deterministically", () => {
      const payload = buildCommentDeletedPayload(mockComment, "2026-11-08T12:30:00.000Z");
      expect(payload.deletedAt).toBe("2026-11-08T12:30:00.000Z");
      expect(() => commentDeletedPayloadSchema.parse(payload)).not.toThrow();
    });
  });

  describe("Privacy & Schema Strictness Enforcements", () => {
    it("rejects comment.created payload if body is accidentally included", () => {
      const invalidPayload = {
        commentId: mockComment.id,
        taskId: mockComment.taskId,
        authorId: mockComment.authorId,
        createdAt: "2026-11-08T10:00:00.000Z",
        body: "Leaked body text",
      };

      expect(() => commentCreatedPayloadSchema.parse(invalidPayload)).toThrow();
    });

    it("rejects comment.deleted payload if body is accidentally included", () => {
      const invalidPayload = {
        commentId: mockComment.id,
        taskId: mockComment.taskId,
        authorId: mockComment.authorId,
        deletedAt: "2026-11-08T12:30:00.000Z",
        body: "Leaked body text",
      };

      expect(() => commentDeletedPayloadSchema.parse(invalidPayload)).toThrow();
    });

    it("rejects payloads containing task-style snapshot or changes wrappers", () => {
      const invalidCreated = {
        commentId: mockComment.id,
        taskId: mockComment.taskId,
        authorId: mockComment.authorId,
        createdAt: "2026-11-08T10:00:00.000Z",
        snapshot: { id: mockComment.id },
      };

      expect(() => commentCreatedPayloadSchema.parse(invalidCreated)).toThrow();

      const invalidDeleted = {
        commentId: mockComment.id,
        taskId: mockComment.taskId,
        authorId: mockComment.authorId,
        deletedAt: "2026-11-08T12:30:00.000Z",
        changes: { deleted: true },
      };

      expect(() => commentDeletedPayloadSchema.parse(invalidDeleted)).toThrow();
    });
  });
});

