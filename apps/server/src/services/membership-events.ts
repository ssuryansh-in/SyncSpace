import { sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { AppError } from "../errors/index.js";
import {
  MEMBERSHIP_CHANNEL,
  MAX_MEMBERSHIP_NOTIFICATION_BYTES,
  membershipChangeNotificationSchema,
  type MembershipChangeNotification,
} from "../schemas/membership-notification.js";

export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Emits a transactional PostgreSQL notification on the 'membership_changes' channel.
 *
 * Requirements:
 * 1. Must be executed within an active caller-owned Drizzle transaction (`tx`).
 *    Passing a standalone `Database` instance is rejected at compile time.
 * 2. Strictly validates payload against membershipChangeNotificationSchema.
 * 3. Enforces UTF-8 byte length < 8000 bytes before issuing SQL. Payloads with
 *    byte length >= 8000 are rejected immediately with AppError.internal.
 * 4. Buffers the notification inside the transaction: PostgreSQL delivers it
 *    only upon successful transaction commit; rolled-back transactions discard it.
 */
export async function emitMembershipNotification(
  tx: Transaction,
  payload: MembershipChangeNotification
): Promise<void> {
  const validated = membershipChangeNotificationSchema.parse(payload);
  const serialized = JSON.stringify(validated);

  const byteLength = Buffer.byteLength(serialized, "utf8");
  if (byteLength >= MAX_MEMBERSHIP_NOTIFICATION_BYTES) {
    throw AppError.internal(
      `Membership notification payload exceeds PostgreSQL ${MAX_MEMBERSHIP_NOTIFICATION_BYTES}-byte limit (${byteLength} bytes)`
    );
  }

  await tx.execute(
    sql`SELECT pg_notify(${MEMBERSHIP_CHANNEL}, ${serialized})`
  );
}
