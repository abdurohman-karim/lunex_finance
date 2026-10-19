import { z } from 'zod';
import { uuidSchema } from '../common/schemas.js';

export const languageSchema = z.enum(['uz', 'ru', 'en']);

/** The installation's id (kept in the Keychain) and what it runs; one refresh-token family per device. */
export const deviceSchema = z.object({
  id: uuidSchema,
  model: z.string().max(64).optional(),
  osVersion: z.string().max(32).optional(),
  appVersion: z.string().max(32).optional(),
});
export type DeviceInput = z.infer<typeof deviceSchema>;

const signInBase = {
  device: deviceSchema,
  /** Language for a new account; ignored for existing ones */
  language: languageSchema.optional(),
};

export const appleCredentialSchema = z.object({
  identityToken: z.string().min(1),
  /** The raw nonce; the token must carry its SHA-256 */
  nonce: z.string().min(16).max(128),
  /** Apple sends the name to the app only on the first authorisation */
  displayName: z.string().trim().max(128).optional(),
});
export const appleSignInSchema = appleCredentialSchema.extend(signInBase);

export const googleCredentialSchema = z.object({
  idToken: z.string().min(1),
});
export const googleSignInSchema = googleCredentialSchema.extend(signInBase);

/** Fields Telegram Login returns (https://core.telegram.org/widgets/login#receiving-authorization-data) */
export const telegramAuthDataSchema = z.object({
  id: z.number().int().positive(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  username: z.string().optional(),
  photo_url: z.string().optional(),
  auth_date: z.number().int().positive(),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type TelegramAuthData = z.infer<typeof telegramAuthDataSchema>;

export const telegramCredentialSchema = z.object({
  authData: telegramAuthDataSchema,
});
export const telegramSignInSchema = telegramCredentialSchema.extend(signInBase);

export const emailStartSchema = z.object({
  email: z.email().max(255),
  language: languageSchema.optional(),
});

export const emailCredentialSchema = z.object({
  email: z.email().max(255),
  code: z.string().regex(/^\d{6}$/),
});
export const emailSignInSchema = emailCredentialSchema.extend(signInBase);

export const refreshSchema = z.object({
  refreshToken: z.string().min(1).max(256),
});

export const linkIdentitySchema = z.discriminatedUnion('provider', [
  appleCredentialSchema.extend({ provider: z.literal('apple') }),
  googleCredentialSchema.extend({ provider: z.literal('google') }),
  telegramCredentialSchema.extend({ provider: z.literal('telegram') }),
  emailCredentialSchema.extend({ provider: z.literal('email') }),
]);
export type LinkIdentityInput = z.infer<typeof linkIdentitySchema>;

export const providerParamSchema = z.enum([
  'apple',
  'google',
  'telegram',
  'email',
]);
