import type { LanguageCode } from '../generated/prisma/enums.js';

/**
 * What an insight says. Claude writes it from the facts below in the user's language; these
 * templates say the same from the same facts when the model is not set up or fails, so an
 * insight never waits on the AI.
 */
export interface InsightText {
  title: string;
  summary: string;
  recommendation: string;
}

/** Amounts arrive formatted in the user's language («1 250 000 сум»). */
export interface ReportFacts {
  /** «12–18 октября», «сентябрь» */
  period: string;
  expense: string;
  income: string;
  /** Spending against the period before, rounded percent; null when it had none */
  changePercent: number | null;
  topCategory: { name: string; amount: string; sharePercent: number } | null;
  biggestIncrease: {
    name: string;
    amount: string;
    changePercent: number | null;
  } | null;
}

export interface AnomalyFacts {
  amount: string;
  median: string;
  ratio: number;
  category: string;
  /** «18 октября» */
  date: string;
  note: string | null;
}

export interface ForecastFacts {
  forecast: string;
  plan: string;
  /** By how much the month ends over (positive) or under (negative) the plan */
  difference: string;
  verdict: 'over' | 'within';
  daysLeft: number;
  /** What a day may cost from now on to end within the plan */
  perDayToStay: string;
}

export interface GoalFacts {
  title: string;
  progress: number;
  saved: string;
  target: string;
  score: number;
  status: 'on_track' | 'behind' | 'ahead' | 'no_deadline' | 'reached';
  perMonth: string | null;
  deadline: string | null;
  monthsWithDeposits: number;
}

export interface TipFacts {
  situation:
    | 'no_income'
    | 'overspent'
    | 'top_category'
    | 'goal_behind'
    | 'goal_ahead'
    | 'steady';
  safeToSpend: string;
  dailyLimit: string;
  daysLeft: number;
  overBy?: string;
  category?: { name: string; sharePercent: number };
  goal?: { title: string; perDay: string };
}

type Texts<F> = Record<LanguageCode, (facts: F) => InsightText>;

const pct = (value: number, language: LanguageCode) =>
  language === 'en' ? `${value}%` : `${value} %`;
const signed = (value: number, language: LanguageCode) =>
  (value > 0 ? '+' : value < 0 ? '−' : '') + pct(Math.abs(value), language);
const q = (text: string, language: LanguageCode) =>
  language === 'en' ? `“${text}”` : `«${text}»`;

function reportTexts(weekly: boolean): Texts<ReportFacts> {
  return {
    ru: (f) => ({
      title: `${weekly ? 'Неделя' : 'Месяц'} ${f.period}: ${f.expense}`,
      summary:
        `Расходы — ${f.expense}, доходы — ${f.income}` +
        (f.changePercent === null
          ? '.'
          : `, траты ${signed(f.changePercent, 'ru')} к прошлому ${weekly ? 'неделе' : 'месяцу'}.`) +
        (f.topCategory
          ? ` Больше всего ушло на ${q(f.topCategory.name, 'ru')}: ${f.topCategory.amount} (${pct(f.topCategory.sharePercent, 'ru')}).`
          : ''),
      recommendation: f.biggestIncrease
        ? `Сильнее всего выросла категория ${q(f.biggestIncrease.name, 'ru')} — поставьте на неё лимит в бюджете.`
        : f.topCategory
          ? `Присмотритесь к ${q(f.topCategory.name, 'ru')}: даже 10 % экономии там заметны за месяц.`
          : `Записывайте все траты — так отчёт станет точнее.`,
    }),
    uz: (f) => ({
      title: `${weekly ? 'Hafta' : 'Oy'} ${f.period}: ${f.expense}`,
      summary:
        `Xarajatlar — ${f.expense}, daromadlar — ${f.income}` +
        (f.changePercent === null
          ? '.'
          : `, xarajatlar oʻtgan ${weekly ? 'haftaga' : 'oyga'} nisbatan ${signed(f.changePercent, 'uz')}.`) +
        (f.topCategory
          ? ` Eng koʻp ${q(f.topCategory.name, 'uz')} ga ketdi: ${f.topCategory.amount} (${pct(f.topCategory.sharePercent, 'uz')}).`
          : ''),
      recommendation: f.biggestIncrease
        ? `${q(f.biggestIncrease.name, 'uz')} toifasi eng koʻp oshdi — byudjetda unga limit qoʻying.`
        : f.topCategory
          ? `${q(f.topCategory.name, 'uz')} ga eʼtibor bering: u yerda 10 % tejash ham oy davomida sezilarli.`
          : `Barcha xarajatlarni yozib boring — hisobot aniqroq boʻladi.`,
    }),
    en: (f) => ({
      title: `${weekly ? 'Week' : 'Month'} ${f.period}: ${f.expense}`,
      summary:
        `You spent ${f.expense} and earned ${f.income}` +
        (f.changePercent === null
          ? '.'
          : `; spending is ${signed(f.changePercent, 'en')} on last ${weekly ? 'week' : 'month'}.`) +
        (f.topCategory
          ? ` Most went on ${q(f.topCategory.name, 'en')}: ${f.topCategory.amount} (${pct(f.topCategory.sharePercent, 'en')}).`
          : ''),
      recommendation: f.biggestIncrease
        ? `${q(f.biggestIncrease.name, 'en')} grew the most — set a limit for it in your budget.`
        : f.topCategory
          ? `Look at ${q(f.topCategory.name, 'en')}: even 10% less there adds up over a month.`
          : `Record every expense so the next report is more accurate.`,
    }),
  };
}

export const WEEKLY_REPORT = reportTexts(true);
export const MONTHLY_REPORT = reportTexts(false);

export const ANOMALY: Texts<AnomalyFacts> = {
  ru: (f) => ({
    title: `Необычная трата: ${f.amount}`,
    summary: `${f.date} в категории ${q(f.category, 'ru')} — в ${f.ratio} раза больше обычного (обычно около ${f.median}).${f.note ? ` Заметка: ${f.note}.` : ''}`,
    recommendation: `Если это разовая покупка — всё в порядке; если нет, проверьте, не нужна ли категории своя граница в бюджете.`,
  }),
  uz: (f) => ({
    title: `Odatdan tashqari xarajat: ${f.amount}`,
    summary: `${f.date} ${q(f.category, 'uz')} toifasida — odatdagidan ${f.ratio} barobar koʻp (odatda taxminan ${f.median}).${f.note ? ` Izoh: ${f.note}.` : ''}`,
    recommendation: `Agar bu bir martalik xarid boʻlsa — hammasi joyida; aks holda toifaga byudjetda limit qoʻyishni oʻylab koʻring.`,
  }),
  en: (f) => ({
    title: `Unusual expense: ${f.amount}`,
    summary: `On ${f.date} in ${q(f.category, 'en')} — ${f.ratio} times the usual (typically about ${f.median}).${f.note ? ` Note: ${f.note}.` : ''}`,
    recommendation: `If it was a one-off, all is well; if not, consider a budget limit for this category.`,
  }),
};

export const BUDGET_FORECAST: Texts<ForecastFacts> = {
  ru: (f) =>
    f.verdict === 'over'
      ? {
          title: `Прогноз: перерасход ${f.difference}`,
          summary: `В таком темпе к концу месяца траты составят ${f.forecast} при плане ${f.plan}.`,
          recommendation: `Чтобы уложиться, тратьте не больше ${f.perDayToStay} в день оставшиеся ${f.daysLeft} дн.`,
        }
      : {
          title: `Прогноз: укладываетесь в план`,
          summary: `В таком темпе к концу месяца траты составят ${f.forecast} при плане ${f.plan} — останется ${f.difference}.`,
          recommendation: `Остаток можно отложить в цель — Smart Save подскажет сумму.`,
        },
  uz: (f) =>
    f.verdict === 'over'
      ? {
          title: `Prognoz: ${f.difference} ortiqcha sarf`,
          summary: `Shu surʼatda oy oxirigacha xarajatlar ${f.plan} rejaga nisbatan ${f.forecast} boʻladi.`,
          recommendation: `Rejaga sigʻish uchun qolgan ${f.daysLeft} kunda kuniga ${f.perDayToStay} dan koʻp sarflamang.`,
        }
      : {
          title: `Prognoz: rejaga sigʻyapsiz`,
          summary: `Shu surʼatda oy oxirigacha xarajatlar ${f.plan} rejaga nisbatan ${f.forecast} boʻladi — ${f.difference} qoladi.`,
          recommendation: `Qolgan pulni maqsadga ajratish mumkin — Smart Save summani taklif qiladi.`,
        },
  en: (f) =>
    f.verdict === 'over'
      ? {
          title: `Forecast: over by ${f.difference}`,
          summary: `At this pace the month ends with ${f.forecast} spent against a plan of ${f.plan}.`,
          recommendation: `To stay within it, keep to ${f.perDayToStay} a day for the remaining ${f.daysLeft} days.`,
        }
      : {
          title: `Forecast: within the plan`,
          summary: `At this pace the month ends with ${f.forecast} spent against a plan of ${f.plan}, ${f.difference} to spare.`,
          recommendation: `Put the spare money into a goal — Smart Save suggests the amount.`,
        },
};

export const GOAL_ANALYSIS: Texts<GoalFacts> = {
  ru: (f) => ({
    title: `${q(f.title, 'ru')}: ${f.score} из 100`,
    summary:
      `Накоплено ${f.saved} из ${f.target} (${pct(f.progress, 'ru')}). ` +
      {
        on_track: `Идёте по графику${f.deadline ? ` к ${f.deadline}` : ''}.`,
        behind: `Отстаёте от графика${f.deadline ? ` к ${f.deadline}` : ''}.`,
        ahead: `Опережаете график${f.deadline ? ` к ${f.deadline}` : ''}.`,
        no_deadline: `Срока нет; взносы были в ${f.monthsWithDeposits} из последних 3 месяцев.`,
        reached: `Цель достигнута.`,
      }[f.status],
    recommendation:
      f.status === 'reached'
        ? `Выберите следующую цель — привычка откладывать уже есть.`
        : f.perMonth
          ? `Откладывайте ${f.perMonth} в месяц — автонакопление сделает это само.`
          : `Поставьте срок: с ним видно, сколько откладывать в месяц.`,
  }),
  uz: (f) => ({
    title: `${q(f.title, 'uz')}: 100 dan ${f.score}`,
    summary:
      `${f.target} dan ${f.saved} jamgʻarildi (${pct(f.progress, 'uz')}). ` +
      {
        on_track: `Jadval boʻyicha ketyapsiz${f.deadline ? ` (${f.deadline} gacha)` : ''}.`,
        behind: `Jadvaldan ortda qolyapsiz${f.deadline ? ` (${f.deadline} gacha)` : ''}.`,
        ahead: `Jadvaldan oldindasiz${f.deadline ? ` (${f.deadline} gacha)` : ''}.`,
        no_deadline: `Muddat yoʻq; oxirgi 3 oyning ${f.monthsWithDeposits} tasida badal boʻlgan.`,
        reached: `Maqsadga erishildi.`,
      }[f.status],
    recommendation:
      f.status === 'reached'
        ? `Keyingi maqsadni tanlang — jamgʻarish odati allaqachon bor.`
        : f.perMonth
          ? `Oyiga ${f.perMonth} ajrating — avto jamgʻarma buni oʻzi qiladi.`
          : `Muddat qoʻying: shunda oyiga qancha ajratish kerakligi koʻrinadi.`,
  }),
  en: (f) => ({
    title: `${q(f.title, 'en')}: ${f.score} out of 100`,
    summary:
      `${f.saved} of ${f.target} saved (${pct(f.progress, 'en')}). ` +
      {
        on_track: `You are on track${f.deadline ? ` for ${f.deadline}` : ''}.`,
        behind: `You are behind schedule${f.deadline ? ` for ${f.deadline}` : ''}.`,
        ahead: `You are ahead of schedule${f.deadline ? ` for ${f.deadline}` : ''}.`,
        no_deadline: `No deadline; deposits came in ${f.monthsWithDeposits} of the last 3 months.`,
        reached: `The goal is reached.`,
      }[f.status],
    recommendation:
      f.status === 'reached'
        ? `Pick the next goal — the saving habit is already there.`
        : f.perMonth
          ? `Set aside ${f.perMonth} a month — auto-save can do it for you.`
          : `Set a deadline to see how much to save each month.`,
  }),
};

export const DAILY_TIP: Texts<TipFacts> = {
  ru: (f) =>
    ({
      no_income: {
        title: `Добавьте доход месяца`,
        summary: `Без дохода Lunex не может посчитать, сколько можно тратить в день.`,
        recommendation: `Запишите зарплату или укажите план дохода в бюджете.`,
      },
      overspent: {
        title: `Сегодня лимит превышен на ${f.overBy}`,
        summary: `Лимит на день — ${f.dailyLimit}; до конца месяца ${f.daysLeft} дн., и следующие дни станут чуть строже.`,
        recommendation: `Отложите необязательные покупки до завтра.`,
      },
      top_category: {
        title: `${q(f.category?.name ?? '', 'ru')} — ${pct(f.category?.sharePercent ?? 0, 'ru')} трат`,
        summary: `Больше всего в этом месяце уходит на ${q(f.category?.name ?? '', 'ru')}. Сегодня можно потратить ${f.safeToSpend}.`,
        recommendation: `Попробуйте один день без трат в этой категории — разница будет видна в бюджете.`,
      },
      goal_behind: {
        title: `${q(f.goal?.title ?? '', 'ru')} отстаёт от графика`,
        summary: `Чтобы догнать, нужно около ${f.goal?.perDay} в день. Сегодня можно потратить ${f.safeToSpend}.`,
        recommendation: `Отложите хотя бы часть сегодня — Smart Save подскажет безопасную сумму.`,
      },
      goal_ahead: {
        title: `${q(f.goal?.title ?? '', 'ru')} впереди графика`,
        summary: `Вы откладываете быстрее плана. Сегодня можно потратить ${f.safeToSpend}.`,
        recommendation: `Держите темп — или поставьте следующую цель.`,
      },
      steady: {
        title: `Сегодня можно потратить ${f.safeToSpend}`,
        summary: `Лимит на день — ${f.dailyLimit}, до конца месяца ${f.daysLeft} дн.`,
        recommendation: `Записывайте траты сразу — так лимит остаётся точным.`,
      },
    })[f.situation],
  uz: (f) =>
    ({
      no_income: {
        title: `Oylik daromadni qoʻshing`,
        summary: `Daromadsiz Lunex kuniga qancha sarflash mumkinligini hisoblay olmaydi.`,
        recommendation: `Maoshni yozing yoki byudjetda daromad rejasini kiriting.`,
      },
      overspent: {
        title: `Bugun limit ${f.overBy} ga oshdi`,
        summary: `Kunlik limit — ${f.dailyLimit}; oy oxirigacha ${f.daysLeft} kun, keyingi kunlar biroz qatʼiyroq boʻladi.`,
        recommendation: `Majburiy boʻlmagan xaridlarni ertaga qoldiring.`,
      },
      top_category: {
        title: `${q(f.category?.name ?? '', 'uz')} — xarajatlarning ${pct(f.category?.sharePercent ?? 0, 'uz')}`,
        summary: `Bu oy eng koʻp ${q(f.category?.name ?? '', 'uz')} ga ketyapti. Bugun ${f.safeToSpend} sarflash mumkin.`,
        recommendation: `Bu toifada bir kun xarajatsiz yashab koʻring — farq byudjetda koʻrinadi.`,
      },
      goal_behind: {
        title: `${q(f.goal?.title ?? '', 'uz')} jadvaldan ortda`,
        summary: `Yetib olish uchun kuniga taxminan ${f.goal?.perDay} kerak. Bugun ${f.safeToSpend} sarflash mumkin.`,
        recommendation: `Bugun hech boʻlmasa bir qismini ajrating — Smart Save xavfsiz summani aytadi.`,
      },
      goal_ahead: {
        title: `${q(f.goal?.title ?? '', 'uz')} jadvaldan oldinda`,
        summary: `Rejadan tezroq jamgʻaryapsiz. Bugun ${f.safeToSpend} sarflash mumkin.`,
        recommendation: `Surʼatni saqlang — yoki keyingi maqsadni qoʻying.`,
      },
      steady: {
        title: `Bugun ${f.safeToSpend} sarflash mumkin`,
        summary: `Kunlik limit — ${f.dailyLimit}, oy oxirigacha ${f.daysLeft} kun.`,
        recommendation: `Xarajatlarni darhol yozing — shunda limit aniq qoladi.`,
      },
    })[f.situation],
  en: (f) =>
    ({
      no_income: {
        title: `Add this month's income`,
        summary: `Without an income Lunex cannot work out what you can spend a day.`,
        recommendation: `Record your salary or set a planned income in the budget.`,
      },
      overspent: {
        title: `Today's limit is over by ${f.overBy}`,
        summary: `The daily limit is ${f.dailyLimit}; ${f.daysLeft} days are left this month, and the next ones get a little tighter.`,
        recommendation: `Put off anything that can wait until tomorrow.`,
      },
      top_category: {
        title: `${q(f.category?.name ?? '', 'en')} is ${pct(f.category?.sharePercent ?? 0, 'en')} of spending`,
        summary: `Most of this month's money goes on ${q(f.category?.name ?? '', 'en')}. Today you can spend ${f.safeToSpend}.`,
        recommendation: `Try a day without spending in this category — the budget will show it.`,
      },
      goal_behind: {
        title: `${q(f.goal?.title ?? '', 'en')} is behind schedule`,
        summary: `Catching up takes about ${f.goal?.perDay} a day. Today you can spend ${f.safeToSpend}.`,
        recommendation: `Set aside at least a part today — Smart Save suggests a safe amount.`,
      },
      goal_ahead: {
        title: `${q(f.goal?.title ?? '', 'en')} is ahead of schedule`,
        summary: `You are saving faster than planned. Today you can spend ${f.safeToSpend}.`,
        recommendation: `Keep the pace — or set your next goal.`,
      },
      steady: {
        title: `Today you can spend ${f.safeToSpend}`,
        summary: `The daily limit is ${f.dailyLimit}, with ${f.daysLeft} days left this month.`,
        recommendation: `Record expenses right away to keep the limit accurate.`,
      },
    })[f.situation],
};
