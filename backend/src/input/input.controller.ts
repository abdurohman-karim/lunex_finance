import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  type ParseResult,
  PhraseParserService,
} from './phrase-parser.service.js';

const parseSchema = z.object({
  /** What was said or typed */
  text: z.string().trim().min(1).max(500),
});

/** Voice and text input: a phrase becomes operations for the app to show before saving. */
@Controller('ai')
export class InputController {
  constructor(private readonly parser: PhraseParserService) {}

  @Post('parse')
  @HttpCode(200)
  parse(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(parseSchema)) body: z.infer<typeof parseSchema>,
  ): Promise<ParseResult> {
    return this.parser.parse(user.userId, body.text);
  }
}
