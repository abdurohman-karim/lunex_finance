import type { AuthProvider, UserRole } from '../generated/prisma/enums.js';

/** Who an external provider (or a verified email code) says the person is. */
export interface VerifiedIdentity {
  provider: AuthProvider;
  /** Apple/Google `sub`, Telegram user id, or the normalised email */
  subject: string;
  email?: string;
  /** Only a verified email may link a new sign-in method to an existing account */
  emailVerified: boolean;
  displayName?: string;
}

/** Attached to the request by JwtAuthGuard. */
export interface AuthUser {
  userId: string;
  role: UserRole;
  deviceId: string;
}

export interface IssuedTokens {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}
