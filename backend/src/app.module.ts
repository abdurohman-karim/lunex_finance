import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { SentryGlobalFilter, SentryModule } from '@sentry/nestjs/setup';
import { LoggerModule } from 'nestjs-pino';
import { AuthModule } from './auth/auth.module.js';
import { AiModule } from './ai/ai.module.js';
import { InputModule } from './input/input.module.js';
import { InsightsModule } from './insights/insights.module.js';
import { AutoSaveModule } from './auto-save/auto-save.module.js';
import { BillingModule } from './billing/billing.module.js';
import { BudgetModule } from './budget/budget.module.js';
import { CommonModule } from './common/common.module.js';
import { type Env, validateEnv } from './config/env.js';
import { DatabaseModule } from './database/database.module.js';
import { FinanceModule } from './finance/finance.module.js';
import { GoalsModule } from './goals/goals.module.js';
import { HealthModule } from './health/health.module.js';
import { MailModule } from './mail/mail.module.js';
import { ProfileModule } from './profile/profile.module.js';
import { QueueModule } from './queue/queue.module.js';
import { RedisModule } from './redis/redis.module.js';
import { SmartSaveModule } from './smart-save/smart-save.module.js';
import { SyncModule } from './sync/sync.module.js';

@Module({
  imports: [
    SentryModule.forRoot(),
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL', { infer: true }),
          transport:
            config.get('NODE_ENV', { infer: true }) === 'development'
              ? { target: 'pino-pretty', options: { singleLine: true } }
              : undefined,
          // Tokens, cookies and login codes never reach the logs.
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'res.headers["set-cookie"]',
            ],
            censor: '[redacted]',
          },
          autoLogging: {
            ignore: (req) => req.url?.startsWith('/health') ?? false,
          },
        },
      }),
    }),
    DatabaseModule,
    RedisModule,
    CommonModule,
    MailModule,
    AuthModule,
    BillingModule,
    FinanceModule,
    BudgetModule,
    GoalsModule,
    AutoSaveModule,
    AiModule,
    InsightsModule,
    InputModule,
    SmartSaveModule,
    ProfileModule,
    SyncModule,
    QueueModule,
    HealthModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: SentryGlobalFilter }],
})
export class AppModule {}
