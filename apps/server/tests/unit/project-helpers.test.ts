import { describe, expect, it } from "vitest";
import {
  buildProjectSnapshot,
  buildProjectChanges,
} from "../../src/services/project.js";
import {
  projectSnapshotSchema,
  projectUpdatedPayloadSchema,
  projectArchivedPayloadSchema,
  projectRestoredPayloadSchema,
} from "../../src/services/event.js";
import type { Project } from "../../src/db/schema/index.js";

describe("Project Snapshot and Diff Helpers (Unit - Milestone 7.3)", () => {
  const mockProject: Project = {
    id: "11111111-1111-1111-1111-111111111111",
    workspaceId: "22222222-2222-2222-2222-222222222222",
    name: "Initial Project Name",
    createdBy: "33333333-3333-3333-3333-333333333333",
    archivedAt: null,
    lastSeq: 0,
    createdAt: new Date("2026-11-01T10:00:00.000Z"),
    updatedAt: new Date("2026-11-01T10:00:00.000Z"),
  };

  describe("buildProjectSnapshot", () => {
    it("produces a canonical snapshot containing all required fields with null archivedAt", () => {
      const snapshot = buildProjectSnapshot(mockProject);

      expect(snapshot).toEqual({
        id: "11111111-1111-1111-1111-111111111111",
        workspaceId: "22222222-2222-2222-2222-222222222222",
        name: "Initial Project Name",
        archivedAt: null,
        lastSeq: 0,
        createdBy: "33333333-3333-3333-3333-333333333333",
        createdAt: "2026-11-01T10:00:00.000Z",
        updatedAt: "2026-11-01T10:00:00.000Z",
      });

      // Assert validation against official Zod event schema
      expect(() => projectSnapshotSchema.parse(snapshot)).not.toThrow();
    });

    it("correctly serializes non-null archivedAt date", () => {
      const archivedProject: Project = {
        ...mockProject,
        archivedAt: new Date("2026-11-05T14:30:00.000Z"),
      };

      const snapshot = buildProjectSnapshot(archivedProject);

      expect(snapshot.archivedAt).toBe("2026-11-05T14:30:00.000Z");
      expect(() => projectSnapshotSchema.parse(snapshot)).not.toThrow();
    });

    it("respects overrideLastSeq and overrideUpdatedAt parameters", () => {
      const overrideSeq = 5;
      const overrideTime = new Date("2026-11-08T12:00:00.000Z");

      const snapshot = buildProjectSnapshot(mockProject, overrideSeq, overrideTime);

      expect(snapshot.lastSeq).toBe(5);
      expect(snapshot.updatedAt).toBe("2026-11-08T12:00:00.000Z");
      expect(() => projectSnapshotSchema.parse(snapshot)).not.toThrow();
    });
  });

  describe("buildProjectChanges", () => {
    it("returns an empty diff when before and after states are identical", () => {
      const changes = buildProjectChanges(mockProject, { ...mockProject });
      expect(changes).toEqual({});
    });

    it("records project rename diff with { name: { from, to } }", () => {
      const updatedProject: Project = {
        ...mockProject,
        name: "Updated Project Name",
      };

      const changes = buildProjectChanges(mockProject, updatedProject);

      expect(changes).toEqual({
        name: {
          from: "Initial Project Name",
          to: "Updated Project Name",
        },
      });

      const snapshot = buildProjectSnapshot(updatedProject, 1);
      expect(() =>
        projectUpdatedPayloadSchema.parse({
          project: snapshot,
          changes,
        })
      ).not.toThrow();
    });

    it("records project archive diff with { archivedAt: { from: null, to: ISO } }", () => {
      const archiveTime = new Date("2026-11-08T12:00:00.000Z");
      const archivedProject: Project = {
        ...mockProject,
        archivedAt: archiveTime,
      };

      const changes = buildProjectChanges(mockProject, archivedProject);

      expect(changes).toEqual({
        archivedAt: {
          from: null,
          to: "2026-11-08T12:00:00.000Z",
        },
      });

      const snapshot = buildProjectSnapshot(archivedProject, 1, archiveTime);
      expect(() =>
        projectArchivedPayloadSchema.parse({
          project: snapshot,
          changes,
        })
      ).not.toThrow();
    });

    it("records project restore diff with { archivedAt: { from: ISO, to: null } }", () => {
      const archiveTime = new Date("2026-11-05T10:00:00.000Z");
      const archivedProject: Project = {
        ...mockProject,
        archivedAt: archiveTime,
      };
      const restoredProject: Project = {
        ...mockProject,
        archivedAt: null,
      };

      const changes = buildProjectChanges(archivedProject, restoredProject);

      expect(changes).toEqual({
        archivedAt: {
          from: "2026-11-05T10:00:00.000Z",
          to: null,
        },
      });

      const restoreTime = new Date("2026-11-08T12:00:00.000Z");
      const snapshot = buildProjectSnapshot(restoredProject, 2, restoreTime);
      expect(() =>
        projectRestoredPayloadSchema.parse({
          project: snapshot,
          changes,
        })
      ).not.toThrow();
    });
  });
});

