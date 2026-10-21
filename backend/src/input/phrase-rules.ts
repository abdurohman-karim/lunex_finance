import { addDays, type CalendarDate } from '../common/dates.js';

/**
 * Turns a phrase into operations without the AI («кофе 25 тысяч», «зарплата 8 млн вчера»,
 * «taksi 30 ming», «обед 40 000 и такси 15 000»): amounts with their multipliers, the day,
 * income or expense, and a category by the user's own names, the system names in every
 * language, and common words. It answers when Claude is not set up, fails or the day's limit
 * is used up, so voice input always gives something to check.
 */

export type OperationType = 'income' | 'expense';

export interface CategoryOption {
  id: string;
  type: OperationType;
  /** System category key (`food`); null for the user's own */
  key: string | null;
  /** Its names: the user's own name, or a system category's label in every language */
  names: string[];
}

export interface ParsedOperation {
  type: OperationType;
  /** Decimal text, > 0 */
  amount: string;
  /** ISO code when the phrase names a currency («$», «долларов»); null: the account's own */
  currency: string | null;
  categoryId: string | null;
  date: CalendarDate;
  note: string | null;
  /** 0–1: how sure the reading is */
  confidence: number;
}

const MULTIPLIERS: [RegExp, number][] = [
  [/^(млрд|миллиард\p{L}*|milliard\p{L}*|billion\p{L}*|bn)$/u, 1e9],
  [/^(млн|миллион\p{L}*|mln|million\p{L}*|mio)$/u, 1e6],
  [/^(тыс\p{L}*|тысяч\p{L}*|к|k|ming|минг|thousand\p{L}*|th)$/u, 1e3],
];

const CURRENCIES: [RegExp, string | null][] = [
  [/^(сум\p{L}*|so'?m\p{L}*|som|sum|uzs)$/u, null],
  [/^(\$|долл\p{L}*|бакс\p{L}*|dollar\p{L}*|usd)$/u, 'USD'],
  [/^(€|евро|euro\p{L}*|eur|yevro)$/u, 'EUR'],
  [/^(₽|руб\p{L}*|rubl\p{L}*|rub)$/u, 'RUB'],
  [/^(тенге|tenge|kzt|₸)$/u, 'KZT'],
];

const DAYS: [RegExp, number][] = [
  [/^(позавчера)$/u, -2],
  [/^(вчера|kecha|yesterday)$/u, -1],
  [/^(сегодня|bugun|today)$/u, 0],
];

/** Words that carry nothing for the note. */
const FILLERS = new Set([
  'на',
  'за',
  'в',
  'во',
  'с',
  'со',
  'по',
  'для',
  'потратил',
  'потратила',
  'заплатил',
  'заплатила',
  'купил',
  'купила',
  'получил',
  'получила',
  'это',
  'было',
  'uchun',
  'ga',
  'da',
  'ni',
  'sarfladim',
  'toʻladim',
  "to'ladim",
  'oldim',
  'for',
  'on',
  'at',
  'spent',
  'paid',
  'bought',
  'got',
  'the',
  'a',
  'an',
  'of',
]);

/** Common words → system category keys; a stem matches the words it starts. */
const EXPENSE_WORDS: Record<string, string[]> = {
  cafe: [
    'кофе',
    'кафе',
    'кофейн',
    'ресторан',
    'капучино',
    'латте',
    'пицц',
    'бургер',
    'фастфуд',
    'шаурм',
    'qahva',
    'kofe',
    'kafe',
    'restoran',
    'coffee',
    'cafe',
    'restaurant',
    'latte',
    'pizza',
    'burger',
  ],
  food: [
    'обед',
    'ужин',
    'завтрак',
    'еда',
    'еду',
    'перекус',
    'ovqat',
    'tushlik',
    'nonushta',
    'kechki',
    'lunch',
    'dinner',
    'breakfast',
    'food',
    'meal',
    'snack',
  ],
  market: [
    'продукт',
    'супермаркет',
    'магазин',
    'корзинк',
    'макро',
    'базар',
    'рынок',
    'korzinka',
    'makro',
    'bozor',
    'oziq',
    'supermarket',
    'grocer',
    'market',
  ],
  transport: [
    'такси',
    'метро',
    'автобус',
    'бензин',
    'заправк',
    'транспорт',
    'проезд',
    'taksi',
    'metro',
    'avtobus',
    'benzin',
    'yoqilgʻi',
    "yoqilg'i",
    'transport',
    'taxi',
    'bus',
    'fuel',
    'uber',
    'subway',
  ],
  shopping: [
    'одежд',
    'обув',
    'покупк',
    'кроссовк',
    'kiyim',
    'poyabzal',
    'xarid',
    'clothes',
    'shoes',
    'shopping',
  ],
  subscriptions: [
    'подписк',
    'netflix',
    'spotify',
    'youtube',
    'icloud',
    'obuna',
    'subscription',
  ],
  fun: [
    'кино',
    'развлеч',
    'игр',
    'концерт',
    'kino',
    "o'yin",
    'oʻyin',
    'konsert',
    'cinema',
    'movie',
    'game',
    'concert',
  ],
  health: [
    'аптек',
    'лекарств',
    'врач',
    'клиник',
    'больниц',
    'apteka',
    'dori',
    'shifokor',
    'klinika',
    'pharmacy',
    'medicine',
    'doctor',
    'clinic',
  ],
  home: ['аренд', 'квартир', 'ijara', 'kvartira', 'rent', 'apartment'],
  utilities: [
    'коммунал',
    'свет',
    'электр',
    'газ',
    'интернет',
    'связь',
    'вода',
    'kommunal',
    'svet',
    'gaz',
    'internet',
    'utilities',
    'electricity',
    'water',
  ],
  education: [
    'курс',
    'учеб',
    'учёб',
    'книг',
    'школ',
    'университет',
    'репетитор',
    'kurs',
    "o'qish",
    'oʻqish',
    'kitob',
    'maktab',
    'course',
    'book',
    'school',
    'tuition',
  ],
  gifts: ['подарок', 'подарк', "sovg'a", 'sovgʻa', 'gift', 'present'],
};

const INCOME_WORDS: Record<string, string[]> = {
  salary: [
    'зарплат',
    'зп',
    'оклад',
    'аванс',
    'премия',
    'премию',
    'бонус',
    'maosh',
    'oylik',
    'salary',
    'paycheck',
    'wage',
    'bonus',
  ],
  business: ['бизнес', 'выручк', 'biznes', 'business', 'revenue'],
  sale: ['продал', 'продаж', 'sotdim', 'sotuv', 'sold', 'sale'],
  gift: ['подарил'],
  freelance: ['фриланс', 'frilans', 'freelance'],
  cashback: ['кешбэк', 'кэшбэк', 'кешбек', 'кэшбек', 'keshbek', 'cashback'],
  transfer: ['перевели', "o'tkazma", 'oʻtkazma', 'transfer'],
};

/** Income without a category of its own. */
const INCOME_MARKERS = [
  'доход',
  'получил',
  'пришл',
  'daromad',
  'income',
  'received',
  'earned',
];

const NUMBER = /\d+(?:[.,]\d+)?/y;

interface Token {
  text: string;
  start: number;
}

interface Amount {
  value: number;
  currency: string | null;
  /** The tokens it takes: the number, its multiplier and currency */
  used: Token[];
  /** Index of its last token in the piece */
  last: number;
}

/** Lower case, one kind of apostrophe, spaces inside digit groups dropped («40 000» → «40000»). */
export function normalize(text: string): string {
  let result = text
    .toLowerCase()
    .replace(/[ʻʼ’`‘]/g, "'")
    .replace(/ё/g, 'е')
    .replace(/(\d)\s*([$€₽₸])/g, '$1 $2')
    .replace(/([$€₽₸])\s*(\d)/g, '$1 $2');
  // «1 500 000»: a group of three digits after a space belongs to the number before it.
  for (;;) {
    const next = result.replace(/(\d)[   ](\d{3})(?!\d)/g, '$1$2');
    if (next === result) break;
    result = next;
  }
  return result;
}

function tokenize(segment: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /[$€₽₸]|\d+(?:[.,]\d+)?[\p{L}]*|[\p{L}']+/gu;
  for (const match of segment.matchAll(pattern)) {
    tokens.push({ text: match[0], start: match.index });
  }
  return tokens;
}

/** «25000», «1,5», «25.000» (a dot before three digits groups thousands), «25k». */
function numberOf(raw: string): { value: number; suffix: string } | null {
  NUMBER.lastIndex = 0;
  const match = NUMBER.exec(raw);
  if (!match) return null;
  let digits = match[0];
  if (/^\d{1,3}([.,]\d{3})+$/.test(digits) && !/[.,]\d{1,2}$/.test(digits)) {
    digits = digits.replace(/[.,]/g, '');
  }
  const value = Number(digits.replace(',', '.'));
  return Number.isFinite(value)
    ? { value, suffix: raw.slice(match[0].length) }
    : null;
}

function multiplierOf(word: string): number | null {
  for (const [pattern, factor] of MULTIPLIERS) {
    if (pattern.test(word)) return factor;
  }
  return null;
}

function currencyOf(word: string): string | null | undefined {
  for (const [pattern, code] of CURRENCIES) {
    if (pattern.test(word)) return code;
  }
  return undefined;
}

function dayOf(word: string): number | undefined {
  for (const [pattern, offset] of DAYS) {
    if (pattern.test(word)) return offset;
  }
  return undefined;
}

function amountsIn(tokens: Token[]): Amount[] {
  const amounts: Amount[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const parsed = numberOf(tokens[i].text);
    if (!parsed) continue;
    let value = parsed.value;
    let currency: string | null = null;
    const used = [i];
    // «25k», «8mln»: the multiplier written into the number.
    if (parsed.suffix) {
      const factor = multiplierOf(parsed.suffix);
      if (factor) value *= factor;
      else continue;
    }
    // The words after it: a multiplier, then a currency.
    let next = i + 1;
    if (!parsed.suffix && next < tokens.length) {
      const factor = multiplierOf(tokens[next].text);
      if (factor) {
        value *= factor;
        used.push(next++);
      }
    }
    if (next < tokens.length) {
      const code = currencyOf(tokens[next].text);
      if (code !== undefined) {
        currency = code;
        used.push(next);
      }
    }
    // «$ 25»: a currency before the number.
    if (i > 0 && currency === null) {
      const code = currencyOf(tokens[i - 1].text);
      if (code) {
        currency = code;
        used.push(i - 1);
      }
    }
    if (value > 0) {
      amounts.push({
        value,
        currency,
        used: used.map((index) => tokens[index]),
        last: Math.max(...used),
      });
    }
  }
  return amounts;
}

function matches(word: string, stem: string): boolean {
  return stem.length <= 3 ? word === stem : word.startsWith(stem);
}

/** The user's own categories first, then system names in any language, then common words. */
function categoryFor(
  words: string[],
  categories: CategoryOption[],
): { category: CategoryOption | null; income: boolean } {
  const phrase = ` ${words.join(' ')} `;
  const own = categories.filter((c) => c.key === null);
  const system = categories.filter((c) => c.key !== null);
  for (const option of [...own, ...system]) {
    for (const name of option.names) {
      const needle = normalize(name).trim();
      if (needle.length >= 3 && phrase.includes(` ${needle} `)) {
        return { category: option, income: option.type === 'income' };
      }
    }
  }
  const byKey = (type: OperationType, key: string) =>
    system.find((c) => c.type === type && c.key === key) ?? null;
  for (const [key, stems] of Object.entries(INCOME_WORDS)) {
    if (words.some((word) => stems.some((stem) => matches(word, stem)))) {
      return { category: byKey('income', key), income: true };
    }
  }
  const income = words.some((word) =>
    INCOME_MARKERS.some((stem) => matches(word, stem)),
  );
  for (const [key, stems] of Object.entries(EXPENSE_WORDS)) {
    if (words.some((word) => stems.some((stem) => matches(word, stem)))) {
      return { category: income ? null : byKey('expense', key), income };
    }
  }
  return { category: null, income };
}

function noteOf(words: string[]): string | null {
  const kept = words.filter((word) => !FILLERS.has(word));
  if (kept.length === 0) return null;
  const text = kept.join(' ').slice(0, 255);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Splits at «и», «va», «and», commas and semicolons. */
function segmentsOf(text: string): string[] {
  return text
    .split(/\s+(?:и|а также|плюс|va|hamda|and|plus)\s+|[;\n]+|,\s+/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function parsePhrase(
  text: string,
  today: CalendarDate,
  categories: CategoryOption[],
): ParsedOperation[] {
  const normalized = normalize(text);
  const parts: { tokens: Token[]; amount: Amount }[] = [];
  let pending: Token[] = [];
  let globalDay: number | undefined;

  // Words before an amount, and pieces without one, go with the amount that follows.
  for (const segment of segmentsOf(normalized)) {
    const tokens = tokenize(segment);
    const amounts = amountsIn(tokens);
    if (amounts.length === 0) {
      pending.push(...tokens);
      continue;
    }
    // Two amounts in one piece («кофе 25000 такси 15000»): each takes the words before it,
    // the last one also those after it.
    let from = 0;
    amounts.forEach((amount, index) => {
      const last = index === amounts.length - 1;
      const end = last ? tokens.length : amount.last + 1;
      parts.push({ tokens: [...pending, ...tokens.slice(from, end)], amount });
      pending = [];
      from = end;
    });
  }
  if (pending.length > 0 && parts.length > 0) {
    parts[parts.length - 1].tokens.push(...pending);
  }

  for (const part of parts) {
    for (const token of part.tokens) {
      const offset = dayOf(token.text);
      if (offset !== undefined && globalDay === undefined) globalDay = offset;
    }
  }

  return parts.map(({ tokens, amount }) => {
    const used = new Set(amount.used);
    let day: number | undefined;
    const words: string[] = [];
    tokens.forEach((token) => {
      if (used.has(token)) return;
      const offset = dayOf(token.text);
      if (offset !== undefined) {
        day = offset;
        return;
      }
      if (/^\d/.test(token.text) || currencyOf(token.text) !== undefined)
        return;
      words.push(token.text);
    });
    const { category, income } = categoryFor(words, categories);
    const type: OperationType =
      category?.type ?? (income ? 'income' : 'expense');
    return {
      type,
      amount: String(Math.round(amount.value * 100) / 100),
      currency: amount.currency,
      categoryId: category?.id ?? null,
      date: addDays(today, day ?? globalDay ?? 0),
      note: noteOf(words),
      confidence: category ? 0.7 : 0.5,
    };
  });
}
