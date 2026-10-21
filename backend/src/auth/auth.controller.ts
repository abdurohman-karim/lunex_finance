import {
  Body,
  Controller,
  Get,
  HttpCode,
  Ip,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { z } from 'zod';
import { RateLimiter } from '../common/rate-limiter.service.js';
import type { Env } from '../config/env.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { UsersService, type SignInResult } from '../users/users.service.js';
import { Public } from './auth.decorators.js';
import {
  appleSignInSchema,
  emailSignInSchema,
  emailStartSchema,
  googleSignInSchema,
  type LinkIdentityInput,
  refreshSchema,
  telegramSignInSchema,
} from './auth.schemas.js';
import type { IssuedTokens } from './auth.types.js';
import { EmailCodeService } from './email-code.service.js';
import { IdentityService } from './identity.service.js';
import { TokensService } from './tokens.service.js';

/** Sign-in attempts per IP per 10 minutes, across all providers. */
const SIGN_IN_PER_IP = 60;
const EMAIL_CODES_PER_IP_PER_HOUR = 20;

type SignInBody = z.infer<
  | typeof appleSignInSchema
  | typeof googleSignInSchema
  | typeof telegramSignInSchema
  | typeof emailSignInSchema
>;

function toResponse(result: SignInResult) {
  return {
    user: result.user,
    isNewUser: result.isNewUser,
    ...result.tokens,
  };
}

@Public()
@Controller('auth')
export class AuthController {
  constructor(
    private readonly identities: IdentityService,
    private readonly users: UsersService,
    private readonly tokens: TokensService,
    private readonly emailCodes: EmailCodeService,
    private readonly rateLimiter: RateLimiter,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Which sign-in methods this server has configured, so the app does not offer a dead one. */
  @Get('providers')
  providers() {
    const telegramBot = this.config.get('TELEGRAM_BOT_TOKEN', { infer: true });
    const publicUrl = this.config.get('PUBLIC_URL', { infer: true });
    return {
      apple: this.config.get('APPLE_CLIENT_IDS', { infer: true }).length > 0,
      google: this.config.get('GOOGLE_CLIENT_IDS', { infer: true }).length > 0,
      telegram: Boolean(telegramBot && publicUrl),
      email: this.config.get('EMAIL_PROVIDER', { infer: true }) !== 'off',
    };
  }

  @Post('apple')
  @HttpCode(200)
  apple(
    @Body(new ZodValidationPipe(appleSignInSchema))
    body: z.infer<typeof appleSignInSchema>,
    @Ip() ip: string,
  ) {
    return this.signIn({ provider: 'apple', ...body }, body, ip);
  }

  @Post('google')
  @HttpCode(200)
  google(
    @Body(new ZodValidationPipe(googleSignInSchema))
    body: z.infer<typeof googleSignInSchema>,
    @Ip() ip: string,
  ) {
    return this.signIn({ provider: 'google', ...body }, body, ip);
  }

  @Post('telegram')
  @HttpCode(200)
  telegram(
    @Body(new ZodValidationPipe(telegramSignInSchema))
    body: z.infer<typeof telegramSignInSchema>,
    @Ip() ip: string,
  ) {
    return this.signIn({ provider: 'telegram', ...body }, body, ip);
  }

  /** Sends a 6-digit code; the app then calls /auth/email/verify. */
  @Post('email/start')
  @HttpCode(202)
  async emailStart(
    @Body(new ZodValidationPipe(emailStartSchema))
    body: z.infer<typeof emailStartSchema>,
    @Ip() ip: string,
  ) {
    if (this.config.get('EMAIL_PROVIDER', { infer: true }) === 'off') {
      throw new ServiceUnavailableException({
        code: 'provider_disabled',
        message: 'Email sign-in is not configured',
      });
    }
    await this.rateLimiter.consume(
      `email-start:ip:${ip}`,
      EMAIL_CODES_PER_IP_PER_HOUR,
      60 * 60,
    );
    return this.emailCodes.start(body.email, body.language ?? 'uz');
  }

  @Post('email/verify')
  @HttpCode(200)
  emailVerify(
    @Body(new ZodValidationPipe(emailSignInSchema))
    body: z.infer<typeof emailSignInSchema>,
    @Ip() ip: string,
  ) {
    return this.signIn({ provider: 'email', ...body }, body, ip);
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Body(new ZodValidationPipe(refreshSchema))
    body: z.infer<typeof refreshSchema>,
    @Ip() ip: string,
  ): Promise<IssuedTokens> {
    await this.rateLimiter.consume(`auth:ip:${ip}`, SIGN_IN_PER_IP, 10 * 60);
    return this.tokens.refresh(body.refreshToken);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(
    @Body(new ZodValidationPipe(refreshSchema))
    body: z.infer<typeof refreshSchema>,
  ): Promise<void> {
    await this.tokens.revoke(body.refreshToken);
  }

  private async signIn(
    credential: LinkIdentityInput,
    body: Pick<SignInBody, 'device' | 'language' | 'admin'>,
    ip: string,
  ) {
    await this.rateLimiter.consume(`auth:ip:${ip}`, SIGN_IN_PER_IP, 10 * 60);
    const identity = await this.identities.verify(credential);
    if (body.admin) {
      return toResponse(await this.users.signInAdmin(identity, body.device));
    }
    return toResponse(
      await this.users.signIn(identity, body.device, body.language),
    );
  }
}
