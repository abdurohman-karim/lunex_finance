import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { AiFeature } from '../generated/prisma/enums.js';
import { AiUsageService } from './ai-usage.service.js';
import {
  ClaudeClient,
  type ClaudeReply,
  type ClaudeRequest,
  ClaudeUnavailableError,
} from './claude.client.js';

/**
 * Every call to the model goes through here: Pro and the day's limit first, then Claude,
 * then the tokens into `ai_usage_daily`. A failed call is not counted, and the app gets
 * `ai_unavailable` (503, AI is off) or `ai_failed` (502, «Повторить»).
 */
@Injectable()
export class AiService {
  constructor(
    private readonly usage: AiUsageService,
    private readonly claude: ClaudeClient,
  ) {}

  get available(): boolean {
    return this.claude.available;
  }

  async ask(
    userId: string,
    feature: AiFeature,
    request: ClaudeRequest,
    now = new Date(),
  ): Promise<ClaudeReply> {
    if (!this.claude.available) throw this.unavailable();
    try {
      return await this.usage.run(
        userId,
        feature,
        () => this.claude.complete(request),
        now,
      );
    } catch (error) {
      if (error instanceof ClaudeUnavailableError) {
        throw error.reason === 'not_configured'
          ? this.unavailable()
          : new BadGatewayException({
              code: 'ai_failed',
              message: 'The AI did not answer; try again',
            });
      }
      throw error;
    }
  }

  private unavailable() {
    return new ServiceUnavailableException({
      code: 'ai_unavailable',
      message: 'AI features are not set up on this server',
    });
  }
}
