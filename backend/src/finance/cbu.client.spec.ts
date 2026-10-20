import { parseCbuRates } from './cbu.client.js';

describe('CBU rates', () => {
  it('reads a rate per one unit with its date', () => {
    expect(
      parseCbuRates([
        {
          id: 68,
          Code: '840',
          Ccy: 'USD',
          Nominal: '1',
          Rate: '12044.72',
          Diff: '-11.18',
          Date: '20.10.2026',
        },
        { Ccy: 'JPY', Nominal: '10', Rate: '801.5', Date: '20.10.2026' },
      ]),
    ).toEqual([
      { code: 'USD', rate: '12044.72', date: '2026-10-20' },
      { code: 'JPY', rate: '80.15', date: '2026-10-20' },
    ]);
  });

  it('skips rows it cannot read and refuses what is not a list', () => {
    expect(
      parseCbuRates([
        { Ccy: 'USD', Nominal: '1', Rate: 'n/a', Date: '20.10.2026' },
        { Ccy: 'EUR', Nominal: '0', Rate: '1', Date: '20.10.2026' },
        null,
      ]),
    ).toEqual([]);
    expect(() => parseCbuRates({ error: 'busy' })).toThrow();
  });
});
