import { formulaCases } from '../../test/support/formula-cases.js';
import {
  type RecurrenceRule,
  type RecurrenceSchedule,
  firstOnOrAfter,
  occurrencesBetween,
} from './recurrence.js';

const cases = formulaCases<{
  occurrences: {
    name: string;
    rule: RecurrenceRule;
    from: string;
    to: string;
    dates: string[];
  }[];
  firstOnOrAfter: {
    name: string;
    rule: RecurrenceSchedule;
    from: string;
    expected: string;
  }[];
}>('recurrence');

describe('occurrencesBetween (shared/formula-cases/recurrence.json)', () => {
  it.each(cases.occurrences)('$name', ({ rule, from, to, dates }) => {
    expect(occurrencesBetween(rule, from, to)).toEqual(dates);
  });
});

describe('firstOnOrAfter (shared/formula-cases/recurrence.json)', () => {
  it.each(cases.firstOnOrAfter)('$name', ({ rule, from, expected }) => {
    expect(firstOnOrAfter(rule, from)).toBe(expected);
  });
});
