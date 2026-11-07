import { describe, expect, it } from "vitest";
import {
  buildTaskSnapshot,
  buildTaskChanges,
  buildTaskCreatedChanges,
} from "../../src/services/task.js";
import {
  taskSnapshotSchema,
  taskChangesSchema,
} from "../../src/services/event.js";
import type { Task } from "../../src/db/schema/index.js";

describe("Task Snapshot and Diff Helpers (Unit - Milestone 7.2A)", () => {
  const mockTask: Task = {
    id: "33333333-3333-3333-3333-333333333333",
    projectId: "11111111-1111-1111-1111-111111111111",
    columnId: "44444444-4444-4444-4444-444444444444",
    title: "Initial Title",
    description: "Initial secret description content",
    createdBy: "22222222-2222-2222-2222-222222222222",
    assigneeId: null,
    rankKey: "a0",
    version: 1,
    dueDate: null,
    createdAt: new Date("2026-11-01T10:00:00.000Z"),
    updatedAt: new Date("2026-11-01T10:00:00.000Z"),
    archivedAt: null,
  };

  describe("buildTaskSnapshot", () => {
    it("produces a canonical snapshot containing all 13 required fields with explicit nulls", () => {
      const snapshot = buildTaskSnapshot(mockTask);

      expect(snapshot).toEqual({
        id: "33333333-3333-3333-3333-333333333333",
        projectId: "11111111-1111-1111-1111-111111111111",
        columnId: "44444444-4444-4444-4444-444444444444",
        title: "Initial Title",
        description: "Initial secret description content",
        createdBy: "22222222-2222-2222-2222-222222222222",
        assigneeId: null,
        rankKey: "a0",
        version: 1,
        dueDate: null,
        createdAt: "2026-11-01T10:00:00.000Z",
        updatedAt: "2026-11-01T10:00:00.000Z",
        archivedAt: null,
      });

      // Assert validation against official Zod event schema
      expect(() => taskSnapshotSchema.parse(snapshot)).not.toThrow();
    });

    it("correctly serializes populated nullable fields and date strings", () => {
      const populatedTask: Task = {
        ...mockTask,
        assigneeId: "55555555-5555-5555-5555-555555555555",
        dueDate: "2026-12-31",
        archivedAt: new Date("2026-11-05T12:00:00.000Z"),
      };

      const snapshot = buildTaskSnapshot(populatedTask);

      expect(snapshot.assigneeId).toBe("55555555-5555-5555-5555-555555555555");
      expect(snapshot.dueDate).toBe("2026-12-31");
      expect(snapshot.archivedAt).toBe("2026-11-05T12:00:00.000Z");
      expect(() => taskSnapshotSchema.parse(snapshot)).not.toThrow();
    });
  });

  describe("buildTaskChanges", () => {
    it("returns an empty diff when before and after states are identical", () => {
      const changes = buildTaskChanges(mockTask, { ...mockTask });
      expect(changes).toEqual({});
      expect(() => taskChangesSchema.parse(changes)).not.toThrow();
    });

    it("records standard field changes with { from, to }", () => {
      const updatedTask: Task = {
        ...mockTask,
        title: "Updated Title",
        columnId: "77777777-7777-7777-7777-777777777777",
        rankKey: "a1",
      };

      const changes = buildTaskChanges(mockTask, updatedTask);

      expect(changes).toEqual({
        title: { from: "Initial Title", to: "Updated Title" },
        columnId: {
          from: "44444444-4444-4444-4444-444444444444",
          to: "77777777-7777-7777-7777-777777777777",
        },
        rankKey: { from: "a0", to: "a1" },
      });
      expect(() => taskChangesSchema.parse(changes)).not.toThrow();
    });

    it("strictly preserves description privacy: diff is { changed: true } without leaking text", () => {
      const updatedTask: Task = {
        ...mockTask,
        description: "New highly sensitive description body",
      };

      const changes = buildTaskChanges(mockTask, updatedTask);

      expect(changes).toEqual({
        description: { changed: true },
      });

      // Verify no description text exists anywhere in the diff
      const serialized = JSON.stringify(changes);
      expect(serialized).not.toContain("Initial secret description content");
      expect(serialized).not.toContain("New highly sensitive description body");
      expect(() => taskChangesSchema.parse(changes)).not.toThrow();
    });

    it("handles null-to-value and value-to-null changes correctly for nullable fields", () => {
      const taskWithAssignee: Task = {
        ...mockTask,
        assigneeId: "55555555-5555-5555-5555-555555555555",
        dueDate: "2026-12-15",
      };

      // 1. null to value
      const addChanges = buildTaskChanges(mockTask, taskWithAssignee);
      expect(addChanges).toEqual({
        assigneeId: { from: null, to: "55555555-5555-5555-5555-555555555555" },
        dueDate: { from: null, to: "2026-12-15" },
      });
      expect(() => taskChangesSchema.parse(addChanges)).not.toThrow();

      // 2. value to null
      const removeChanges = buildTaskChanges(taskWithAssignee, mockTask);
      expect(removeChanges).toEqual({
        assigneeId: { from: "55555555-5555-5555-5555-555555555555", to: null },
        dueDate: { from: "2026-12-15", to: null },
      });
      expect(() => taskChangesSchema.parse(removeChanges)).not.toThrow();
    });

    it("records archival and restoration state transitions", () => {
      const archivedTask: Task = {
        ...mockTask,
        archivedAt: new Date("2026-11-07T12:00:00.000Z"),
      };

      // Active -> Archived
      const archiveChanges = buildTaskChanges(mockTask, archivedTask);
      expect(archiveChanges).toEqual({
        archivedAt: { from: null, to: "2026-11-07T12:00:00.000Z" },
      });
      expect(() => taskChangesSchema.parse(archiveChanges)).not.toThrow();

      // Archived -> Active
      const restoreChanges = buildTaskChanges(archivedTask, mockTask);
      expect(restoreChanges).toEqual({
        archivedAt: { from: "2026-11-07T12:00:00.000Z", to: null },
      });
      expect(() => taskChangesSchema.parse(restoreChanges)).not.toThrow();
    });
  });

  describe("buildTaskCreatedChanges", () => {
    it("produces initial creation changes with { to } only and enforces description privacy", () => {
      const changes = buildTaskCreatedChanges(mockTask);

      expect(changes).toEqual({
        title: { to: "Initial Title" },
        columnId: { to: "44444444-4444-4444-4444-444444444444" },
        rankKey: { to: "a0" },
        description: { changed: true },
      });

      // Must NOT contain 'from'
      expect(JSON.stringify(changes)).not.toContain('"from"');
      // Must NOT leak description text
      expect(JSON.stringify(changes)).not.toContain("Initial secret description content");
      expect(() => taskChangesSchema.parse(changes)).not.toThrow();
    });

    it("includes optional assigneeId and dueDate if set on created task", () => {
      const populatedTask: Task = {
        ...mockTask,
        assigneeId: "55555555-5555-5555-5555-555555555555",
        dueDate: "2026-12-01",
      };

      const changes = buildTaskCreatedChanges(populatedTask);

      expect(changes.assigneeId).toEqual({ to: "55555555-5555-5555-5555-555555555555" });
      expect(changes.dueDate).toEqual({ to: "2026-12-01" });
      expect(() => taskChangesSchema.parse(changes)).not.toThrow();
    });
  });
});

