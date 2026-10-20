import { type KeyObject, createPrivateKey, sign } from 'node:crypto';
import { type ClientHttp2Session, connect } from 'node:http2';
import { Logger, type OnModuleDestroy } from '@nestjs/common';
import {
  type PushMessage,
  type PushResult,
  PushSender,
} from './push-sender.js';

export const APNS_HOSTS = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
} as const;

export interface ApnsConfig {
  /** Key ID of the .p8 key from Apple Developer → Keys */
  keyId: string;
  teamId: string;
  /** The .p8 file's contents (PEM) */
  privateKey: string;
  /** The app's bundle id */
  topic: string;
  host: string;
}

/** Apple accepts a provider token for an hour and refuses one refreshed more than every 20 minutes. */
const TOKEN_LIFETIME_MS = 50 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
/** APNs reasons that mean the token will never work again for this app. */
const DEAD_TOKEN = new Set([
  'BadDeviceToken',
  'DeviceTokenNotForTopic',
  'Unregistered',
]);

const base64url = (data: Buffer | string) =>
  Buffer.from(data).toString('base64url');

/** ES256 JWT for token-based APNs authentication. */
export function providerToken(
  key: KeyObject,
  keyId: string,
  teamId: string,
  now = new Date(),
): string {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const claims = base64url(
    JSON.stringify({ iss: teamId, iat: Math.floor(now.getTime() / 1000) }),
  );
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), {
    key,
    dsaEncoding: 'ieee-p1363',
  });
  return `${header}.${claims}.${base64url(signature)}`;
}

/** Apple Push Notification service over HTTP/2 with a provider token; one connection reused. */
export class ApnsPushSender extends PushSender implements OnModuleDestroy {
  private readonly logger = new Logger(ApnsPushSender.name);
  private readonly key: KeyObject;
  private session?: ClientHttp2Session;
  private token?: { value: string; issuedAt: number };

  constructor(private readonly config: ApnsConfig) {
    super();
    // .env keeps the key on one line with \n escapes.
    this.key = createPrivateKey(config.privateKey.replace(/\\n/g, '\n'));
  }

  async send(message: PushMessage): Promise<PushResult> {
    const first = await this.request(message);
    if (first.status === 403 && first.reason === 'ExpiredProviderToken') {
      this.token = undefined;
      return this.result(await this.request(message));
    }
    return this.result(first);
  }

  onModuleDestroy(): void {
    this.session?.close();
  }

  private result(response: { status: number; reason: string }): PushResult {
    if (response.status === 200) return { status: 'ok' };
    if (response.status === 410 || DEAD_TOKEN.has(response.reason)) {
      return { status: 'invalid_token', reason: response.reason };
    }
    if (response.status === 403) {
      // A wrong key, team or topic: every push fails until the configuration is fixed.
      this.logger.error(`APNs refused the provider token: ${response.reason}`);
    }
    return { status: 'retry', reason: response.reason };
  }

  private request(
    message: PushMessage,
  ): Promise<{ status: number; reason: string }> {
    return new Promise((resolve) => {
      let session: ClientHttp2Session;
      try {
        session = this.connection();
      } catch (error) {
        resolve({ status: 0, reason: (error as Error).message });
        return;
      }
      const request = session.request({
        ':method': 'POST',
        ':path': `/3/device/${message.token}`,
        authorization: `bearer ${this.providerToken()}`,
        'apns-topic': this.config.topic,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-expiration': String(
          Math.floor(message.expiresAt.getTime() / 1000),
        ),
        'content-type': 'application/json',
      });
      let status = 0;
      let body = '';
      request.setEncoding('utf8');
      request.setTimeout(REQUEST_TIMEOUT_MS, () => request.close());
      request.on('response', (headers) => {
        status = Number(headers[':status']);
      });
      request.on('data', (chunk: string) => (body += chunk));
      request.on('error', (error) =>
        resolve({ status: 0, reason: error.message }),
      );
      request.on('close', () => {
        let reason = status === 0 ? 'Timeout' : '';
        try {
          reason = (JSON.parse(body) as { reason?: string }).reason ?? reason;
        } catch {
          // 200 has no body
        }
        resolve({ status, reason });
      });
      request.end(JSON.stringify(message.payload));
    });
  }

  private connection(): ClientHttp2Session {
    if (!this.session || this.session.closed || this.session.destroyed) {
      const session = connect(this.config.host);
      // Errors also reach the requests; a broken session is replaced on the next push.
      session.on('error', (error) =>
        this.logger.warn(`APNs connection: ${error.message}`),
      );
      session.on('goaway', () => session.close());
      this.session = session;
    }
    return this.session;
  }

  private providerToken(): string {
    const now = Date.now();
    if (!this.token || now - this.token.issuedAt > TOKEN_LIFETIME_MS) {
      this.token = {
        value: providerToken(
          this.key,
          this.config.keyId,
          this.config.teamId,
          new Date(now),
        ),
        issuedAt: now,
      };
    }
    return this.token.value;
  }
}
