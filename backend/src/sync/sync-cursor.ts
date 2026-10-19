import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import type { SyncPosition } from './sync-window.js';

export const SYNC_STREAMS = [
  'profile',
  'accounts',
  'categories',
  'categoryPreferences',
  'transactions',
  'goals',
  'goalContributions',
] as const;
export type SyncStream = (typeof SYNC_STREAMS)[number];

export type SyncCursor = Partial<Record<SyncStream, SyncPosition>>;

const positionSchema = z.object({
  u: z.iso.datetime(),
  id: z.string().min(1).max(64),
});
const cursorSchema = z.object({
  v: z.literal(1),
  p: z.partialRecord(z.enum(SYNC_STREAMS), positionSchema),
});

/** Opaque to the app: it stores the cursor and sends it back on the next pull. */
export function encodeSyncCursor(cursor: SyncCursor): string {
  const p = Object.fromEntries(
    Object.entries(cursor).map(([stream, position]) => [
      stream,
      { u: position.updatedAt.toISOString(), id: position.id },
    ]),
  );
  return Buffer.from(JSON.stringify({ v: 1, p })).toString('base64url');
}

export function decodeSyncCursor(value: string): SyncCursor {
  let parsed: z.infer<typeof cursorSchema>;
  try {
    parsed = cursorSchema.parse(
      JSON.parse(Buffer.from(value, 'base64url').toString('utf8')),
    );
  } catch {
    throw new BadRequestException({
      code: 'invalid_cursor',
      message: 'The sync cursor is malformed; start a full sync',
    });
  }
  return Object.fromEntries(
    Object.entries(parsed.p).map(([stream, position]) => [
      stream,
      { updatedAt: new Date(position!.u), id: position!.id },
    ]),
  ) as SyncCursor;
}
