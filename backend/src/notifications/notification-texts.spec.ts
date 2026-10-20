import {
  budgetAlert,
  day,
  goalMilestone,
  money,
  recurringDue,
} from './notification-texts.js';

const UZS = { code: 'UZS', decimals: 0, symbol: 'soʻm' };
const USD = { code: 'USD', decimals: 2, symbol: '$' };
const plain = (text: string) => text.replace(/[  ]/g, ' ');

describe('notification texts', () => {
  it('write sums the way the app does', () => {
    expect(plain(money('1250000', UZS, 'ru'))).toBe('1 250 000 сум');
    expect(plain(money('1250000', UZS, 'uz'))).toBe('1 250 000 soʻm');
    expect(plain(money('1250000', UZS, 'en'))).toBe('1,250,000 sum');
    expect(plain(money('12.5', USD, 'ru'))).toBe('12,50 $');
  });

  it('name days in each language', () => {
    expect(day('2026-10-27', 'ru')).toBe('27 октября');
    expect(day('2026-10-27', 'uz')).toBe('27-oktabr');
    expect(day('2026-10-27', 'en')).toBe('October 27');
  });

  it('say when a payment is due', () => {
    const rent = (date: string) => ({
      title: 'Аренда',
      amount: '3 000 000 сум',
      income: false,
      date,
      today: '2026-10-20',
    });
    expect(recurringDue(rent('2026-10-20'), 'ru').body).toBe(
      'Списание сегодня. Нажмите «Записать», когда оплатите.',
    );
    expect(recurringDue(rent('2026-10-21'), 'uz').body).toBe(
      'Toʻlov ertaga. Toʻlaganingizdan keyin «Yozish»ni bosing.',
    );
    expect(recurringDue(rent('2026-10-23'), 'en').body).toBe(
      'Due on October 23. Tap “Record” once you’ve paid.',
    );
    expect(recurringDue(rent('2026-10-15'), 'ru').body).toBe(
      'Списание ожидалось 15 октября. Записать?',
    );
    expect(recurringDue(rent('2026-10-20'), 'ru').title).toBe(
      'Аренда — 3 000 000 сум',
    );
  });

  it('celebrate a milestone and the goal reached', () => {
    const phone = {
      goal: 'Телефон',
      emoji: '📱',
      saved: '3 000 000 сум',
      target: '6 000 000 сум',
    };
    expect(plain(goalMilestone({ ...phone, percent: 50 }, 'ru').title)).toBe(
      '📱 «Телефон»: 50 %',
    );
    expect(goalMilestone({ ...phone, percent: 100 }, 'ru').title).toBe(
      'Цель «Телефон» достигнута 📱',
    );
  });

  it('tell a category limit from the month total', () => {
    const food = { spent: '85 000 сум', limit: '100 000 сум' };
    const title = (category: string | null, percent: number) =>
      plain(budgetAlert({ ...food, category, percent }, 'ru').title);
    expect(title('Еда', 85)).toBe('Еда: 85 % лимита');
    expect(title('Еда', 100)).toBe('Еда: лимит исчерпан');
    expect(title('Еда', 101)).toBe('Еда: лимит превышен');
    expect(
      budgetAlert({ ...food, category: null, percent: 130 }, 'en').title,
    ).toBe('Monthly budget exceeded');
  });
});
