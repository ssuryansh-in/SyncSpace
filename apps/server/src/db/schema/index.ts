export * from "./custom-types.js";
export * from "./users.js";
export * from "./auth.js";
export * from "./workspaces.js";
export * from "./workspace-members.js";
export * from "./projects.js";
export * from "./project-columns.js";
export * from "./tasks.js";
export * from "./comments.js";
export * from "./project-events.js";
export * from "./idempotency-records.js";

// Singular aliases for Better Auth adapter compatibility
import { users } from "./users.js";
import { accounts, sessions, verifications } from "./auth.js";

export const user = users;
export const session = sessions;
export const account = accounts;
export const verification = verifications;
