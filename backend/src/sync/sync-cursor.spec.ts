import { decodeSyncCursor, encodeSyncCursor } from './sync-cursor.js';

describe('sync cursor', () => {
  it('round-trips stream positions', () => {
    const cursor = {
      accounts: {
        updatedAt: new Date('2026-10-19T09:00:00.123Z'),
        id: '0b8f3c52-6f2a-4d4e-9a61-3c7e2b9d5f10',
      },
      transactions: {
        updatedAt: new Date('2026-10-19T09:00:01.000Z'),
        id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
      },
    };
    expect(decodeSyncCursor(encodeSyncCursor(cursor))).toEqual(cursor);
  });

  it.each([
    'garbage',
    Buffer.from('{"v":2,"p":{}}').toString('base64url'),
    Buffer.from('{"v":1,"p":{"nope":{"u":"x","id":"y"}}}').toString(
      'base64url',
    ),
  ])('rejects %s', (value) => {
    expect(() => decodeSyncCursor(value)).toThrow(/full sync/);
  });
});
