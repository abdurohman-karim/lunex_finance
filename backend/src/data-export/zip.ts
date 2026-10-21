import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipEntry {
  /** Path inside the archive, `/` between folders */
  name: string;
  data: Buffer;
  /** Deflate it; photos are already compressed and are stored as they are */
  compress?: boolean;
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
/** Bit 11: names are UTF-8 */
const UTF8_NAMES = 0x0800;
const STORED = 0;
const DEFLATED = 8;

/**
 * A ZIP archive written as it goes: each entry is sent once it is read, so a big export never
 * sits in memory as a whole. Classic ZIP (no ZIP64): fine below 4 GB and 65 535 entries.
 */
export async function* zip(
  entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>,
  modified = new Date(),
): AsyncGenerator<Buffer> {
  const { time, date } = dosDateTime(modified);
  const central: Buffer[] = [];
  let offset = 0;
  let count = 0;

  for await (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const deflated = entry.compress ? deflateRawSync(entry.data) : null;
    const method =
      deflated && deflated.length < entry.data.length ? DEFLATED : STORED;
    const body = method === DEFLATED && deflated ? deflated : entry.data;
    const checksum = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(CENTRAL_HEADER, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(UTF8_NAMES, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(date, 14);
    header.writeUInt32LE(checksum, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    // Extra field, comment, disk, internal and external attributes stay 0.
    header.writeUInt32LE(offset, 42);
    central.push(header, name);

    yield Buffer.concat([local, name, body]);
    offset += local.length + name.length + body.length;
    count += 1;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  yield Buffer.concat([directory, end]);
}

/** MS-DOS time and date of the entries, in UTC. */
function dosDateTime(at: Date): { time: number; date: number } {
  return {
    time:
      (at.getUTCHours() << 11) |
      (at.getUTCMinutes() << 5) |
      Math.floor(at.getUTCSeconds() / 2),
    date:
      ((Math.max(at.getUTCFullYear(), 1980) - 1980) << 9) |
      ((at.getUTCMonth() + 1) << 5) |
      at.getUTCDate(),
  };
}
