import { spawn } from 'node:child_process';
import { Logger } from '@nestjs/common';

export interface PushMessage {
  /** APNs device token, hex */
  token: string;
  payload: Record<string, unknown>;
  /** APNs drops the push if the device is offline until then */
  expiresAt: Date;
}

/**
 * `ok` — APNs took it; `invalid_token` — the app was removed or the token belongs to another
 * environment, so the device stops getting pushes; `retry` — try again later.
 */
export type PushResult =
  | { status: 'ok' }
  | { status: 'invalid_token'; reason: string }
  | { status: 'retry'; reason: string };

/** Injection token and contract for push delivery. */
export abstract class PushSender {
  abstract send(message: PushMessage): Promise<PushResult>;
}

const tail = (token: string) => `…${token.slice(-6)}`;

/** No APNs key yet (or development): the push is only written to the log. */
export class LogPushSender extends PushSender {
  private readonly logger = new Logger('LogPushSender');

  async send(message: PushMessage): Promise<PushResult> {
    const lunex = message.payload.lunex as { type?: string } | undefined;
    this.logger.log(`Push ${lunex?.type ?? '?'} to ${tail(message.token)}`);
    return { status: 'ok' };
  }
}

/**
 * Development on a Mac: `xcrun simctl push` hands the payload to the app in a simulator, the
 * way APNs would. Refused in production by env validation.
 */
export class SimulatorPushSender extends PushSender {
  private readonly logger = new Logger('SimulatorPushSender');

  constructor(
    private readonly device: string,
    private readonly topic: string,
  ) {
    super();
  }

  send(message: PushMessage): Promise<PushResult> {
    return new Promise((resolve) => {
      const child = spawn('xcrun', [
        'simctl',
        'push',
        this.device,
        this.topic,
        '-',
      ]);
      let output = '';
      child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
      child.on('error', (error) =>
        resolve({ status: 'retry', reason: error.message }),
      );
      child.on('close', (code) => {
        if (code === 0) {
          this.logger.log(`Pushed to simulator ${this.device}`);
          resolve({ status: 'ok' });
        } else {
          resolve({ status: 'retry', reason: output.trim() || `exit ${code}` });
        }
      });
      child.stdin.end(JSON.stringify(message.payload));
    });
  }
}
