import { Injectable } from '@nestjs/common';
import type { LinkIdentityInput } from './auth.schemas.js';
import type { VerifiedIdentity } from './auth.types.js';
import { EmailCodeService } from './email-code.service.js';
import { AppleVerifier } from './providers/apple.verifier.js';
import { GoogleVerifier } from './providers/google.verifier.js';
import { TelegramVerifier } from './providers/telegram.verifier.js';

/** Turns a provider credential from the app into a verified identity, or throws 401. */
@Injectable()
export class IdentityService {
  constructor(
    private readonly apple: AppleVerifier,
    private readonly google: GoogleVerifier,
    private readonly telegram: TelegramVerifier,
    private readonly emailCodes: EmailCodeService,
  ) {}

  async verify(credential: LinkIdentityInput): Promise<VerifiedIdentity> {
    switch (credential.provider) {
      case 'apple':
        return this.apple.verify(
          credential.identityToken,
          credential.nonce,
          credential.displayName,
        );
      case 'google':
        return this.google.verify(credential.idToken);
      case 'telegram':
        return this.telegram.verify(credential.authData);
      case 'email': {
        const email = await this.emailCodes.verify(
          credential.email,
          credential.code,
        );
        return {
          provider: 'email',
          subject: email,
          email,
          emailVerified: true,
        };
      }
    }
  }
}
