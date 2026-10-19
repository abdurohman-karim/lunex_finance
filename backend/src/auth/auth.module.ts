import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { createRemoteJWKSet } from 'jose';
import { MeController } from '../users/me.controller.js';
import { UsersService } from '../users/users.service.js';
import { AuthController } from './auth.controller.js';
import { EmailCodeService } from './email-code.service.js';
import { IdentityService } from './identity.service.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { AppleVerifier } from './providers/apple.verifier.js';
import { GoogleVerifier } from './providers/google.verifier.js';
import {
  APPLE_JWKS,
  APPLE_JWKS_URL,
  GOOGLE_JWKS,
  GOOGLE_JWKS_URL,
} from './providers/oidc.js';
import { TelegramVerifier } from './providers/telegram.verifier.js';
import { TokensService } from './tokens.service.js';

@Module({
  controllers: [AuthController, MeController],
  providers: [
    // Remote key sets are fetched lazily and cached; tests override these tokens with local keys.
    {
      provide: APPLE_JWKS,
      useFactory: () => createRemoteJWKSet(new URL(APPLE_JWKS_URL)),
    },
    {
      provide: GOOGLE_JWKS,
      useFactory: () => createRemoteJWKSet(new URL(GOOGLE_JWKS_URL)),
    },
    AppleVerifier,
    GoogleVerifier,
    TelegramVerifier,
    EmailCodeService,
    IdentityService,
    TokensService,
    UsersService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  exports: [TokensService, UsersService],
})
export class AuthModule {}
