import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { maskEmail } from '../common/mask.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Injection token and contract for outgoing email. */
export abstract class MailSender {
  abstract send(message: MailMessage): Promise<void>;
}

/** Development only: prints the message (including login codes) to the log. */
export class ConsoleMailSender extends MailSender {
  private readonly logger = new Logger('ConsoleMailSender');

  async send(message: MailMessage): Promise<void> {
    this.logger.log(
      `Email to ${maskEmail(message.to)} — ${message.subject}\n${message.text}`,
    );
  }
}

/** https://resend.com/docs/api-reference/emails/send-email */
export class ResendMailSender extends MailSender {
  private readonly logger = new Logger('ResendMailSender');

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {
    super();
  }

  async send(message: MailMessage): Promise<void> {
    let response: Response;
    try {
      response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      this.logger.error(
        `Resend request failed for ${maskEmail(message.to)}: ${(error as Error).name}`,
      );
      throw new ServiceUnavailableException({
        code: 'email_unavailable',
        message: 'Email service is unavailable',
      });
    }

    if (!response.ok) {
      this.logger.error(
        `Resend rejected email to ${maskEmail(message.to)}: HTTP ${response.status}`,
      );
      throw new ServiceUnavailableException({
        code: 'email_unavailable',
        message: 'Email service is unavailable',
      });
    }
  }
}
