import type Anthropic from '@anthropic-ai/sdk';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ClaudeReply, ClaudeRequest } from '../ai/claude.client.js';
import { AiService } from '../ai/ai.service.js';
import { AiUsageService, type FeatureUsage } from '../ai/ai-usage.service.js';
import { BudgetService } from '../budget/budget.service.js';
import { localDate } from '../common/dates.js';
import { PrismaService } from '../database/prisma.service.js';
import { uuidV5 } from '../database/uuid.js';
import { RecurringService } from '../finance/recurring/recurring.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { LanguageCode } from '../generated/prisma/enums.js';
import { GoalsService } from '../goals/goals.service.js';
import { userCategories } from '../input/user-categories.js';
import {
  ASSISTANT_TOOLS,
  type AssistantActionParams,
  type AssistantChart,
  AnswerParts,
  AssistantTools,
  type AssistantUser,
} from './assistant-tools.js';
import type { SendMessageInput } from './assistant.schemas.js';

/** Look-ups the model may make for one answer before it has to answer */
const MAX_STEPS = 5;
/** Earlier messages of the conversation the model reads */
const HISTORY = 20;

const LANGUAGE_NAME: Record<LanguageCode, string> = {
  uz: 'Uzbek (Latin script)',
  ru: 'Russian',
  en: 'English',
};

export type AssistantAction = AssistantActionParams & {
  /** `proposed` until the user decides */
  status: 'proposed' | 'done' | 'declined';
  /** What confirming made: the goal, the category limited, the recurring rule */
  resultId: string | null;
};

export interface ConversationDto {
  id: string;
  title: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MessageDto {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  charts: AssistantChart[];
  actions: AssistantAction[];
  createdAt: Date;
}

export interface SendResult {
  conversation: ConversationDto;
  /** The question and the answer */
  messages: MessageDto[];
  /** What is left of today's messages */
  usage: FeatureUsage & { resetsAt: Date };
}

type MessageRow = Prisma.AiMessagesGetPayload<object>;
type ConversationRow = Prisma.AiConversationsGetPayload<object>;

function toConversation(row: ConversationRow): ConversationDto {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMessage(row: MessageRow): MessageDto {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    charts: (row.charts as unknown as AssistantChart[] | null) ?? [],
    actions: (row.actions as unknown as AssistantAction[] | null) ?? [],
    createdAt: row.created_at,
  };
}

const conversationNotFound = () =>
  new NotFoundException({
    code: 'conversation_not_found',
    message: 'Conversation not found',
  });

/**
 * The assistant chat (spec: «AI-ассистент»): questions about the user's own money answered
 * by Claude, which looks every figure up with `AssistantTools` and may offer to create a goal,
 * set a category limit or add a recurring payment — cards the user confirms here. One
 * message is one request of the day's limit, whatever the look-ups; a failed one is not
 * counted, and sending the same message id again is «Повторить».
 */
@Injectable()
export class AssistantService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly usage: AiUsageService,
    private readonly tools: AssistantTools,
    private readonly goals: GoalsService,
    private readonly budget: BudgetService,
    private readonly recurring: RecurringService,
  ) {}

  // ---------- Conversations ----------

  async conversations(userId: string): Promise<ConversationDto[]> {
    const rows = await this.prisma.aiConversations.findMany({
      where: { user_id: userId, deleted_at: null },
      orderBy: { updated_at: 'desc' },
      take: 50,
    });
    return rows.map(toConversation);
  }

  async messages(
    userId: string,
    conversationId: string,
  ): Promise<MessageDto[]> {
    await this.ownedConversation(userId, conversationId);
    const rows = await this.prisma.aiMessages.findMany({
      where: { conversation_id: conversationId },
      orderBy: [{ created_at: 'asc' }, { role: 'desc' }],
      take: 400,
    });
    return rows.map(toMessage);
  }

  /** Removes the conversation with every message in it. */
  async remove(userId: string, conversationId: string): Promise<void> {
    const conversation = await this.prisma.aiConversations.findUnique({
      where: { id: conversationId },
    });
    if (!conversation || conversation.deleted_at) return;
    if (conversation.user_id !== userId) throw conversationNotFound();
    await this.erase(userId, [conversationId]);
  }

  async removeAll(userId: string): Promise<void> {
    const rows = await this.prisma.aiConversations.findMany({
      where: { user_id: userId, deleted_at: null },
      select: { id: true },
    });
    await this.erase(
      userId,
      rows.map((row) => row.id),
    );
  }

  private async erase(userId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.prisma.$transaction([
      this.prisma.aiMessages.deleteMany({
        where: { conversation_id: { in: ids } },
      }),
      // The row stays deleted so its id is never taken again.
      this.prisma.aiConversations.updateMany({
        where: { id: { in: ids }, user_id: userId },
        data: { deleted_at: new Date(), title: null },
      }),
    ]);
  }

  // ---------- Asking ----------

  async send(
    userId: string,
    input: SendMessageInput,
    now = new Date(),
  ): Promise<SendResult> {
    let conversation = await this.prisma.aiConversations.findUnique({
      where: { id: input.conversationId },
    });
    if (conversation && conversation.user_id !== userId) {
      throw new ConflictException({
        code: 'id_conflict',
        message: 'This id is already used',
      });
    }
    if (conversation?.deleted_at) throw conversationNotFound();
    conversation ??= await this.prisma.aiConversations.create({
      data: {
        id: input.conversationId,
        user_id: userId,
        title: input.text.slice(0, 80),
      },
    });

    const replyId = uuidV5(`assistant-reply:${input.messageId}`);
    let question = await this.prisma.aiMessages.findUnique({
      where: { id: input.messageId },
    });
    if (question && question.conversation_id !== conversation.id) {
      throw new ConflictException({
        code: 'id_conflict',
        message: 'This id is already used',
      });
    }
    if (question) {
      const answered = await this.prisma.aiMessages.findUnique({
        where: { id: replyId },
      });
      if (answered) {
        return this.result(userId, conversation, [question, answered], now);
      }
    } else {
      question = await this.prisma.aiMessages.create({
        data: {
          id: input.messageId,
          conversation_id: conversation.id,
          role: 'user',
          content: input.text,
          created_at: now,
        },
      });
    }

    const user = await this.context(userId, now);
    const history = await this.history(conversation.id, question);
    const parts = new AnswerParts();
    const answer = await this.ai.converse(
      userId,
      'assistant',
      (complete) =>
        this.answer(complete, user, history, question.content, parts, now),
      now,
    );
    const actions: AssistantAction[] = parts.actions.map((action) => ({
      ...action,
      status: 'proposed',
      resultId: null,
    }));
    const reply = await this.prisma.aiMessages.create({
      data: {
        id: replyId,
        conversation_id: conversation.id,
        role: 'assistant',
        content: answer.text,
        actions: actions as unknown as Prisma.InputJsonValue,
        charts: parts.charts as unknown as Prisma.InputJsonValue,
        input_tokens: answer.inputTokens,
        output_tokens: answer.outputTokens,
        // Right after the question, whatever the clock did meanwhile.
        created_at: new Date(
          Math.max(Date.now(), question.created_at.getTime() + 1),
        ),
      },
    });
    conversation = await this.prisma.aiConversations.update({
      where: { id: conversation.id },
      data: { updated_at: new Date() },
    });
    return this.result(userId, conversation, [question, reply], now);
  }

  /** The model looks things up until it answers; the last look-up has to be an answer. */
  private async answer(
    complete: (request: ClaudeRequest) => Promise<ClaudeReply>,
    user: AssistantUser,
    history: Anthropic.MessageParam[],
    question: string,
    parts: AnswerParts,
    now: Date,
  ): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
    const messages: Anthropic.MessageParam[] = [
      ...history,
      { role: 'user', content: question },
    ];
    const system = this.system(user);
    let text = '';
    let inputTokens = 0;
    let outputTokens = 0;
    for (let step = 0; step < MAX_STEPS; step++) {
      const reply = await complete({
        tier: 'smart',
        system,
        messages,
        tools: ASSISTANT_TOOLS,
        toolChoice: step === MAX_STEPS - 1 ? { type: 'none' } : undefined,
        maxTokens: 1024,
      });
      inputTokens += reply.usage.inputTokens;
      outputTokens += reply.usage.outputTokens;
      if (reply.text.trim()) text = reply.text.trim();
      const uses = (reply.content ?? []).filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
      );
      if (uses.length === 0) break;
      messages.push({
        role: 'assistant',
        content: reply.content as Anthropic.ContentBlockParam[],
      });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of uses) {
        const result = await this.tools.run(
          user,
          use.name,
          (use.input ?? {}) as Record<string, unknown>,
          parts,
          now,
        );
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: JSON.stringify(result),
          is_error:
            typeof result === 'object' && result !== null && 'error' in result,
        });
      }
      messages.push({ role: 'user', content: results });
    }
    if (!text) {
      throw new BadGatewayException({
        code: 'ai_failed',
        message: 'The AI did not answer; try again',
      });
    }
    return { text, inputTokens, outputTokens };
  }

  private system(user: AssistantUser): string {
    const categories = [...user.categories]
      .map(([ref, c]) => `${ref} ${c.type} ${c.names.join(' / ')}`)
      .join('\n');
    const weekday = new Date(`${user.today}T00:00:00Z`).toLocaleDateString(
      'en',
      { weekday: 'long', timeZone: 'UTC' },
    );
    return [
      'You are Lunex, the assistant in a personal finance app used in Uzbekistan.',
      `Answer in ${LANGUAGE_NAME[user.language]}, short: one to four sentences, the figure first. Plain text, no tables or headings.`,
      `Today is ${weekday}, ${user.today}. Money is counted in ${user.currency.code} unless a tool says otherwise.`,
      'Take every figure from the tools; never guess or invent one. When the data cannot answer, say so.',
      'Write money exactly as the tools show it. Name months and days in words.',
      'You may suggest one next step. To create a goal, set a category limit or add a recurring payment, call a propose_ tool: the user confirms it on a card, so never say it is done.',
      'No investment advice. For questions that are not about the user’s money, say you help with their finances in Lunex.',
      'Categories (ref, type, names):',
      categories,
    ].join('\n');
  }

  /** Earlier messages, oldest first, one role after the other as the API wants them. */
  private async history(
    conversationId: string,
    question: MessageRow,
  ): Promise<Anthropic.MessageParam[]> {
    const rows = await this.prisma.aiMessages.findMany({
      where: {
        conversation_id: conversationId,
        id: { not: question.id },
        created_at: { lte: question.created_at },
      },
      orderBy: { created_at: 'desc' },
      take: HISTORY,
    });
    const turns: { role: 'user' | 'assistant'; content: string }[] = [];
    for (const row of rows.reverse()) {
      const last = turns.at(-1);
      if (last && last.role === row.role) {
        last.content = `${last.content}\n\n${row.content}`;
      } else {
        turns.push({ role: row.role, content: row.content });
      }
    }
    while (turns[0]?.role === 'assistant') turns.shift();
    // The question itself follows as a user turn.
    if (turns.at(-1)?.role === 'user') {
      turns.push({ role: 'assistant', content: '…' });
    }
    return turns;
  }

  // ---------- Proposed actions ----------

  /** The user's decision on a card: confirming does it, declining only marks it. */
  async decide(
    userId: string,
    messageId: string,
    index: number,
    decision: 'confirm' | 'decline',
    now = new Date(),
  ): Promise<MessageDto> {
    const row = await this.prisma.aiMessages.findUnique({
      where: { id: messageId },
      include: {
        conversation: { select: { user_id: true, deleted_at: true } },
      },
    });
    if (
      !row ||
      row.conversation.user_id !== userId ||
      row.conversation.deleted_at
    ) {
      throw new NotFoundException({
        code: 'message_not_found',
        message: 'Message not found',
      });
    }
    const actions = (row.actions as unknown as AssistantAction[] | null) ?? [];
    const action = actions[index];
    if (!action) {
      throw new BadRequestException({
        code: 'action_not_found',
        message: 'No such action in the message',
      });
    }
    if (action.status !== 'proposed') return toMessage(row);

    if (decision === 'decline') {
      action.status = 'declined';
    } else {
      action.resultId = await this.carryOut(
        userId,
        action,
        uuidV5(`assistant-action:${messageId}:${index}`),
        now,
      );
      action.status = 'done';
    }
    const updated = await this.prisma.aiMessages.update({
      where: { id: messageId },
      data: { actions: actions as unknown as Prisma.InputJsonValue },
    });
    return toMessage(updated);
  }

  /** Through the same services as the app's own screens, with their checks and limits. */
  private async carryOut(
    userId: string,
    action: AssistantAction,
    id: string,
    now: Date,
  ): Promise<string> {
    switch (action.kind) {
      case 'create_goal': {
        const goal = await this.goals.create(userId, {
          id,
          title: action.title,
          targetAmount: action.targetAmount,
          currency: action.currency,
          deadline: action.deadline ?? undefined,
          emoji: action.emoji ?? undefined,
        });
        return goal.id;
      }
      case 'category_limit': {
        const summary = await this.budget.current(userId, now);
        await this.budget.setPlan(
          userId,
          {
            plannedIncome: summary.income.planned,
            totalLimit: summary.totalLimit,
            savingsTarget: summary.savingsTarget,
            rolloverEnabled: summary.rolloverEnabled,
            categoryLimits: [
              ...summary.categoryLimits
                .filter((limit) => limit.categoryId !== action.categoryId)
                .map((limit) => ({
                  categoryId: limit.categoryId,
                  limit: limit.limit,
                  alertThresholdPct: limit.alertThresholdPct,
                })),
              {
                categoryId: action.categoryId,
                limit: action.limit,
                alertThresholdPct: 80,
              },
            ],
          },
          now,
        );
        return action.categoryId;
      }
      case 'recurring': {
        const account = await this.tools.defaultAccount(userId);
        if (!account) {
          throw new BadRequestException({
            code: 'no_account',
            message: 'Add an account first',
          });
        }
        const timezone = (
          await this.prisma.users.findUniqueOrThrow({
            where: { id: userId },
            select: { timezone: true },
          })
        ).timezone;
        const rule = await this.recurring.create(userId, {
          id,
          title: action.title,
          type: action.type,
          amount: action.amount,
          accountId: account.id,
          categoryId: action.categoryId,
          frequency: action.frequency,
          interval: 1,
          dayOfMonth: action.dayOfMonth,
          startOn: localDate(now, timezone),
          endOn: null,
          autoCreate: false,
          remindDaysBefore: 1,
          isSubscription: action.isSubscription,
        });
        return rule.id;
      }
    }
  }

  // ---------- Pieces ----------

  private async ownedConversation(userId: string, id: string) {
    const conversation = await this.prisma.aiConversations.findUnique({
      where: { id },
    });
    if (
      !conversation ||
      conversation.user_id !== userId ||
      conversation.deleted_at
    ) {
      throw conversationNotFound();
    }
    return conversation;
  }

  private async context(userId: string, now: Date): Promise<AssistantUser> {
    const user = await this.prisma.users.findUniqueOrThrow({
      where: { id: userId },
      select: {
        language: true,
        timezone: true,
        baseCurrency: { select: { code: true, decimals: true, symbol: true } },
      },
    });
    const categories = await userCategories(this.prisma, userId, user.language);
    return {
      id: userId,
      language: user.language,
      timezone: user.timezone,
      currency: user.baseCurrency,
      today: localDate(now, user.timezone),
      categories: new Map(categories.map((c, i) => [`c${i + 1}`, c])),
    };
  }

  private async result(
    userId: string,
    conversation: ConversationRow,
    rows: MessageRow[],
    now: Date,
  ): Promise<SendResult> {
    const status = await this.usage.status(userId, now);
    const assistant = status.features.find((f) => f.feature === 'assistant')!;
    return {
      conversation: toConversation(conversation),
      messages: rows.map(toMessage),
      usage: { ...assistant, resetsAt: status.resetsAt },
    };
  }
}
