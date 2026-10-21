import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { EntitlementsService } from '../billing/entitlements.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { OcrStatus } from '../generated/prisma/enums.js';
import { AttachmentStorage } from '../storage/attachment-storage.js';
import type { UploadAttachmentInput } from './attachments.schemas.js';

/** Photos of receipts are a few hundred kilobytes once the app has scaled them down. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_PER_TRANSACTION = 5;

/** The image types kept, and how their files start. */
const SIGNATURES: Record<string, (data: Buffer) => boolean> = {
  'image/jpeg': (data) =>
    data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  'image/png': (data) =>
    data
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/heic': (data) => data.subarray(4, 8).toString('latin1') === 'ftyp',
  'image/webp': (data) =>
    data.subarray(0, 4).toString('latin1') === 'RIFF' &&
    data.subarray(8, 12).toString('latin1') === 'WEBP',
};

export interface UploadedFile {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

/** In an operation: what the app needs to show it and fetch the photo. */
export interface AttachmentSummary {
  id: string;
  mimeType: string;
  sizeBytes: number;
  ocrStatus: OcrStatus;
  createdAt: Date;
}

export interface AttachmentDto extends AttachmentSummary {
  transactionId: string;
  /** What was read on the receipt, as the app sent it */
  receipt: Prisma.JsonValue;
}

type AttachmentRow = Prisma.TransactionAttachmentsGetPayload<object>;

export function toAttachmentSummary(row: {
  id: string;
  mime_type: string;
  size_bytes: number;
  ocr_status: OcrStatus;
  created_at: Date;
}): AttachmentSummary {
  return {
    id: row.id,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    ocrStatus: row.ocr_status,
    createdAt: row.created_at,
  };
}

function toDto(row: AttachmentRow): AttachmentDto {
  return {
    ...toAttachmentSummary(row),
    transactionId: row.transaction_id,
    receipt: row.ocr_payload,
  };
}

const notFound = () =>
  new NotFoundException({
    code: 'attachment_not_found',
    message: 'Attachment not found',
  });

/**
 * Photos attached to operations (spec: «Сканирование чека»): uploaded by the app once the
 * operation is on the server, with the id the app gave it, so a resend stores it once. Adding
 * or removing one touches its operation, so sync brings the change to the other devices.
 * Lunex Pro (`receipt_scan`) to add; what is there stays readable.
 */
@Injectable()
export class AttachmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly storage: AttachmentStorage,
  ) {}

  async upload(
    userId: string,
    id: string,
    input: UploadAttachmentInput,
    file: UploadedFile | undefined,
  ): Promise<AttachmentDto> {
    await this.entitlements.assertFeature(userId, 'receipt_scan');
    if (!file || file.size === 0) {
      throw new UnprocessableEntityException({
        code: 'file_required',
        message: 'Attach the photo as `file`',
      });
    }
    const looksRight = SIGNATURES[file.mimetype];
    if (!looksRight?.(file.buffer)) {
      throw new UnprocessableEntityException({
        code: 'unsupported_file',
        message: 'A JPEG, PNG, HEIC or WebP photo is expected',
      });
    }

    const existing = await this.prisma.transactionAttachments.findUnique({
      where: { id },
    });
    if (existing) {
      if (
        existing.user_id !== userId ||
        existing.transaction_id !== input.transactionId
      ) {
        throw new ConflictException({
          code: 'id_conflict',
          message: 'This id is already used',
        });
      }
      return toDto(existing);
    }

    const transaction = await this.prisma.transactions.findUnique({
      where: { id: input.transactionId },
      select: { user_id: true },
    });
    if (!transaction || transaction.user_id !== userId) {
      throw new NotFoundException({
        code: 'transaction_not_found',
        message: 'Operation not found',
      });
    }

    const key = this.storage.key(userId, id);
    await this.storage.put(key, file.buffer);
    const receipt = input.receipt;
    const status: OcrStatus = !receipt
      ? 'pending'
      : receipt.amount
        ? 'done'
        : 'failed';
    let row: AttachmentRow;
    try {
      row = await this.prisma.$transaction(async (tx) => {
        const count = await tx.transactionAttachments.count({
          where: { transaction_id: input.transactionId },
        });
        if (count >= MAX_PER_TRANSACTION) {
          throw new UnprocessableEntityException({
            code: 'too_many_attachments',
            message: `At most ${MAX_PER_TRANSACTION} photos per operation`,
            limit: MAX_PER_TRANSACTION,
          });
        }
        const created = await tx.transactionAttachments.create({
          data: {
            id,
            transaction_id: input.transactionId,
            user_id: userId,
            storage_key: key,
            mime_type: file.mimetype,
            size_bytes: file.size,
            ocr_status: status,
            ocr_payload: receipt ?? undefined,
          },
        });
        await this.touch(tx, input.transactionId);
        return created;
      });
    } catch (error) {
      // The same photo sent twice at once: the other request stored it.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return this.upload(userId, id, input, file);
      }
      await this.storage.remove(key);
      throw error;
    }
    return toDto(row);
  }

  /** The photo itself, for its owner. */
  async file(
    userId: string,
    id: string,
  ): Promise<{ data: Buffer; mimeType: string }> {
    const row = await this.prisma.transactionAttachments.findUnique({
      where: { id },
    });
    if (!row || row.user_id !== userId) throw notFound();
    const data = await this.storage.get(row.storage_key);
    if (!data) throw notFound();
    return { data, mimeType: row.mime_type };
  }

  /** Removes a photo; removing one already gone is fine (a resent queue operation). */
  async remove(userId: string, id: string): Promise<void> {
    const row = await this.prisma.transactionAttachments.findUnique({
      where: { id },
    });
    if (!row) return;
    if (row.user_id !== userId) throw notFound();
    await this.prisma.$transaction(async (tx) => {
      await tx.transactionAttachments.delete({ where: { id } });
      await this.touch(tx, row.transaction_id);
    });
    await this.storage.remove(row.storage_key);
  }

  /** The operation changes with its photos: sync sends it again. */
  private async touch(
    tx: Prisma.TransactionClient,
    transactionId: string,
  ): Promise<void> {
    await tx.transactions.update({
      where: { id: transactionId },
      data: { updated_at: new Date() },
    });
  }
}
