import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import {
  ConsoleMailSender,
  DisabledMailSender,
  MailSender,
  ResendMailSender,
} from './mail-sender.js';

@Global()
@Module({
  providers: [
    {
      provide: MailSender,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): MailSender => {
        const provider = config.get('EMAIL_PROVIDER', { infer: true });
        if (provider === 'off') return new DisabledMailSender();
        if (provider === 'resend') {
          // env validation guarantees both are set for the resend provider
          return new ResendMailSender(
            config.get('RESEND_API_KEY', { infer: true })!,
            config.get('EMAIL_FROM', { infer: true })!,
          );
        }
        return new ConsoleMailSender();
      },
    },
  ],
  exports: [MailSender],
})
export class MailModule {}
