import type { ConfigService } from '@nestjs/config';
import {
  createTestIdp,
  sha256Hex,
  type TestIdp,
} from '../../../test/support/oidc-keys.js';
import type { Env } from '../../config/env.js';
import { AppleVerifier } from './apple.verifier.js';
import { GoogleVerifier } from './google.verifier.js';

const APPLE_AUD = 'uz.lunex.test';
const GOOGLE_AUD = 'google-test-client';

function config(values: Partial<Env>): ConfigService<Env, true> {
  return {
    get: (key: keyof Env) => values[key],
  } as unknown as ConfigService<Env, true>;
}

describe('AppleVerifier', () => {
  let idp: TestIdp;
  let verifier: AppleVerifier;
  const nonce = 'a-random-nonce-1234567890';

  beforeAll(async () => {
    idp = await createTestIdp();
    verifier = new AppleVerifier(
      idp.keys,
      config({ APPLE_CLIENT_IDS: [APPLE_AUD] }),
    );
  });

  const token = (payload: Record<string, unknown>, audience = APPLE_AUD) =>
    idp.sign(
      { sub: 'apple-sub-1', nonce: sha256Hex(nonce), ...payload },
      { issuer: 'https://appleid.apple.com', audience },
    );

  it('accepts a valid token and reads the verified email', async () => {
    const identity = await verifier.verify(
      await token({ email: 'User@Example.com', email_verified: 'true' }),
      nonce,
      'Asadbek',
    );
    expect(identity).toEqual({
      provider: 'apple',
      subject: 'apple-sub-1',
      email: 'user@example.com',
      emailVerified: true,
      displayName: 'Asadbek',
    });
  });

  it('rejects a token whose nonce does not match', async () => {
    await expect(
      verifier.verify(await token({}), 'another-nonce-0987654321'),
    ).rejects.toThrow(/nonce/);
  });

  it('rejects a token for another app', async () => {
    await expect(
      verifier.verify(await token({}, 'com.someone.else'), nonce),
    ).rejects.toThrow(/invalid or expired/);
  });

  it('rejects a token from another issuer', async () => {
    const forged = await idp.sign(
      { sub: 'x', nonce: sha256Hex(nonce) },
      { issuer: 'https://evil.example', audience: APPLE_AUD },
    );
    await expect(verifier.verify(forged, nonce)).rejects.toThrow(
      /invalid or expired/,
    );
  });

  it('is disabled without configured client ids', async () => {
    const disabled = new AppleVerifier(
      idp.keys,
      config({ APPLE_CLIENT_IDS: [] }),
    );
    await expect(disabled.verify(await token({}), nonce)).rejects.toThrow(
      /not configured/,
    );
  });
});

describe('GoogleVerifier', () => {
  let idp: TestIdp;
  let verifier: GoogleVerifier;

  beforeAll(async () => {
    idp = await createTestIdp();
    verifier = new GoogleVerifier(
      idp.keys,
      config({ GOOGLE_CLIENT_IDS: [GOOGLE_AUD] }),
    );
  });

  it('accepts a valid token', async () => {
    const idToken = await idp.sign(
      {
        sub: 'google-1',
        email: 'a@gmail.com',
        email_verified: true,
        name: 'A B',
      },
      { issuer: 'https://accounts.google.com', audience: GOOGLE_AUD },
    );
    expect(await verifier.verify(idToken)).toEqual({
      provider: 'google',
      subject: 'google-1',
      email: 'a@gmail.com',
      emailVerified: true,
      displayName: 'A B',
    });
  });

  it('does not treat an unverified email as verified', async () => {
    const idToken = await idp.sign(
      { sub: 'google-2', email: 'b@gmail.com', email_verified: false },
      { issuer: 'accounts.google.com', audience: GOOGLE_AUD },
    );
    expect((await verifier.verify(idToken)).emailVerified).toBe(false);
  });

  it('rejects an expired token', async () => {
    const idToken = await idp.sign(
      { sub: 'google-3' },
      {
        issuer: 'https://accounts.google.com',
        audience: GOOGLE_AUD,
        expiresIn: '-5m',
      },
    );
    await expect(verifier.verify(idToken)).rejects.toThrow(
      /invalid or expired/,
    );
  });
});
