import { Module } from '@nestjs/common';
import { AiUsageService } from './ai-usage.service.js';
import { AiController } from './ai.controller.js';
import { AiService } from './ai.service.js';
import { ClaudeClient } from './claude.client.js';

/** Claude API with per-user daily limits and usage accounting (`ai_usage_daily`). */
@Module({
  controllers: [AiController],
  providers: [AiUsageService, AiService, ClaudeClient],
  exports: [AiService, AiUsageService],
})
export class AiModule {}
