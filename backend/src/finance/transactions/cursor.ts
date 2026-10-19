import { BadRequestException } from '@nestjs/common';

/** Position in the history list, ordered by `occurred_at desc, id desc`. */
export interface HistoryCursor {
  occurredAt: Date;
  id: string;
}

export function encodeCursor(cursor: HistoryCursor): string {
  return Buffer.from(
    `${cursor.occurredAt.toISOString()}|${cursor.id}`,
  ).toString('base64url');
}

export function decodeCursor(value: string): HistoryCursor {
  const [iso, id] = Buffer.from(value, 'base64url').toString('utf8').split('|');
  const occurredAt = new Date(iso ?? '');
  if (!id || Number.isNaN(occurredAt.getTime())) {
    throw new BadRequestException({
      code: 'invalid_cursor',
      message: 'The cursor is malformed',
    });
  }
  return { occurredAt, id };
}
