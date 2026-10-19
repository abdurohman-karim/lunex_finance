import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { normalizeEmail } from '../common/mask.js';
import { RateLimiter } from '../common/rate-limiter.service.js';
import type { Env } from '../config/env.js';
import { PrismaService } from '../database/prisma.service.js';
import type { LanguageCode } from '../generated/prisma/enums.js';
import { MailSender } from '../mail/mail-sender.js';
import { loginCodeEmail } from '../mail/templates.js';

export const EMAIL_CODE_TTL_SECONDS = 10 * 60;
export const EMAIL_CODE_RESEND_SECONDS = 60;
export const EMAIL_CODE_MAX_ATTEMPTS = 5;
export const EMAIL_CODES_PER_DAY = 10;

/** One-time 6-digit codes for passwordless email sign-in. */
@Injectable()
export class EmailCodeService {
  private readonly pepper: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly rateLimiter: RateLimiter,
    private readonly mail: MailSender,
    config: ConfigService<Env, true>,
  ) {
    this.pepper = config.get('AUTH_CODE_PEPPER', { infer: true });
  }

  hashCode(email: string, code: string): string {
    return createHmac('sha256', this.pepper)
      .update(`${email}:${code}`)
      .digest('hex');
  }

  async start(
    rawEmail: string,
    language: LanguageCode,
    now = new Date(),
  ): Promise<{ expiresIn: number; resendIn: number }> {
    const email = normalizeEmail(rawEmail);

    const last = await this.prisma.emailVerifications.findFirst({
      where: { email },
      orderBy: { created_at: 'desc' },
    });
    if (last) {
      const elapsed = (now.getTime() - last.created_at.getTime()) / 1000;
      if (elapsed < EMAIL_CODE_RESEND_SECONDS) {
        throw new HttpException(
          {
            code: 'resend_too_soon',
            message: 'Wait before requesting a new code',
            retryAfter: Math.ceil(EMAIL_CODE_RESEND_SECONDS - elapsed),
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
    await this.rateLimiter.consume(
      `email-code:${email}`,
      EMAIL_CODES_PER_DAY,
      24 * 60 * 60,
    );

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const verification = await this.prisma.emailVerifications.create({
      data: {
        email,
        code_hash: this.hashCode(email, code),
        expires_at: new Date(now.getTime() + EMAIL_CODE_TTL_SECONDS * 1000),
        created_at: now,
      },
    });
    try {
      await this.mail.send(loginCodeEmail(email, code, language));
    } catch (error) {
      // An unsent code must not block "resend" for a minute.
      await this.prisma.emailVerifications.delete({
        where: { id: verification.id },
      });
      throw error;
    }

    return {
      expiresIn: EMAIL_CODE_TTL_SECONDS,
      resendIn: EMAIL_CODE_RESEND_SECONDS,
    };
  }

  /** Consumes the latest active code for the email; returns the normalised email on success. */
  async verify(
    rawEmail: string,
    code: string,
    now = new Date(),
  ): Promise<string> {
    const email = normalizeEmail(rawEmail);
    const pending = await this.prisma.emailVerifications.findFirst({
      where: { email, verified_at: null, expires_at: { gt: now } },
      orderBy: { created_at: 'desc' },
    });
    if (!pending) {
      throw new BadRequestException({
        code: 'code_expired',
        message: 'No active code for this email; request a new one',
      });
    }
    if (pending.attempts >= EMAIL_CODE_MAX_ATTEMPTS) {
      throw new HttpException(
        {
          code: 'too_many_attempts',
          message: 'Too many wrong codes; request a new one',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const expected = Buffer.from(pending.code_hash, 'hex');
    const actual = Buffer.from(this.hashCode(email, code), 'hex');
    if (!timingSafeEqual(expected, actual)) {
      // Conditional increment: parallel guesses cannot exceed the attempt limit.
      await this.prisma.emailVerifications.updateMany({
        where: { id: pending.id, attempts: { lt: EMAIL_CODE_MAX_ATTEMPTS } },
        data: { attempts: { increment: 1 } },
      });
      throw new BadRequestException({
        code: 'invalid_code',
        message: 'The code is wrong',
        attemptsLeft: Math.max(
          0,
          EMAIL_CODE_MAX_ATTEMPTS - pending.attempts - 1,
        ),
      });
    }

    const { count } = await this.prisma.emailVerifications.updateMany({
      where: { id: pending.id, verified_at: null },
      data: { verified_at: now },
    });
    if (count === 0) {
      throw new BadRequestException({
        code: 'code_expired',
        message: 'The code was already used',
      });
    }
    return email;
  }
}
