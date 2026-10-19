import type { LanguageCode } from '../generated/prisma/enums.js';
import type { MailMessage } from './mail-sender.js';

const LOGIN_CODE_TEXT: Record<
  LanguageCode,
  { subject: string; intro: string; expiry: string; ignore: string }
> = {
  uz: {
    subject: 'Lunex Finance kirish kodi',
    intro: 'Lunex Finance ilovasiga kirish uchun kod:',
    expiry: 'Kod 10 daqiqa amal qiladi.',
    ignore: 'Agar kodni siz soʻramagan boʻlsangiz, bu xatga eʼtibor bermang.',
  },
  ru: {
    subject: 'Код для входа в Lunex Finance',
    intro: 'Код для входа в Lunex Finance:',
    expiry: 'Код действует 10 минут.',
    ignore: 'Если вы не запрашивали код, просто проигнорируйте это письмо.',
  },
  en: {
    subject: 'Your Lunex Finance sign-in code',
    intro: 'Your Lunex Finance sign-in code:',
    expiry: 'The code expires in 10 minutes.',
    ignore: 'If you did not request it, you can ignore this email.',
  },
};

export function loginCodeEmail(
  to: string,
  code: string,
  language: LanguageCode,
): MailMessage {
  const t = LOGIN_CODE_TEXT[language];
  return {
    to,
    subject: t.subject,
    text: `${t.intro}\n\n${code}\n\n${t.expiry}\n${t.ignore}`,
    html: [
      '<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:16px;color:#1c1c1e">',
      `<p>${t.intro}</p>`,
      `<p style="font-size:32px;font-weight:700;letter-spacing:6px">${code}</p>`,
      `<p>${t.expiry}</p>`,
      `<p style="color:#8e8e93;font-size:13px">${t.ignore}</p>`,
      '</div>',
    ].join(''),
  };
}
