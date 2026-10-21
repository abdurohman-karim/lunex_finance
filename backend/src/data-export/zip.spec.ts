import { describe, expect, it } from 'vitest';
import { unzip } from '../../test/support/unzip.js';
import { zip } from './zip.js';

async function collect(chunks: AsyncGenerator<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of chunks) parts.push(chunk);
  return Buffer.concat(parts);
}

describe('zip', () => {
  it('writes entries unzip reads back, deflating only what shrinks', async () => {
    const json = Buffer.from(
      JSON.stringify({ items: Array(200).fill('кофе') }),
    );
    const photo = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    const archive = await collect(
      zip([
        { name: 'data.json', data: json, compress: true },
        { name: 'receipts/чек.jpg', data: photo, compress: true },
      ]),
    );
    const files = unzip(archive);
    expect([...files.keys()]).toEqual(['data.json', 'receipts/чек.jpg']);
    expect(files.get('data.json')).toEqual(json);
    expect(files.get('receipts/чек.jpg')).toEqual(photo);
    expect(archive.length).toBeLessThan(json.length);
  });

  it('makes an empty archive', async () => {
    const archive = await collect(zip([]));
    expect(archive.length).toBe(22);
    expect(unzip(archive).size).toBe(0);
  });
});
