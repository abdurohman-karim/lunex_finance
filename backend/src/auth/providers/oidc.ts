import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { type JWTPayload, type JWTVerifyGetKey, jwtVerify } from 'jose';

export const APPLE_JWKS = Symbol('APPLE_JWKS');
export const GOOGLE_JWKS = Symbol('GOOGLE_JWKS');

export const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

/** Verifies an OpenID Connect ID token's signature, issuer, audience and expiry. */
export async function verifyIdToken(
  token: string,
  keys: JWTVerifyGetKey,
  options: { provider: string; issuer: string | string[]; audiences: string[] },
): Promise<JWTPayload & { sub: string }> {
  if (options.audiences.length === 0) {
    throw new ServiceUnavailableException({
      code: 'provider_disabled',
      message: `${options.provider} sign-in is not configured`,
    });
  }
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer: options.issuer,
      audience: options.audiences,
      algorithms: ['RS256'],
      clockTolerance: 30,
    });
    if (typeof payload.sub !== 'string' || payload.sub === '') {
      throw new Error('Missing sub');
    }
    return payload as JWTPayload & { sub: string };
  } catch {
    throw new UnauthorizedException({
      code: 'invalid_identity_token',
      message: `${options.provider} token is invalid or expired`,
    });
  }
}

/** Apple sends `email_verified` as a string, Google as a boolean. */
export function isTrue(value: unknown): boolean {
  return value === true || value === 'true';
}
