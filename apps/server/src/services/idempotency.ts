import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { idempotencyRecords } from "../db/schema/index.js";
import { AppError } from "../errors/index.js";

/**
 * Computes a deterministic SHA-256 hash over HTTP method, resolved path, and canonicalized body.
 * Reference: docs/SPECIFICATION.md Section 7.5
 */
export function computeRequestHash(method: string, path: string, body: unknown): string {
  const canonicalBody = body !== undefined && body !== null ? JSON.stringify(sortKeys(body)) : "";
  return createHash("sha256")
    .update(`${method.toUpperCase()}:${path}:${canonicalBody}`)
    .digest("hex");
}

function sortKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return obj;
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((obj as Record<string, unknown>)[key]);
  }
  return sorted;
}

export interface IdempotencyCheckResult {
  replayed: boolean;
  status: number;
  body: unknown;
}

export class IdempotencyService {
  /**
   * Checks whether an idempotency record exists for (actorId, endpointKey, idempotencyKey).
   * - If found and requestHash matches: returns replayed response payload.
   * - If found and requestHash differs: throws 409 IDEMPOTENCY_KEY_REUSED.
   * - If not found: returns null.
   */
  static async check(
    dbOrTx: Database,
    {
      actorId,
      endpointKey,
      idempotencyKey,
      requestHash,
    }: {
      actorId: string;
      endpointKey: string;
      idempotencyKey: string;
      requestHash: string;
    }
  ): Promise<IdempotencyCheckResult | null> {
    const [record] = await dbOrTx
      .select()
      .from(idempotencyRecords)
      .where(
        and(
          eq(idempotencyRecords.actorId, actorId),
          eq(idempotencyRecords.endpointKey, endpointKey),
          eq(idempotencyRecords.idempotencyKey, idempotencyKey)
        )
      );

    if (!record) {
      return null;
    }

    if (record.requestHash !== requestHash) {
      throw AppError.conflict(
        "IDEMPOTENCY_KEY_REUSED",
        "This idempotency key was previously used with a different request payload."
      );
    }

    return {
      replayed: true,
      status: record.responseStatus,
      body: record.responseBody,
    };
  }

  /**
   * Persists an idempotency record in the same transaction as the mutation.
   */
  static async save(
    tx: Database,
    {
      actorId,
      endpointKey,
      idempotencyKey,
      requestHash,
      responseStatus,
      responseBody,
    }: {
      actorId: string;
      endpointKey: string;
      idempotencyKey: string;
      requestHash: string;
      responseStatus: number;
      responseBody: unknown;
    }
  ): Promise<void> {
    await tx.insert(idempotencyRecords).values({
      actorId,
      endpointKey,
      idempotencyKey,
      requestHash,
      responseStatus,
      responseBody,
    });
  }
}

