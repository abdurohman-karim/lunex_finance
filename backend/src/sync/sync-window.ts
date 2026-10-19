/** Position inside one entity's change stream, ordered by `updated_at, id`. */
export interface SyncPosition {
  updatedAt: Date;
  id: string;
}

/** What one stream should return: changes after `after`, up to `horizon`, at most `limit`. */
export interface ChangeWindow {
  after: SyncPosition | null;
  horizon: Date;
  limit: number;
}

export interface ChangesPage<T> {
  items: T[];
  /** Position of the last item, or null when the page is empty */
  last: SyncPosition | null;
}

/**
 * Keyset filter for a change stream. `idField` is the tie-breaker column
 * (`category_id` for category_preferences, whose key is composite).
 */
export function changeWindowWhere(
  window: ChangeWindow,
  idField = 'id',
): { AND: Record<string, unknown>[] } {
  const and: Record<string, unknown>[] = [
    { updated_at: { lte: window.horizon } },
  ];
  if (window.after) {
    and.push({
      OR: [
        { updated_at: { gt: window.after.updatedAt } },
        {
          updated_at: window.after.updatedAt,
          [idField]: { gt: window.after.id },
        },
      ],
    });
  }
  return { AND: and };
}

export const changeOrder = (idField = 'id') => [
  { updated_at: 'asc' as const },
  { [idField]: 'asc' as const },
];

export function lastPosition<T>(
  rows: T[],
  read: (row: T) => SyncPosition,
): SyncPosition | null {
  const last = rows.at(-1);
  return last === undefined ? null : read(last);
}
