import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { AiFeature } from '../generated/prisma/enums.js';
import { AiUsageService, type TokenUsage } from './ai-usage.service.js';
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
    return this.converse(userId, feature, (complete) => complete(request), now);
  }

  /**
   * Several calls to the model counted as one request: the assistant looks data up with
   * tools and answers in one message. The tokens of every call add up.
   */
  async converse<T>(
    userId: string,
    feature: AiFeature,
    steps: (
      complete: (request: ClaudeRequest) => Promise<ClaudeReply>,
    ) => Promise<T>,
    now = new Date(),
  ): Promise<T> {
    if (!this.claude.available) throw this.unavailable();
    try {
      const { result } = await this.usage.run(
        userId,
        feature,
        async () => {
          const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
          const result = await steps(async (request) => {
            const reply = await this.claude.complete(request);
            usage.inputTokens += reply.usage.inputTokens;
            usage.outputTokens += reply.usage.outputTokens;
            return reply;
          });
          return { result, usage };
        },
        now,
      );
      return result;
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
