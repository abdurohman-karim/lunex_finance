import { parseReply } from './insight-writer.service.js';
import { DAILY_TIP, WEEKLY_REPORT } from './insight-texts.js';

describe('insight texts', () => {
  it('reads the JSON in the model’s answer and refuses anything else', () => {
    expect(
      parseReply(
        'Sure!\n{"title":"Неделя","summary":"Расходы 1 000 сум.","recommendation":"Лимит."}',
      ),
    ).toEqual({
      title: 'Неделя',
      summary: 'Расходы 1 000 сум.',
      recommendation: 'Лимит.',
    });
    expect(parseReply('no json here')).toBeNull();
    expect(parseReply('{"title":"x"}')).toBeNull();
    expect(
      parseReply('{"title":"","summary":"a","recommendation":"b"}'),
    ).toBeNull();
  });

  it('says the same facts in each language', () => {
    const facts = {
      period: '12–18',
      expense: '540 000',
      income: '5 000 000',
      changePercent: 54,
      topCategory: { name: 'Еда', amount: '450 000', sharePercent: 83 },
      biggestIncrease: null,
    };
    expect(WEEKLY_REPORT.ru(facts).summary).toContain('+54 %');
    expect(WEEKLY_REPORT.en(facts).summary).toContain('+54%');
    expect(WEEKLY_REPORT.uz(facts).title).toBe('Hafta 12–18: 540 000');
    const tip = DAILY_TIP.en({
      situation: 'overspent',
      safeToSpend: '−5',
      dailyLimit: '10',
      daysLeft: 3,
      overBy: '5',
    });
    expect(tip.title).toBe("Today's limit is over by 5");
  });
});
