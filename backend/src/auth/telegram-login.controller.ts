import { createHash } from 'node:crypto';
import {
  Controller,
  Get,
  Header,
  Query,
  Redirect,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { API_PREFIX } from '../app.setup.js';
import type { Env } from '../config/env.js';
import { Public } from './auth.decorators.js';

/** The app's ASWebAuthenticationSession waits for this scheme and reads the result from it. */
export const TELEGRAM_APP_CALLBACK = 'lunex://auth/telegram';

/** The admin panel, when the sign-in started there (`?to=admin`). */
export const TELEGRAM_ADMIN_CALLBACK = '/admin/';

// Telegram returns the login data in the URL fragment (#tgAuthResult=…), which never
// reaches the server, so the callback page forwards it as is: to the app, or to the panel.
const CALLBACK_SCRIPT = `location.replace(new URLSearchParams(location.search).get('to') === 'admin' ? ${JSON.stringify(TELEGRAM_ADMIN_CALLBACK)} + location.hash : ${JSON.stringify(TELEGRAM_APP_CALLBACK)} + location.search + location.hash);`;
export const TELEGRAM_CALLBACK_SCRIPT_HASH = createHash('sha256')
  .update(CALLBACK_SCRIPT)
  .digest('base64');
const CALLBACK_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Lunex</title></head><body><script>${CALLBACK_SCRIPT}</script></body></html>`;

/**
 * Telegram Login for the app: Telegram only redirects to the bot's domain (set in @BotFather
 * to the host of `PUBLIC_URL`), so the app goes through these two pages:
 * start → oauth.telegram.org → callback → lunex://auth/telegram#tgAuthResult=…,
 * then posts the decoded data to `POST /v1/auth/telegram`. The admin panel starts with
 * `?to=admin` and gets the data back at /admin/#tgAuthResult=….
 */
@Public()
@Controller('auth/telegram')
export class TelegramLoginController {
  constructor(private readonly config: ConfigService<Env, true>) {}

  @Get('start')
  @Redirect()
  start(@Query('to') to?: string) {
    const token = this.config.get('TELEGRAM_BOT_TOKEN', { infer: true });
    const publicUrl = this.config.get('PUBLIC_URL', { infer: true });
    if (!token || !publicUrl) {
      throw new ServiceUnavailableException({
        code: 'provider_disabled',
        message: 'Telegram sign-in is not configured',
      });
    }
    const origin = new URL(publicUrl).origin;
    const url = new URL('https://oauth.telegram.org/auth');
    // The bot id is the token's public part before the colon.
    url.searchParams.set('bot_id', token.split(':')[0]);
    url.searchParams.set('origin', origin);
    url.searchParams.set('request_access', 'write');
    url.searchParams.set(
      'return_to',
      `${origin}/${API_PREFIX}/auth/telegram/callback${to === 'admin' ? '?to=admin' : ''}`,
    );
    return { url: url.toString(), statusCode: 302 };
  }

  @Get('callback')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  // Only this one inline script may run on the page.
  @Header(
    'Content-Security-Policy',
    `default-src 'none'; script-src 'sha256-${TELEGRAM_CALLBACK_SCRIPT_HASH}'`,
  )
  callback(): string {
    return CALLBACK_PAGE;
  }
}
