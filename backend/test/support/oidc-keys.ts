import { createHash } from 'node:crypto';
import {
  type JWTPayload,
  type JWTVerifyGetKey,
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
} from 'jose';

/** A local RSA key set standing in for Apple's and Google's JWKS in tests. */
export interface TestIdp {
  keys: JWTVerifyGetKey;
  sign(
    payload: JWTPayload,
    options: { issuer: string; audience: string; expiresIn?: string },
  ): Promise<string>;
}

export async function createTestIdp(): Promise<TestIdp> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = {
    ...(await exportJWK(publicKey)),
    kid: 'test-key',
    alg: 'RS256',
  };
  return {
    keys: createLocalJWKSet({ keys: [jwk] }),
    sign: (payload, options) =>
      new SignJWT(payload)
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer(options.issuer)
        .setAudience(options.audience)
        .setIssuedAt()
        .setExpirationTime(options.expiresIn ?? '10m')
        .sign(privateKey),
  };
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
