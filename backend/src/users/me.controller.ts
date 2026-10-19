import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import type { z } from 'zod';
import { CurrentUser } from '../auth/auth.decorators.js';
import {
  linkIdentitySchema,
  providerParamSchema,
} from '../auth/auth.schemas.js';
import type { AuthUser } from '../auth/auth.types.js';
import { IdentityService } from '../auth/identity.service.js';
import { TokensService } from '../auth/tokens.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { type Profile, UsersService } from './users.service.js';

@Controller('me')
export class MeController {
  constructor(
    private readonly users: UsersService,
    private readonly identities: IdentityService,
    private readonly tokens: TokensService,
  ) {}

  @Get()
  me(@CurrentUser() user: AuthUser): Promise<Profile> {
    return this.users.profile(user.userId);
  }

  /** Deletes the account; signing in again within 30 days restores it. */
  @Delete()
  @HttpCode(204)
  async deleteAccount(@CurrentUser() user: AuthUser): Promise<void> {
    await this.users.deleteAccount(user.userId);
  }

  /** "Sign out on all devices" */
  @Delete('sessions')
  @HttpCode(204)
  async logoutEverywhere(@CurrentUser() user: AuthUser): Promise<void> {
    await this.tokens.revokeAllForUser(user.userId);
  }

  @Post('identities')
  @HttpCode(200)
  async link(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(linkIdentitySchema))
    body: z.infer<typeof linkIdentitySchema>,
  ): Promise<Profile> {
    const identity = await this.identities.verify(body);
    return this.users.linkIdentity(user.userId, identity);
  }

  @Delete('identities/:provider')
  unlink(
    @CurrentUser() user: AuthUser,
    @Param('provider', new ZodValidationPipe(providerParamSchema))
    provider: z.infer<typeof providerParamSchema>,
  ): Promise<Profile> {
    return this.users.unlinkIdentity(user.userId, provider);
  }
}
