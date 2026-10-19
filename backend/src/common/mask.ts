/** `john.doe@gmail.com` -> `j***@gmail.com`, for logs. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) {
    return '***';
  }
  return `${email[0]}***${email.slice(at)}`;
}

/** Lower-cased and trimmed, so `John@Mail.com ` and `john@mail.com` are one address. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
