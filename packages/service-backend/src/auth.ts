import { ServiceBackendError } from "./errors.ts";
import { createId, createToken } from "./ids.ts";
import type { LocalFirstProjectStore } from "./store.ts";
import {
  SERVICE_BACKEND_SCHEMA_VERSION,
  type AuthSession,
  type UserAccount
} from "./types.ts";

export interface AuthServiceOptions {
  store: LocalFirstProjectStore;
}

/**
 * Stub signup/login for private beta. No password hashing or OAuth —
 * issues opaque session tokens against the local-first store.
 */
export class AuthService {
  #store: LocalFirstProjectStore;

  constructor(options: AuthServiceOptions) {
    this.#store = options.store;
  }

  signup(input: { email: string; displayName: string }): { user: UserAccount; session: AuthSession } {
    const email = input.email.trim().toLowerCase();
    if (!email || !email.includes("@")) {
      throw new ServiceBackendError("invalid email", "EINVALID");
    }
    if (this.#store.getUserByEmail(email)) {
      throw new ServiceBackendError("email already registered", "ECONFLICT");
    }
    const user: UserAccount = {
      schemaVersion: SERVICE_BACKEND_SCHEMA_VERSION,
      id: createId("user", this.#store.now),
      email,
      displayName: input.displayName.trim() || email,
      createdAt: this.#store.isoNow(),
      extensions: {}
    };
    this.#store.putUser(user);
    const session = this.#issueSession(user);
    return { user, session };
  }

  login(email: string): { user: UserAccount; session: AuthSession } {
    const user = this.#store.getUserByEmail(email.trim().toLowerCase());
    if (!user) {
      throw new ServiceBackendError("unknown user", "ENOTFOUND");
    }
    const session = this.#issueSession(user);
    return { user, session };
  }

  requireUser(sessionToken: string | null | undefined): UserAccount {
    if (!sessionToken) {
      throw new ServiceBackendError("authentication required", "EAUTH");
    }
    const session = this.#store.getSession(sessionToken);
    if (!session) {
      throw new ServiceBackendError("invalid session", "EAUTH");
    }
    const user = this.#store.getUser(session.userId);
    if (!user) {
      throw new ServiceBackendError("session user missing", "EAUTH");
    }
    return user;
  }

  #issueSession(user: UserAccount): AuthSession {
    const session: AuthSession = {
      userId: user.id,
      email: user.email,
      token: createToken(this.#store.now),
      createdAt: this.#store.isoNow()
    };
    this.#store.putSession(session);
    return session;
  }
}
