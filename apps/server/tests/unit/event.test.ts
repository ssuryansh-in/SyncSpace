import { describe, expect, it } from "vitest";
import {
  validateEventInput,
  EVENT_TYPES,
  ENTITY_TYPE_FOR_EVENT_TYPE,
  type AppendProjectEventInput,
} from "../../src/services/event.js";
import { AppError } from "../../src/errors/index.js";

const VALID_PROJECT_ID = "00000000-0000-0000-0000-000000000001";
const VALID_ACTOR_ID = "00000000-0000-0000-0000-000000000002";
const VALID_TASK_ID = "00000000-0000-0000-0000-000000000003";
const VALID_COLUMN_ID = "00000000-0000-0000-0000-000000000004";
const VALID_WORKSPACE_ID = "00000000-0000-0000-0000-000000000005";
const VALID_COMMENT_ID = "00000000-0000-0000-0000-000000000006";

function createValidTaskSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: VALID_TASK_ID,
    projectId: VALID_PROJECT_ID,
    columnId: VALID_COLUMN_ID,
    title: "Implement event infrastructure",
    description: "Write unit and integration tests",
    createdBy: VALID_ACTOR_ID,
    assigneeId: null,
    rankKey: "a0",
    version: 1,
    dueDate: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    archivedAt: null,
    ...overrides,
  };
}

function createValidProjectSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: VALID_PROJECT_ID,
    workspaceId: VALID_WORKSPACE_ID,
    name: "Core Platform",
    archivedAt: null,
    lastSeq: 0,
    createdBy: VALID_ACTOR_ID,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("Event Service — Zod Schema & Privacy Validation (Unit)", () => {
  describe("Valid Event Family Schemas", () => {
    it("validates task.created event with initial field changes", () => {
      const input: AppendProjectEventInput = {
        projectId: VALID_PROJECT_ID,
        actorId: VALID_ACTOR_ID,
        eventType: "task.created",
        entityType: "task",
        entityId: VALID_TASK_ID,
        payload: {
          task: createValidTaskSnapshot(),
          changes: {
            title: { to: "Implement event infrastructure" },
            columnId: { to: VALID_COLUMN_ID },
          },
        },
      };

      const result = validateEventInput(input);
      expect(result.eventType).toBe("task.created");
      expect(result.entityType).toBe("task");
    });

    it("validates task.updated event with field changes diff", () => {
      const input: AppendProjectEventInput = {
        projectId: VALID_PROJECT_ID,
        actorId: VALID_ACTOR_ID,
        eventType: "task.updated",
        entityType: "task",
        entityId: VALID_TASK_ID,
        payload: {
          task: createValidTaskSnapshot({ version: 2, title: "Updated Title" }),
          changes: {
            title: { from: "Old Title", to: "Updated Title" },
          },
        },
      };

      const result = validateEventInput(input);
      expect(result.eventType).toBe("task.updated");
    });

    it("validates task.moved event with column and rankKey changes", () => {
      const newColumnId = "00000000-0000-0000-0000-000000000099";
      const input: AppendProjectEventInput = {
        projectId: VALID_PROJECT_ID,
        actorId: VALID_ACTOR_ID,
        eventType: "task.moved",
        entityType: "task",
        entityId: VALID_TASK_ID,
        payload: {
          task: createValidTaskSnapshot({
            version: 2,
            columnId: newColumnId,
            rankKey: "a1",
          }),
          changes: {
            columnId: { from: VALID_COLUMN_ID, to: newColumnId },
            rankKey: { from: "a0", to: "a1" },
          },
        },
      };

      const result = validateEventInput(input);
      expect(result.eventType).toBe("task.moved");
    });

    it("validates task.archived event with archivedAt timestamp", () => {
      const archivedAt = new Date().toISOString();
      const input: AppendProjectEventInput = {
        projectId: VALID_PROJECT_ID,
        actorId: VALID_ACTOR_ID,
        eventType: "task.archived",
        entityType: "task",
        entityId: VALID_TASK_ID,
        payload: {
          task: createValidTaskSnapshot({ version: 2, archivedAt }),
          changes: {
            archivedAt: { from: null, to: archivedAt },
          },
        },
      };

      const result = validateEventInput(input);
      expect(result.eventType).toBe("task.archived");
    });

    it("validates task.restored event with cleared archivedAt", () => {
      const prevArchivedAt = new Date().toISOString();
      const input: AppendProjectEventInput = {
        projectId: VALID_PROJECT_ID,
        actorId: VALID_ACTOR_ID,
        eventType: "task.restored",
        entityType: "task",
        entityId: VALID_TASK_ID,
        payload: {
          task: createValidTaskSnapshot({ version: 3, archivedAt: null }),
          changes: {
            archivedAt: { from: prevArchivedAt, to: null },
          },
        },
      };

      const result = validateEventInput(input);
      expect(result.eventType).toBe("task.restored");
    });

    it("validates project.updated event with name change", () => {
      const input: AppendProjectEventInput = {
        projectId: VALID_PROJECT_ID,
        actorId: VALID_ACTOR_ID,
        eventType: "project.updated",
        entityType: "project",
        entityId: VALID_PROJECT_ID,
        payload: {
          project: createValidProjectSnapshot({ name: "Renamed Project" }),
          changes: {
            name: { from: "Core Platform", to: "Renamed Project" },
          },
        },
      };

      const result = validateEventInput(input);
      expect(result.eventType).toBe("project.updated");
    });

    it("validates project.archived and project.restored events", () => {
      const now = new Date().toISOString();
      const archiveInput: AppendProjectEventInput = {
        projectId: VALID_PROJECT_ID,
        actorId: VALID_ACTOR_ID,
        eventType: "project.archived",
        entityType: "project",
        entityId: VALID_PROJECT_ID,
        payload: {
          project: createValidProjectSnapshot({ archivedAt: now }),
          changes: {
            archivedAt: { from: null, to: now },
          },
        },
      };
      expect(validateEventInput(archiveInput).eventType).toBe("project.archived");

      const restoreInput: AppendProjectEventInput = {
        projectId: VALID_PROJECT_ID,
        actorId: VALID_ACTOR_ID,
        eventType: "project.restored",
        entityType: "project",
        entityId: VALID_PROJECT_ID,
        payload: {
          project: createValidProjectSnapshot({ archivedAt: null }),
          changes: {
            archivedAt: { from: now, to: null },
          },
        },
      };
      expect(validateEventInput(restoreInput).eventType).toBe("project.restored");
    });

    it("validates comment.created event containing metadata and IDs only", () => {
      const input: AppendProjectEventInput = {
        projectId: VALID_PROJECT_ID,
        actorId: VALID_ACTOR_ID,
        eventType: "comment.created",
        entityType: "comment",
        entityId: VALID_COMMENT_ID,
        payload: {
          commentId: VALID_COMMENT_ID,
          taskId: VALID_TASK_ID,
          authorId: VALID_ACTOR_ID,
          createdAt: new Date().toISOString(),
        },
      };

      const result = validateEventInput(input);
      expect(result.eventType).toBe("comment.created");
    });

    it("validates comment.deleted event containing metadata and IDs only", () => {
      const input: AppendProjectEventInput = {
        projectId: VALID_PROJECT_ID,
        actorId: VALID_ACTOR_ID,
        eventType: "comment.deleted",
        entityType: "comment",
        entityId: VALID_COMMENT_ID,
        payload: {
          commentId: VALID_COMMENT_ID,
          taskId: VALID_TASK_ID,
          authorId: VALID_ACTOR_ID,
          deletedAt: new Date().toISOString(),
        },
      };

      const result = validateEventInput(input);
      expect(result.eventType).toBe("comment.deleted");
    });

    it("validates column.rebalanced event with valid columnId and rankKeyMap", () => {
      const task2Id = "00000000-0000-0000-0000-000000000022";
      const input: AppendProjectEventInput = {
        projectId: VALID_PROJECT_ID,
        actorId: VALID_ACTOR_ID,
        eventType: "column.rebalanced",
        entityType: "column",
        entityId: VALID_COLUMN_ID,
        payload: {
          columnId: VALID_COLUMN_ID,
          rankKeyMap: {
            [VALID_TASK_ID]: "a0",
            [task2Id]: "a1",
          },
        },
      };

      const result = validateEventInput(input);
      expect(result.eventType).toBe("column.rebalanced");
      expect(result.entityType).toBe("column");
    });
  });

  describe("Task Snapshot & Nullable Field Invariants", () => {
    it("accepts task snapshot with all nullable fields set to null", () => {
      const input: AppendProjectEventInput = {
        projectId: VALID_PROJECT_ID,
        actorId: VALID_ACTOR_ID,
        eventType: "task.created",
        entityType: "task",
        entityId: VALID_TASK_ID,
        payload: {
          task: createValidTaskSnapshot({
            assigneeId: null,
            dueDate: null,
            archivedAt: null,
          }),
          changes: { title: { to: "Test" } },
        },
      };

      expect(() => validateEventInput(input)).not.toThrow();
    });

    it("accepts task snapshot with all nullable fields populated", () => {
      const assigneeId = "00000000-0000-0000-0000-000000000088";
      const input: AppendProjectEventInput = {
        projectId: VALID_PROJECT_ID,
        actorId: VALID_ACTOR_ID,
        eventType: "task.updated",
        entityType: "task",
        entityId: VALID_TASK_ID,
        payload: {
          task: createValidTaskSnapshot({
            assigneeId,
            dueDate: "2026-12-31",
            archivedAt: new Date().toISOString(),
          }),
          changes: { assigneeId: { from: null, to: assigneeId } },
        },
      };

      expect(() => validateEventInput(input)).not.toThrow();
    });

    it("rejects task snapshot missing required fields (e.g. title)", () => {
      const task = createValidTaskSnapshot();
      delete (task as any).title;

      const input: AppendProjectEventInput = {
        projectId: VALID_PROJECT_ID,
        actorId: VALID_ACTOR_ID,
        eventType: "task.created",
        entityType: "task",
        entityId: VALID_TASK_ID,
        payload: {
          task,
          changes: { title: { to: "Test" } },
        },
      };

      expect(() => validateEventInput(input)).toThrow(AppError);
    });

    it("rejects task snapshot with invalid version (non-positive)", () => {
      const input: AppendProjectEventInput = {
        projectId: VALID_PROJECT_ID,
        actorId: VALID_ACTOR_ID,
        eventType: "task.created",
        entityType: "task",
        entityId: VALID_TASK_ID,
        payload: {
          task: createValidTaskSnapshot({ version: 0 }),
          changes: { title: { to: "Test" } },
        },
      };

      expect(() => validateEventInput(input)).toThrow(AppError);
    });
  });

  describe("Privacy & Data Hygiene Invariants", () => {
    it("strictly rejects comment.created payloads that contain a comment body", () => {
      const input: AppendProjectEventInput = {
        projectId: VALID_PROJECT_ID,
        actorId: VALID_ACTOR_ID,
        eventType: "comment.created",
        entityType: "comment",
        entityId: VALID_COMMENT_ID,
        payload: {
          commentId: VALID_COMMENT_ID,
          taskId: VALID_TASK_ID,
          authorId: VALID_ACTOR_ID,
          createdAt: new Date().toISOString(),
          body: "Sensitive comment body that must not leak into events!",
        },
      };

      expect(() => validateEventInput(input)).toThrow(AppError);
      expect(() => validateEventInput(input)).toThrow(/Unrecognized key/);
    });

    it("strictly rejects comment.deleted payloads that contain a comment body", () => {
      const input: AppendProjectEventInput = {
        projectId: VALID_PROJECT_ID,
        actorId: VALID_ACTOR_ID,
        eventType: "comment.deleted",
        entityType: "comment",
        entityId: VALID_COMMENT_ID,
        payload: {
          commentId: VALID_COMMENT_ID,
          taskId: VALID_TASK_ID,
          authorId: VALID_ACTOR_ID,
          deletedAt: new Date().toISOString(),
          body: "Deleted comment text",
        },
      };

      expect(() => validateEventInput(input)).toThrow(AppError);
      expect(() => validateEventInput(input)).toThrow(/Unrecognized key/);
    });

    it("accepts task description changes matching { description: { changed: true } }", () => {
      const input: AppendProjectEventInput = {
        projectId: VALID_PROJECT_ID,
        actorId: VALID_ACTOR_ID,
        eventType: "task.updated",
        entityType: "task",
        entityId: VALID_TASK_ID,
        payload: {
          task: createValidTaskSnapshot({ description: "New description text" }),
          changes: {
            description: { changed: true },
          },
        },
      };

      expect(() => validateEventInput(input)).not.toThrow();
    });

    it("strictly rejects task description changes that include old or new description text", () => {
      const inputWithFromTo: AppendProjectEventInput = {
        projectId: VALID_PROJECT_ID,
        actorId: VALID_ACTOR_ID,
        eventType: "task.updated",
        entityType: "task",
        entityId: VALID_TASK_ID,
        payload: {
          task: createValidTaskSnapshot(),
          changes: {
            description: { from: "Old description", to: "New description" },
          },
        },
      };

      expect(() => validateEventInput(inputWithFromTo)).toThrow(AppError);
      expect(() => validateEventInput(inputWithFromTo)).toThrow(/Task description changes must strictly be/);

      const inputWithToOnly: AppendProjectEventInput = {
        projectId: VALID_PROJECT_ID,
        actorId: VALID_ACTOR_ID,
        eventType: "task.created",
        entityType: "task",
        entityId: VALID_TASK_ID,
        payload: {
          task: createValidTaskSnapshot(),
          changes: {
            description: { to: "Initial description" },
          },
        },
      };

      expect(() => validateEventInput(inputWithToOnly)).toThrow(AppError);
      expect(() => validateEventInput(inputWithToOnly)).toThrow(/Task description changes must strictly be/);
    });
  });

  describe("Entity-Type Agreement & Event Whitelist Enforcement", () => {
    it("strictly rejects entityType mismatches for task events", () => {
      const input: AppendProjectEventInput = {
        projectId: VALID_PROJECT_ID,
        actorId: VALID_ACTOR_ID,
        eventType: "task.created",
        entityType: "project", // Mismatch!
        entityId: VALID_TASK_ID,
        payload: {
          task: createValidTaskSnapshot(),
          changes: { title: { to: "Test" } },
        },
      };

      expect(() => validateEventInput(input)).toThrow(AppError);
      expect(() => validateEventInput(input)).toThrow(/Entity type mismatch/);
    });

    it("strictly rejects entityType mismatches for column.rebalanced", () => {
      const input: AppendProjectEventInput = {
        projectId: VALID_PROJECT_ID,
        actorId: VALID_ACTOR_ID,
        eventType: "column.rebalanced",
        entityType: "task", // Mismatch!
        entityId: VALID_COLUMN_ID,
        payload: {
          columnId: VALID_COLUMN_ID,
          rankKeyMap: { [VALID_TASK_ID]: "a0" },
        },
      };

      expect(() => validateEventInput(input)).toThrow(AppError);
      expect(() => validateEventInput(input)).toThrow(/Entity type mismatch/);
    });

    it("strictly rejects unsupported event type: project.created", () => {
      const input: AppendProjectEventInput = {
        projectId: VALID_PROJECT_ID,
        actorId: VALID_ACTOR_ID,
        eventType: "project.created",
        entityType: "project",
        entityId: VALID_PROJECT_ID,
        payload: {
          project: createValidProjectSnapshot(),
        },
      };

      expect(() => validateEventInput(input)).toThrow(AppError);
      expect(() => validateEventInput(input)).toThrow(/Invalid or unsupported event type/);
    });

    it("strictly rejects arbitrary or unknown event types", () => {
      const input: AppendProjectEventInput = {
        projectId: VALID_PROJECT_ID,
        actorId: VALID_ACTOR_ID,
        eventType: "workspace.deleted",
        entityType: "project",
        entityId: VALID_PROJECT_ID,
        payload: {},
      };

      expect(() => validateEventInput(input)).toThrow(AppError);
    });

    it("verifies all 11 canonical event types match their expected entity types", () => {
      for (const eventType of EVENT_TYPES) {
        const expectedEntity = ENTITY_TYPE_FOR_EVENT_TYPE[eventType];
        expect(expectedEntity).toBeDefined();
        if (eventType.startsWith("task.")) expect(expectedEntity).toBe("task");
        if (eventType.startsWith("project.")) expect(expectedEntity).toBe("project");
        if (eventType.startsWith("comment.")) expect(expectedEntity).toBe("comment");
        if (eventType === "column.rebalanced") expect(expectedEntity).toBe("column");
      }
    });
  });

  describe("UUID & Parameter Validation", () => {
    it("rejects invalid UUID format for projectId, actorId, or entityId", () => {
      const invalidProject: AppendProjectEventInput = {
        projectId: "not-a-uuid",
        actorId: VALID_ACTOR_ID,
        eventType: "task.created",
        entityType: "task",
        entityId: VALID_TASK_ID,
        payload: {
          task: createValidTaskSnapshot(),
          changes: { title: { to: "Test" } },
        },
      };
      expect(() => validateEventInput(invalidProject)).toThrow(AppError);

      const invalidActor: AppendProjectEventInput = {
        projectId: VALID_PROJECT_ID,
        actorId: "not-a-uuid",
        eventType: "task.created",
        entityType: "task",
        entityId: VALID_TASK_ID,
        payload: {
          task: createValidTaskSnapshot(),
          changes: { title: { to: "Test" } },
        },
      };
      expect(() => validateEventInput(invalidActor)).toThrow(AppError);

      const invalidEntity: AppendProjectEventInput = {
        projectId: VALID_PROJECT_ID,
        actorId: VALID_ACTOR_ID,
        eventType: "task.created",
        entityType: "task",
        entityId: "not-a-uuid",
        payload: {
          task: createValidTaskSnapshot(),
          changes: { title: { to: "Test" } },
        },
      };
      expect(() => validateEventInput(invalidEntity)).toThrow(AppError);
    });
  });
});

