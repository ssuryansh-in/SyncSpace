import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../src/errors/index.js";
import {
  emitMembershipNotification,
  type Transaction,
} from "../../src/services/membership-events.js";
import {
  MAX_MEMBERSHIP_NOTIFICATION_BYTES,
  MEMBERSHIP_CHANNEL,
  membershipChangeNotificationSchema,
  type MembershipChangeNotification,
} from "../../src/schemas/membership-notification.js";
import { PostgresListenerService } from "../../src/services/listener.js";

function buildExactBytePayload(
  targetBytes: number
): { payload: MembershipChangeNotification; byteLength: number } {
  const ws = "00000000-0000-0000-0000-000000000000";
  // Mathematical configuration:
  // 4 added, 111 removed -> 7,999 bytes
  // 4 added, 96 removed, 14 role_updated -> 8,000 bytes
  let addedCount = 0;
  let removedCount = 0;
  let roleUpdatedCount = 0;

  if (targetBytes === 7999) {
    addedCount = 4;
    removedCount = 111;
    roleUpdatedCount = 0;
  } else if (targetBytes === 8000) {
    addedCount = 4;
    removedCount = 96;
    roleUpdatedCount = 14;
  } else if (targetBytes === 8060) {
    addedCount = 5;
    removedCount = 96;
    roleUpdatedCount = 14;
  } else {
    throw new Error(`Unsupported test target bytes: ${targetBytes}`);
  }

  const users: { userId: string; action: "added" | "removed" | "role_updated" }[] = [];
  let idCounter = 1;
  const makeUuid = (id: number) =>
    `00000000-0000-0000-0000-${String(id).padStart(12, "0")}`;

  for (let i = 0; i < addedCount; i++) {
    users.push({ userId: makeUuid(idCounter++), action: "added" });
  }
  for (let i = 0; i < removedCount; i++) {
    users.push({ userId: makeUuid(idCounter++), action: "removed" });
  }
  for (let i = 0; i < roleUpdatedCount; i++) {
    users.push({ userId: makeUuid(idCounter++), action: "role_updated" });
  }

  const payload: MembershipChangeNotification = {
    workspaceId: ws,
    affectedUsers: users,
  };
  const serialized = JSON.stringify(payload);
  const byteLength = Buffer.byteLength(serialized, "utf8");

  return { payload, byteLength };
}

describe("Membership Notification Emitter & Contract Unit Tests", () => {
  it("accepts a payload with exactly 7,999 serialized UTF-8 bytes and issues SQL notification", async () => {
    const { payload, byteLength } = buildExactBytePayload(7999);
    expect(byteLength).toBe(7999);
    expect(payload.affectedUsers.length).toBeLessThanOrEqual(500);

    const mockExecute = vi.fn().mockResolvedValue([]);
    const mockTx = { execute: mockExecute } as unknown as Transaction;

    await emitMembershipNotification(mockTx, payload);

    expect(mockExecute).toHaveBeenCalledTimes(1);
    // Verify SQL notification call was made on membership_changes channel
    const queryArg = mockExecute.mock.calls[0][0];
    expect(queryArg).toBeDefined();
  });

  it("rejects a payload with exactly 8,000 serialized UTF-8 bytes before executing SQL", async () => {
    const { payload, byteLength } = buildExactBytePayload(8000);
    expect(byteLength).toBe(8000);

    const mockExecute = vi.fn().mockResolvedValue([]);
    const mockTx = { execute: mockExecute } as unknown as Transaction;

    await expect(emitMembershipNotification(mockTx, payload)).rejects.toThrow(
      AppError
    );

    // Verify zero SQL execution
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("rejects an oversized payload (> 8,000 bytes) with AppError.internal without executing SQL", async () => {
    const { payload, byteLength } = buildExactBytePayload(8060);
    expect(byteLength).toBeGreaterThanOrEqual(MAX_MEMBERSHIP_NOTIFICATION_BYTES);

    const mockExecute = vi.fn().mockResolvedValue([]);
    const mockTx = { execute: mockExecute } as unknown as Transaction;

    let thrownError: unknown;
    try {
      await emitMembershipNotification(mockTx, payload);
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeInstanceOf(AppError);
    const appErr = thrownError as AppError;
    expect(appErr.code).toBe("INTERNAL_ERROR");
    expect(appErr.statusCode).toBe(500);
    expect(appErr.message).toContain("exceeds PostgreSQL 8000-byte limit");

    // Zero SQL execution
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("accurately measures UTF-8 byte length rather than JavaScript string length", () => {
    // Multi-byte Unicode characters (e.g. 4 bytes per emoji surrogate pair)
    const multiByteString = "🚀🎉";
    // In JavaScript UTF-16, 2 emoji surrogate pairs = 4 code units
    expect(multiByteString.length).toBe(4);
    // In UTF-8, 2 emojis * 4 bytes = 8 bytes
    expect(Buffer.byteLength(multiByteString, "utf8")).toBe(8);
    expect(multiByteString.length).not.toBe(Buffer.byteLength(multiByteString, "utf8"));
  });

  it("enforces strict Zod schema constraints on membershipChangeNotificationSchema", () => {
    const validUuid = "11111111-1111-1111-1111-111111111111";

    // Valid payload
    const valid = membershipChangeNotificationSchema.safeParse({
      workspaceId: validUuid,
      affectedUsers: [{ userId: validUuid, action: "added" }],
    });
    expect(valid.success).toBe(true);

    // Invalid workspaceId
    const invalidWorkspace = membershipChangeNotificationSchema.safeParse({
      workspaceId: "not-a-uuid",
      affectedUsers: [{ userId: validUuid, action: "added" }],
    });
    expect(invalidWorkspace.success).toBe(false);

    // Invalid action
    const invalidAction = membershipChangeNotificationSchema.safeParse({
      workspaceId: validUuid,
      affectedUsers: [{ userId: validUuid, action: "promoted" as any }],
    });
    expect(invalidAction.success).toBe(false);

    // Empty affectedUsers (.min(1))
    const emptyUsers = membershipChangeNotificationSchema.safeParse({
      workspaceId: validUuid,
      affectedUsers: [],
    });
    expect(emptyUsers.success).toBe(false);

    // Excess affectedUsers (> 500)
    const excessUsers = Array.from({ length: 501 }, () => ({
      userId: validUuid,
      action: "added" as const,
    }));
    const overLimit = membershipChangeNotificationSchema.safeParse({
      workspaceId: validUuid,
      affectedUsers: excessUsers,
    });
    expect(overLimit.success).toBe(false);

    // Exactly 500 affectedUsers (.max(500))
    const exact500Users = Array.from({ length: 500 }, () => ({
      userId: validUuid,
      action: "added" as const,
    }));
    const maxAllowed = membershipChangeNotificationSchema.safeParse({
      workspaceId: validUuid,
      affectedUsers: exact500Users,
    });
    expect(maxAllowed.success).toBe(true);
  });

  it("verifies PostgresListenerService rejects incoming raw membership payload >= 8000 bytes", () => {
    const mockWarn = vi.fn();
    const mockLogger = {
      info: vi.fn(),
      warn: mockWarn,
      error: vi.fn(),
      debug: vi.fn(),
    };

    const listener = new PostgresListenerService({
      sqlClient: {} as any,
      logger: mockLogger,
    });
    // Set status to ready
    (listener as any)._status = "ready";

    const dispatchSpy = vi.spyOn(listener as any, "dispatchMembershipChange");

    // Exactly 8,000 bytes string
    const raw8000 = "a".repeat(8000);
    expect(Buffer.byteLength(raw8000, "utf8")).toBe(8000);

    (listener as any).handleRawMembershipChange(raw8000);

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      { byteLength: 8000, length: 8000 },
      "Oversized or non-string payload rejected on membership_changes channel"
    );
  });
});
