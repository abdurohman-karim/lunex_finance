import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.types.js';
import type { Access } from './entitlements.js';
import { EntitlementsService } from './entitlements.service.js';

@Controller('me/access')
export class AccessController {
  constructor(private readonly entitlements: EntitlementsService) {}

  /**
   * Plan, trial, features and limits. The app calls it on launch and on return from background,
   * so turning monetization on needs no app update.
   */
  @Get()
  access(@CurrentUser() user: AuthUser): Promise<Access> {
    return this.entitlements.getAccess(user.userId);
  }
}
