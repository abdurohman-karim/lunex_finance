import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Put,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { z } from 'zod';
import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.types.js';
import { uuidParamSchema } from '../common/schemas.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { uploadAttachmentSchema } from './attachments.schemas.js';
import {
  type AttachmentDto,
  AttachmentsService,
  MAX_ATTACHMENT_BYTES,
  type UploadedFile as Upload,
} from './attachments.service.js';

/** Photos of receipts attached to operations. */
@Controller('attachments')
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  /** Multipart: `file` (the photo), `transactionId`, `receipt` (what was read, JSON). */
  @Put(':id')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1, fields: 4 },
    }),
  )
  upload(
    @CurrentUser() user: AuthUser,
    @Param('id', new ZodValidationPipe(uuidParamSchema)) id: string,
    @Body(new ZodValidationPipe(uploadAttachmentSchema))
    body: z.infer<typeof uploadAttachmentSchema>,
    @UploadedFile() file: Upload | undefined,
  ): Promise<AttachmentDto> {
    return this.attachments.upload(user.userId, id, body, file);
  }

  /** The photo; it never changes under its id, so the app may keep it. */
  @Get(':id')
  @Header('Cache-Control', 'private, max-age=31536000, immutable')
  async file(
    @CurrentUser() user: AuthUser,
    @Param('id', new ZodValidationPipe(uuidParamSchema)) id: string,
  ): Promise<StreamableFile> {
    const { data, mimeType } = await this.attachments.file(user.userId, id);
    return new StreamableFile(data, { type: mimeType, length: data.length });
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id', new ZodValidationPipe(uuidParamSchema)) id: string,
  ): Promise<void> {
    await this.attachments.remove(user.userId, id);
  }
}
