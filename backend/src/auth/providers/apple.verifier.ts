import { createHash, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { JWTVerifyGetKey } from 'jose';
import { normalizeEmail } from '../../common/mask.js';
import type { Env } from '../../config/env.js';
import type { VerifiedIdentity } from '../auth.types.js';
import { APPLE_JWKS, isTrue, verifyIdToken } from './oidc.js';

/** Sign in with Apple: https://developer.apple.com/documentation/signinwithapple/authenticating-users-with-sign-in-with-apple */
@Injectable()
export class AppleVerifier {
  constructor(
    @Inject(APPLE_JWKS) private readonly keys: JWTVerifyGetKey,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async verify(
    identityToken: string,
    rawNonce: string,
    displayName?: string,
  ): Promise<VerifiedIdentity> {
    const payload = await verifyIdToken(identityToken, this.keys, {
      provider: 'Apple',
      issuer: 'https://appleid.apple.com',
      audiences: this.config.get('APPLE_CLIENT_IDS', { infer: true }),
    });

    // The app passes SHA-256(nonce) to Apple and the raw nonce to us: a replayed token fails here.
    const expected = createHash('sha256').update(rawNonce).digest('hex');
    const actual = typeof payload.nonce === 'string' ? payload.nonce : '';
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
    ) {
      throw new UnauthorizedException({
        code: 'invalid_nonce',
        message: 'Apple token nonce does not match',
      });
    }

    const email =
      typeof payload.email === 'string'
        ? normalizeEmail(payload.email)
        : undefined;
    return {
      provider: 'apple',
      subject: payload.sub,
      email,
      emailVerified: email !== undefined && isTrue(payload.email_verified),
      displayName: displayName || undefined,
    };
  }
}
