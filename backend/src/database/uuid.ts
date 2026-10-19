import { createHash } from 'node:crypto';

/** Namespace for Lunex name-based UUIDs. Never change it: system category ids are derived from it. */
export const LUNEX_UUID_NAMESPACE = '0b8f3c52-6f2a-4d4e-9a61-3c7e2b9d5f10';

/** RFC 9562 version 5 (SHA-1, name-based) UUID: the same name always gives the same id. */
export function uuidV5(
  name: string,
  namespace: string = LUNEX_UUID_NAMESPACE,
): string {
  const namespaceBytes = Buffer.from(namespace.replaceAll('-', ''), 'hex');
  const hash = createHash('sha1')
    .update(namespaceBytes)
    .update(name, 'utf8')
    .digest();

  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;

  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
