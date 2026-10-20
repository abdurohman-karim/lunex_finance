import { generateKeyPairSync, verify } from 'node:crypto';
import {
  createServer,
  type Http2Server,
  type IncomingHttpHeaders,
} from 'node:http2';
import type { AddressInfo } from 'node:net';
import { ApnsPushSender, providerToken } from './apns-push-sender.js';

const { privateKey, publicKey } = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
});
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

describe('APNs', () => {
  it('signs the provider token with the key (ES256)', () => {
    const token = providerToken(
      privateKey,
      'KEY123',
      'TEAM45',
      new Date('2026-10-20T07:00:00Z'),
    );
    const [header, claims, signature] = token.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'ES256',
      kid: 'KEY123',
    });
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toEqual({
      iss: 'TEAM45',
      iat: 1792479600,
    });
    expect(
      verify(
        'sha256',
        Buffer.from(`${header}.${claims}`),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true);
  });

  describe('sending', () => {
    let server: Http2Server;
    let sender: ApnsPushSender;
    const seen: { headers: IncomingHttpHeaders; body: string }[] = [];
    // The stand-in APNs answers by the token: ok, gone, expired provider token once, busy.
    let expiredOnce = true;

    beforeAll(async () => {
      server = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk: Buffer) => (body += chunk.toString()));
        req.on('end', () => {
          seen.push({ headers: req.headers, body });
          const token = String(req.headers[':path']).split('/').pop();
          const reply = (status: number, reason?: string) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(reason ? JSON.stringify({ reason }) : '');
          };
          if (token === 'gone') return reply(410, 'Unregistered');
          if (token === 'busy') return reply(429, 'TooManyRequests');
          if (token === 'stale' && expiredOnce) {
            expiredOnce = false;
            return reply(403, 'ExpiredProviderToken');
          }
          reply(200);
        });
      });
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const { port } = server.address() as AddressInfo;
      sender = new ApnsPushSender({
        keyId: 'KEY123',
        teamId: 'TEAM45',
        privateKey: pem.replace(/\n/g, '\\n'),
        topic: 'uz.lunex.finance',
        host: `http://localhost:${port}`,
      });
    });

    afterAll(async () => {
      sender.onModuleDestroy();
      await new Promise((resolve) => server.close(resolve));
    });

    const push = (token: string) =>
      sender.send({
        token,
        payload: { aps: { alert: { title: 'Hi', body: 'There' } } },
        expiresAt: new Date('2026-10-21T00:00:00Z'),
      });

    it('posts the payload with the topic, priority and expiry', async () => {
      expect(await push('a1b2')).toEqual({ status: 'ok' });
      const { headers, body } = seen.at(-1)!;
      expect(headers[':path']).toBe('/3/device/a1b2');
      expect(headers['apns-topic']).toBe('uz.lunex.finance');
      expect(headers['apns-push-type']).toBe('alert');
      expect(headers['apns-expiration']).toBe('1792540800');
      expect(String(headers.authorization)).toMatch(/^bearer ey/);
      expect(JSON.parse(body)).toEqual({
        aps: { alert: { title: 'Hi', body: 'There' } },
      });
    });

    it('tells a dead token from a busy server', async () => {
      expect(await push('gone')).toEqual({
        status: 'invalid_token',
        reason: 'Unregistered',
      });
      expect(await push('busy')).toEqual({
        status: 'retry',
        reason: 'TooManyRequests',
      });
    });

    it('signs a new provider token when APNs says the old one expired', async () => {
      expect(await push('stale')).toEqual({ status: 'ok' });
    });
  });
});
