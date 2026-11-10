import { z } from "zod";

export const MEMBERSHIP_CHANNEL = "membership_changes" as const;
export const MAX_MEMBERSHIP_NOTIFICATION_BYTES = 8000;

export const membershipActionSchema = z.enum(["removed", "role_updated", "added"]);
export type MembershipAction = z.infer<typeof membershipActionSchema>;

export const membershipAffectedUserSchema = z
  .object({
    userId: z.string().uuid(),
    action: membershipActionSchema,
  })
  .strict();

export type MembershipAffectedUser = z.infer<typeof membershipAffectedUserSchema>;

/**
 * Shared membership change notification schema.
 * Preserves the approved M8.1 contract constraint of max 500 affected users.
 * Transport-level size safety is strictly governed by the UTF-8 byte length guard (< 8000 bytes).
 */
export const membershipChangeNotificationSchema = z
  .object({
    workspaceId: z.string().uuid(),
    affectedUsers: z.array(membershipAffectedUserSchema).min(1).max(500),
  })
  .strict();

export type MembershipChangeNotification = z.infer<
  typeof membershipChangeNotificationSchema
>;
