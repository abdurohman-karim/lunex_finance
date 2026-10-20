import { ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { AuthController } from './auth.controller.js';

function controller(env: Partial<Env>) {
  const config = {
    get: (key: keyof Env) => env[key],
  } as unknown as ConfigService<Env, true>;
  // Only the configuration is needed for these routes.
  return new AuthController(null!, null!, null!, null!, null!, config);
}

const configured: Partial<Env> = {
  APPLE_CLIENT_IDS: ['uz.lunex.finance'],
  GOOGLE_CLIENT_IDS: [],
  TELEGRAM_BOT_TOKEN: undefined,
  PUBLIC_URL: 'https://api.lunex.my',
};

describe('AuthController without a mail service', () => {
  it('does not offer email sign-in when it is off', () => {
    expect(
      controller({ ...configured, EMAIL_PROVIDER: 'off' }).providers(),
    ).toEqual({ apple: true, google: false, telegram: false, email: false });
    expect(
      controller({ ...configured, EMAIL_PROVIDER: 'resend' }).providers().email,
    ).toBe(true);
  });

  it('refuses to send a code, as for any method that is off', async () => {
    await expect(
      controller({ ...configured, EMAIL_PROVIDER: 'off' }).emailStart(
        { email: 'beta@lunex.test' },
        '127.0.0.1',
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
