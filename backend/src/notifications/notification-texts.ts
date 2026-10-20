import { type CalendarDate, daysBetween } from '../common/dates.js';
import type { LanguageCode } from '../generated/prisma/enums.js';

/** What a push shows: a short title and one or two sentences. */
export interface PushText {
  title: string;
  body: string;
}

export interface CurrencyInfo {
  code: string;
  decimals: number;
  symbol: string;
}

const LOCALE: Record<LanguageCode, string> = {
  uz: 'uz-Latn',
  ru: 'ru',
  en: 'en',
};
const SUM: Record<LanguageCode, string> = { uz: 'soʻm', ru: 'сум', en: 'sum' };
const NBSP = ' ';

const numberFormats = new Map<string, Intl.NumberFormat>();

/** «1 250 000 сум», «12,50 $»: grouped the language's way, as the app shows sums. */
export function money(
  amount: { toString(): string } | number,
  currency: CurrencyInfo,
  language: LanguageCode,
): string {
  const key = `${language}:${currency.decimals}`;
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(LOCALE[language], {
      minimumFractionDigits: currency.decimals,
      maximumFractionDigits: currency.decimals,
    });
    numberFormats.set(key, format);
  }
  const name = currency.code === 'UZS' ? SUM[language] : currency.symbol;
  return `${format.format(Number(amount.toString()))}${NBSP}${name}`;
}

/** «27 октября», «27-oktabr», «October 27». */
export function day(date: CalendarDate, language: LanguageCode): string {
  return new Intl.DateTimeFormat(LOCALE[language], {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
}

const percent = (value: number, language: LanguageCode) =>
  language === 'en' ? `${value}%` : `${value}${NBSP}%`;

const quoted = (title: string, language: LanguageCode) =>
  language === 'en' ? `“${title}”` : `«${title}»`;

export function dailyReminder(language: LanguageCode): PushText {
  return {
    uz: {
      title: 'Bugungi xarajatlarni yozing',
      body: 'Bugun hali amallar yoʻq — bir necha bosish kifoya.',
    },
    ru: {
      title: 'Запишите траты дня',
      body: 'Сегодня ещё нет операций — это пара касаний.',
    },
    en: {
      title: 'Record today’s spending',
      body: 'No operations today yet — it takes a couple of taps.',
    },
  }[language];
}

export function smartSave(
  input: { amount: string; goal: string; emoji: string },
  language: LanguageCode,
): PushText {
  const goal = quoted(input.goal, language);
  return {
    uz: {
      title: `${input.amount} ajratasizmi?`,
      body: `Bugun ${goal} ${input.emoji} maqsadi uchun xavfsiz summa.`,
    },
    ru: {
      title: `Отложить ${input.amount}?`,
      body: `Это безопасная сумма на сегодня для цели ${goal} ${input.emoji}.`,
    },
    en: {
      title: `Set aside ${input.amount}?`,
      body: `A safe amount for today toward ${goal} ${input.emoji}.`,
    },
  }[language];
}

export function recurringDue(
  input: {
    title: string;
    amount: string;
    income: boolean;
    date: CalendarDate;
    today: CalendarDate;
  },
  language: LanguageCode,
): PushText {
  const title = `${input.title} — ${input.amount}`;
  const ahead = daysBetween(input.today, input.date);
  const on = day(input.date, language);
  if (ahead < 0) {
    return {
      uz: {
        title,
        body: input.income
          ? `Tushum ${on}da kutilgan edi. Yozib qoʻyasizmi?`
          : `Toʻlov ${on}da kutilgan edi. Yozib qoʻyasizmi?`,
      },
      ru: {
        title,
        body: input.income
          ? `Поступление ожидалось ${on}. Записать?`
          : `Списание ожидалось ${on}. Записать?`,
      },
      en: {
        title,
        body: input.income
          ? `Was expected on ${on}. Record it?`
          : `Was due on ${on}. Record it?`,
      },
    }[language];
  }
  const when = {
    uz: ahead === 0 ? 'bugun' : ahead === 1 ? 'ertaga' : `${on}da`,
    ru: ahead === 0 ? 'сегодня' : ahead === 1 ? 'завтра' : on,
    en: ahead === 0 ? 'today' : ahead === 1 ? 'tomorrow' : `on ${on}`,
  }[language];
  return {
    uz: {
      title,
      body: input.income
        ? `Tushum ${when}. Olganingizdan keyin «Yozish»ni bosing.`
        : `Toʻlov ${when}. Toʻlaganingizdan keyin «Yozish»ni bosing.`,
    },
    ru: {
      title,
      body: input.income
        ? `Поступление ${when}. Нажмите «Записать», когда получите.`
        : `Списание ${when}. Нажмите «Записать», когда оплатите.`,
    },
    en: {
      title,
      body: input.income
        ? `Expected ${when}. Tap “Record” once it arrives.`
        : `Due ${when}. Tap “Record” once you’ve paid.`,
    },
  }[language];
}

export function goalMilestone(
  input: {
    goal: string;
    emoji: string;
    percent: number;
    saved: string;
    target: string;
  },
  language: LanguageCode,
): PushText {
  const goal = quoted(input.goal, language);
  if (input.percent >= 100) {
    return {
      uz: {
        title: `${goal} maqsadiga erishildi ${input.emoji}`,
        body: `Toʻplandi: ${input.saved}. Keyingi maqsadni tanlash vaqti.`,
      },
      ru: {
        title: `Цель ${goal} достигнута ${input.emoji}`,
        body: `Накоплено ${input.saved}. Пора выбрать следующую цель.`,
      },
      en: {
        title: `Goal ${goal} reached ${input.emoji}`,
        body: `You saved ${input.saved}. Time to pick the next goal.`,
      },
    }[language];
  }
  const title = `${input.emoji} ${goal}: ${percent(input.percent, language)}`;
  return {
    uz: {
      title,
      body: `Toʻplandi: ${input.saved} / ${input.target}. Shu zaylda davom eting!`,
    },
    ru: {
      title,
      body: `Накоплено ${input.saved} из ${input.target}. Так держать!`,
    },
    en: {
      title,
      body: `Saved ${input.saved} of ${input.target}. Keep it up!`,
    },
  }[language];
}

export function goalDeadline(
  input: {
    goal: string;
    emoji: string;
    remaining: string;
    deadline: CalendarDate;
  },
  language: LanguageCode,
): PushText {
  const goal = quoted(input.goal, language);
  const on = day(input.deadline, language);
  return {
    uz: {
      title: `${input.emoji} ${goal}: muddatga bir hafta qoldi`,
      body: `${on}gacha yana ${input.remaining} toʻplash kerak.`,
    },
    ru: {
      title: `${input.emoji} ${goal}: неделя до срока`,
      body: `Осталось накопить ${input.remaining} до ${on}.`,
    },
    en: {
      title: `${input.emoji} ${goal}: one week left`,
      body: `${input.remaining} to go by ${on}.`,
    },
  }[language];
}

/**
 * A limit crossed: `category` is the category's name, null for the month's total limit.
 * `percent` 100 means the limit is used up, more — overspent; below — the alert threshold.
 */
export function budgetAlert(
  input: {
    category: string | null;
    percent: number;
    spent: string;
    limit: string;
  },
  language: LanguageCode,
): PushText {
  const pct = percent(input.percent, language);
  const name = input.category;
  const title =
    input.percent > 100
      ? name
        ? {
            uz: `${name}: limitdan oshdi`,
            ru: `${name}: лимит превышен`,
            en: `${name}: over the limit`,
          }
        : {
            uz: 'Oylik byudjetdan oshdi',
            ru: 'Бюджет месяца превышен',
            en: 'Monthly budget exceeded',
          }
      : input.percent === 100
        ? name
          ? {
              uz: `${name}: limit tugadi`,
              ru: `${name}: лимит исчерпан`,
              en: `${name}: limit reached`,
            }
          : {
              uz: 'Oylik byudjet tugadi',
              ru: 'Бюджет месяца исчерпан',
              en: 'Monthly budget used up',
            }
        : name
          ? {
              uz: `${name}: limitning ${pct}`,
              ru: `${name}: ${pct} лимита`,
              en: `${name}: ${pct} of the limit`,
            }
          : {
              uz: `Oylik byudjet: ${pct}`,
              ru: `Бюджет месяца: ${pct}`,
              en: `Monthly budget: ${pct}`,
            };
  const body = {
    uz: `Bu oy sarflandi: ${input.spent} / ${input.limit}.`,
    ru: `Потрачено ${input.spent} из ${input.limit} в этом месяце.`,
    en: `Spent ${input.spent} of ${input.limit} this month.`,
  };
  return { title: title[language], body: body[language] };
}

/** An auto-save rule set money aside: what and for which goal. */
export function autoSaveDone(
  input: {
    goal: string;
    emoji: string;
    amount: string;
    type: 'fixed_schedule' | 'percent_of_income' | 'round_up';
    percent: string | null;
  },
  language: LanguageCode,
): PushText {
  const goal = quoted(input.goal, language);
  const pct = percent(Number(input.percent ?? 0), language);
  const body = {
    fixed_schedule: {
      uz: 'Jadval boʻyicha ajratildi.',
      ru: 'Отложено по расписанию.',
      en: 'Set aside on schedule.',
    },
    percent_of_income: {
      uz: `Daromadning ${pct} qismi ajratildi.`,
      ru: `Отложено ${pct} от дохода.`,
      en: `${pct} of the income set aside.`,
    },
    round_up: {
      uz: 'Xariddan qolgan qaytim ajratildi.',
      ru: 'Отложена сдача от покупки.',
      en: 'Spare change from a purchase set aside.',
    },
  }[input.type][language];
  return {
    title: `${input.emoji} ${goal}: +${input.amount}`,
    body,
  };
}

/** An auto-save run found too little money on its account and did nothing. */
export function autoSaveSkipped(
  input: { goal: string; emoji: string; account: string; amount: string },
  language: LanguageCode,
): PushText {
  const goal = quoted(input.goal, language);
  const account = quoted(input.account, language);
  return {
    uz: {
      title: `${input.emoji} ${goal}: badal oʻtkazib yuborildi`,
      body: `${account} hisobida ${input.amount} yetmadi.`,
    },
    ru: {
      title: `${input.emoji} ${goal}: взнос пропущен`,
      body: `На счёте ${account} не хватило ${input.amount}.`,
    },
    en: {
      title: `${input.emoji} ${goal}: deposit skipped`,
      body: `${account} didn’t have ${input.amount}.`,
    },
  }[language];
}
