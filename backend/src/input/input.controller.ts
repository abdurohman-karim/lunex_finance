import {
  Body,
  Controller,
  HttpCode,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import {
  MAX_ATTACHMENT_BYTES,
  type UploadedFile as Upload,
} from '../attachments/attachments.service.js';
import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  type ParseResult,
  PhraseParserService,
} from './phrase-parser.service.js';
import {
  ReceiptReaderService,
  type ReceiptResult,
} from './receipt-reader.service.js';

const parseSchema = z.object({
  /** What was said or typed */
  text: z.string().trim().min(1).max(500),
});

const receiptSchema = z.object({
  /** What Apple Vision read on the device */
  text: z.string().max(4000).optional(),
});

/**
 * Voice and text input, receipts: a phrase or a photo becomes operations for the app to show
 * before saving.
 */
@Controller('ai')
export class InputController {
  constructor(
    private readonly parser: PhraseParserService,
    private readonly receipts: ReceiptReaderService,
  ) {}

  @Post('parse')
  @HttpCode(200)
  parse(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(parseSchema)) body: z.infer<typeof parseSchema>,
  ): Promise<ParseResult> {
    return this.parser.parse(user.userId, body.text);
  }

  /** Multipart: `file` (the photo, JPEG), `text` (the device's reading). */
  @Post('receipt')
  @HttpCode(200)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1, fields: 2 },
    }),
  )
  receipt(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(receiptSchema))
    body: z.infer<typeof receiptSchema>,
    @UploadedFile() file: Upload | undefined,
  ): Promise<ReceiptResult> {
    return this.receipts.read(user.userId, file, body.text);
  }
}
