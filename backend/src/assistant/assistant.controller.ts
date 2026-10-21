import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import type { z } from 'zod';
import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.types.js';
import { uuidParamSchema } from '../common/schemas.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { decideActionSchema, sendMessageSchema } from './assistant.schemas.js';
import {
  type ConversationDto,
  type MessageDto,
  AssistantService,
  type SendResult,
} from './assistant.service.js';

/** The AI assistant's chat. */
@Controller('assistant')
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  @Get('conversations')
  conversations(@CurrentUser() user: AuthUser): Promise<ConversationDto[]> {
    return this.assistant.conversations(user.userId);
  }

  @Get('conversations/:id/messages')
  messages(
    @CurrentUser() user: AuthUser,
    @Param('id', new ZodValidationPipe(uuidParamSchema)) id: string,
  ): Promise<MessageDto[]> {
    return this.assistant.messages(user.userId, id);
  }

  /** The whole history */
  @Delete('conversations')
  @HttpCode(204)
  async removeAll(@CurrentUser() user: AuthUser): Promise<void> {
    await this.assistant.removeAll(user.userId);
  }

  @Delete('conversations/:id')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id', new ZodValidationPipe(uuidParamSchema)) id: string,
  ): Promise<void> {
    await this.assistant.remove(user.userId, id);
  }

  /** A question; the answer comes back with it. The same message id again is «Повторить». */
  @Post('messages')
  @HttpCode(200)
  send(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(sendMessageSchema))
    body: z.infer<typeof sendMessageSchema>,
  ): Promise<SendResult> {
    return this.assistant.send(user.userId, body);
  }

  /** «Создать» or «Не нужно» on a proposed action */
  @Post('messages/:id/actions/:index')
  @HttpCode(200)
  decide(
    @CurrentUser() user: AuthUser,
    @Param('id', new ZodValidationPipe(uuidParamSchema)) id: string,
    @Param('index', ParseIntPipe) index: number,
    @Body(new ZodValidationPipe(decideActionSchema))
    body: z.infer<typeof decideActionSchema>,
  ): Promise<MessageDto> {
    return this.assistant.decide(user.userId, id, index, body.decision);
  }
}
