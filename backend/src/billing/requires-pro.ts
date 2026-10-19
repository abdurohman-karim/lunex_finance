import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UseGuards,
  applyDecorators,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedRequest } from '../auth/auth.decorators.js';
import type { ProFeature } from './entitlements.js';
import { EntitlementsService } from './entitlements.service.js';

const PRO_FEATURE = 'proFeature';

@Injectable()
export class ProFeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly entitlements: EntitlementsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const feature = this.reflector.getAllAndOverride<ProFeature | undefined>(
      PRO_FEATURE,
      [context.getHandler(), context.getClass()],
    );
    if (!feature) {
      return true;
    }
    const { user } = context.switchToHttp().getRequest<AuthenticatedRequest>();
    await this.entitlements.assertFeature(user.userId, feature);
    return true;
  }
}

/** `@RequiresPro('auto_save')` — 403 `pro_required` on Free; open to everyone while monetization is off. */
export const RequiresPro = (feature: ProFeature) =>
  applyDecorators(
    SetMetadata(PRO_FEATURE, feature),
    UseGuards(ProFeatureGuard),
  );
