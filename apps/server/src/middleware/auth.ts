import type { Context, Next } from "hono";
import type { Auth } from "../auth/index.js";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  image?: string | null | undefined;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthSession {
  id: string;
  userId: string;
  token: string;
  expiresAt: Date;
}

// Augment Hono's ContextVariableMap so c.get("user") and c.get("session") are strictly typed
declare module "hono" {
  interface ContextVariableMap {
    user: AuthUser;
    session: AuthSession;
  }
}

/**
 * Creates authentication middleware using Better Auth.
 * Rejects unauthenticated requests with standard 401 UNAUTHENTICATED error.
 */
export function createRequireAuth(auth: Auth) {
  return async function requireAuth(c: Context, next: Next) {
    const sessionData = await auth.api.getSession({
      headers: c.req.raw.headers,
    });

    if (!sessionData?.user) {
      return c.json(
        {
          error: {
            code: "UNAUTHENTICATED",
            message: "Authentication required",
          },
        },
        401
      );
    }

    c.set("user", sessionData.user as unknown as AuthUser);
    c.set("session", sessionData.session as unknown as AuthSession);
    await next();
  };
}
