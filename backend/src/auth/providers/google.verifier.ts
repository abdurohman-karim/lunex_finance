import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { JWTVerifyGetKey } from 'jose';
import { normalizeEmail } from '../../common/mask.js';
import type { Env } from '../../config/env.js';
import type { VerifiedIdentity } from '../auth.types.js';
import { GOOGLE_JWKS, isTrue, verifyIdToken } from './oidc.js';

/** Google Sign-In ID token: https://developers.google.com/identity/sign-in/ios/backend-auth */
@Injectable()
export class GoogleVerifier {
  constructor(
    @Inject(GOOGLE_JWKS) private readonly keys: JWTVerifyGetKey,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async verify(idToken: string): Promise<VerifiedIdentity> {
    const payload = await verifyIdToken(idToken, this.keys, {
      provider: 'Google',
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audiences: this.config.get('GOOGLE_CLIENT_IDS', { infer: true }),
    });

    const email =
      typeof payload.email === 'string'
        ? normalizeEmail(payload.email)
        : undefined;
    return {
      provider: 'google',
      subject: payload.sub,
      email,
      emailVerified: email !== undefined && isTrue(payload.email_verified),
      displayName: typeof payload.name === 'string' ? payload.name : undefined,
    };
  }
}
