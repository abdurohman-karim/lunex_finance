import Anthropic from '@anthropic-ai/sdk';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import type { TokenUsage } from './ai-usage.service.js';

/** `smart`: the assistant and reports; `fast`: parsing input and receipts (spec: «Интеграции»). */
export type ClaudeTier = 'smart' | 'fast';

export interface ClaudeRequest {
  tier: ClaudeTier;
  system: string;
  /** Text, or text with images (a receipt's photo), or tool calls and their results */
  messages: Anthropic.MessageParam[];
  maxTokens: number;
  /** What the model may look up (the assistant's data) */
  tools?: Anthropic.Tool[];
  toolChoice?: Anthropic.ToolChoice;
}

export interface ClaudeReply {
  text: string;
  model: string;
  usage: TokenUsage;
  /** Every block of the answer, tool calls included */
  content?: Anthropic.ContentBlock[];
  /** `tool_use` when the model waits for tool results */
  stopReason?: string | null;
}

/** The model could not answer: no key set, or the API failed after its retries. */
export class ClaudeUnavailableError extends Error {
  constructor(
    readonly reason: 'not_configured' | 'failed',
    message: string,
  ) {
    super(message);
  }
}

/** Claude API through the official SDK; one place for the key, the models and the errors. */
@Injectable()
export class ClaudeClient {
  private readonly logger = new Logger(ClaudeClient.name);
  private readonly client: Anthropic | null;
  private readonly models: Record<ClaudeTier, string>;

  constructor(config: ConfigService<Env, true>) {
    const apiKey = config.get('ANTHROPIC_API_KEY', { infer: true });
    this.client = apiKey
      ? new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000 })
      : null;
    this.models = {
      smart: config.get('CLAUDE_MODEL_SMART', { infer: true }),
      fast: config.get('CLAUDE_MODEL_FAST', { infer: true }),
    };
  }

  get available(): boolean {
    return this.client !== null;
  }

  async complete(request: ClaudeRequest): Promise<ClaudeReply> {
    if (!this.client) {
      throw new ClaudeUnavailableError(
        'not_configured',
        'ANTHROPIC_API_KEY is not set',
      );
    }
    const model = this.models[request.tier];
    try {
      const message = await this.client.messages.create({
        model,
        max_tokens: request.maxTokens,
        system: request.system,
        messages: request.messages,
        ...(request.tools ? { tools: request.tools } : {}),
        ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
      });
      const text = message.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('');
      const usage = message.usage;
      return {
        text,
        model: message.model,
        content: message.content,
        stopReason: message.stop_reason,
        usage: {
          // Cached input is input too: the day's figures show what was sent.
          inputTokens:
            usage.input_tokens +
            (usage.cache_creation_input_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0),
          outputTokens: usage.output_tokens,
        },
      };
    } catch (error) {
      const status =
        error instanceof Anthropic.APIError ? error.status : undefined;
      this.logger.warn(
        `Claude ${model} failed${status ? ` (${status})` : ''}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new ClaudeUnavailableError('failed', 'The model did not answer');
    }
  }
}
