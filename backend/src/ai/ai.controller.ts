import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.types.js';
import { AiUsageService, type UsageStatus } from './ai-usage.service.js';
import { AiService } from './ai.service.js';

/** Today's AI requests against the limits: the assistant shows «осталось N». */
@Controller('ai')
export class AiController {
  constructor(
    private readonly usage: AiUsageService,
    private readonly ai: AiService,
  ) {}

  @Get('usage')
  async status(
    @CurrentUser() user: AuthUser,
  ): Promise<UsageStatus & { available: boolean }> {
    return {
      available: this.ai.available,
      ...(await this.usage.status(user.userId)),
    };
  }
}
