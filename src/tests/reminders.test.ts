import { describe, it, expect, afterEach } from 'vitest';
import {
  appTimeZone,
  zonedWallClock,
  endOfLocalDay,
  localDateKey,
  buildReminderDigest,
  digestSlots,
  outstandingLabel,
  hasOutstandingDue,
  followupVisibleFrom,
  DIGEST_INTERVAL_HOURS,
  PAYMENT_LOOKAHEAD_DAYS,
  MAX_FOLLOWUP_LEAD_MINUTES,
} from '@/lib/reminders';

const IST = 'Asia/Kolkata';
const NY = 'America/New_York';
const originalTz = process.env.APP_TIMEZONE;

afterEach(() => {
  if (originalTz === undefined) delete process.env.APP_TIMEZONE;
  else process.env.APP_TIMEZONE = originalTz;
});

describe('appTimeZone', () => {
  it('defaults to Asia/Kolkata when unset', () => {
    delete process.env.APP_TIMEZONE;
    expect(appTimeZone()).toBe(IST);
  });

  it('falls back rather than throwing on an invalid zone', () => {
    process.env.APP_TIMEZONE = 'Not/AZone';
    expect(appTimeZone()).toBe(IST);
  });

  it('honours a valid configured zone', () => {
    process.env.APP_TIMEZONE = 'Asia/Dubai';
    expect(appTimeZone()).toBe('Asia/Dubai');
  });

  it('ignores surrounding whitespace', () => {
    process.env.APP_TIMEZONE = '  Asia/Dubai  ';
    expect(appTimeZone()).toBe('Asia/Dubai');
  });
});

describe('zonedWallClock', () => {
  it('resolves 09:00 IST to the correct instant', () => {
    // 2026-09-28 09:00 IST is 03:30 UTC, so a 9:00 send must not fire at 09:00 UTC.
    const result = zonedWallClock(new Date('2026-09-28T12:00:00Z'), IST, 9, 0);
    expect(result.toISOString()).toBe('2026-09-28T03:30:00.000Z');
  });

  it('stays on the correct local day when the reference is late in UTC', () => {
    // 23:00 UTC on the 28th is already the 29th in IST (UTC+5:30).
    const result = zonedWallClock(new Date('2026-09-28T23:00:00Z'), IST, 9, 0);
    expect(result.toISOString()).toBe('2026-09-29T03:30:00.000Z');
  });

  it('handles a zone behind UTC', () => {
    const result = zonedWallClock(new Date('2026-09-28T12:00:00Z'), 'America/New_York', 9, 0);
    expect(result.toISOString()).toBe('2026-09-28T13:00:00.000Z');
  });

  it('produces an instant that reads back as the requested wall clock', () => {
    const at = zonedWallClock(new Date('2026-01-15T00:00:00Z'), IST, 9, 0);
    const label = new Intl.DateTimeFormat('en-GB', {
      timeZone: IST,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(at);
    expect(label).toBe('09:00');
  });

  // A zone that springs forward has a day which is 23 hours long, and a zone
  // that falls back has a 25-hour day. Both break any code that assumes a
  // local day is always 24 hours of UTC offset from the day before it.
  it('lands on the requested wall clock across a spring-forward transition', () => {
    // 2026-03-08 is the US DST start. The reference is midday UTC so its local
    // date is the 8th, and 09:00 that morning is 13:00 UTC because the clocks
    // jumped from 02:00 EST straight to 03:00 EDT.
    const result = zonedWallClock(new Date('2026-03-08T12:00:00Z'), NY, 9, 0);
    expect(result.toISOString()).toBe('2026-03-08T13:00:00.000Z');
  });

  it('lands on the requested wall clock across a fall-back transition', () => {
    // 2026-11-01 is the US DST end. 09:00 that morning is 14:00 UTC because by
    // then the hour has fallen back to standard time.
    const result = zonedWallClock(new Date('2026-11-01T12:00:00Z'), NY, 9, 0);
    expect(result.toISOString()).toBe('2026-11-01T14:00:00.000Z');
  });

  it('uses the pre-transition offset for a wall clock before the spring jump', () => {
    // 01:30 on 2026-03-08 in New York is still EST, so 06:30 UTC, not 05:30.
    // The reference is already on EDT, so this only passes if the offset is
    // re-read for the candidate instant instead of being taken from the
    // reference.
    const result = zonedWallClock(new Date('2026-03-08T12:00:00Z'), NY, 1, 30);
    expect(result.toISOString()).toBe('2026-03-08T06:30:00.000Z');
  });

  it('handles a half-hour zone offset without drifting', () => {
    // Adelaide is UTC+9:30, so a 09:00 send is 23:30 UTC the previous day.
    const result = zonedWallClock(new Date('2026-04-10T00:00:00Z'), 'Australia/Adelaide', 9, 0);
    expect(result.toISOString()).toBe('2026-04-09T23:30:00.000Z');
  });
});

describe('endOfLocalDay', () => {
  it('lands before the next local midnight', () => {
    const end = endOfLocalDay(new Date('2026-09-28T12:00:00Z'), IST);
    const next = new Date(end.getTime() + 1);
    const key = (d: Date) => localDateKey(d, IST);
    expect(key(end)).toBe('2026-09-28');
    expect(key(next)).toBe('2026-09-29');
  });

  it('covers a 23-hour spring-forward day without spilling past it', () => {
    const end = endOfLocalDay(new Date('2026-03-08T12:00:00Z'), NY);
    expect(localDateKey(end, NY)).toBe('2026-03-08');
    expect(localDateKey(new Date(end.getTime() + 1), NY)).toBe('2026-03-09');
  });

  it('covers a 25-hour fall-back day without spilling past it', () => {
    const end = endOfLocalDay(new Date('2026-11-01T12:00:00Z'), NY);
    expect(localDateKey(end, NY)).toBe('2026-11-01');
    expect(localDateKey(new Date(end.getTime() + 1), NY)).toBe('2026-11-02');
  });
});

describe('localDateKey', () => {
  it('keys the digest per local calendar day, not UTC day', () => {
    // 20:00 UTC on the 28th is 01:30 on the 29th in IST.
    expect(localDateKey(new Date('2026-09-28T20:00:00Z'), IST)).toBe('2026-09-29');
  });

  it('gives two agents in the same local day one shared key shape', () => {
    const morning = localDateKey(new Date('2026-09-28T04:00:00Z'), IST);
    const evening = localDateKey(new Date('2026-09-28T16:00:00Z'), IST);
    expect(morning).toBe(evening);
  });

  it('does not let a spring-forward day bleed into the previous local day', () => {
    // DST starts at 07:00 UTC on 2026-03-08, so 04:59 UTC is still 23:59 on
    // the 7th in New York even though UTC already reads the 8th.
    expect(localDateKey(new Date('2026-03-08T04:59:00Z'), NY)).toBe('2026-03-07');
    // 09:59 UTC is 04:59 EST, then 10:00 UTC is 06:00 EDT. The skipped 05:00
    // local hour must not shift either instant onto a different day.
    expect(localDateKey(new Date('2026-03-08T09:59:00Z'), NY)).toBe('2026-03-08');
    expect(localDateKey(new Date('2026-03-08T10:00:00Z'), NY)).toBe('2026-03-08');
  });

  it('keeps the two fall-back hours on the same local day', () => {
    // 05:59 UTC is 01:59 EDT and 06:00 UTC is 01:00 EST, both on 2026-11-01.
    expect(localDateKey(new Date('2026-11-01T05:59:00Z'), NY)).toBe('2026-11-01');
    expect(localDateKey(new Date('2026-11-01T06:00:00Z'), NY)).toBe('2026-11-01');
  });
});

describe('digestSlots', () => {
  it('splits the default reminder time into two 12-hour slots', () => {
    expect(digestSlots(9, 0)).toEqual([
      { hour: 9, minute: 0 },
      { hour: 21, minute: 0 },
    ]);
  });

  it('wraps into the same local day for a late reminder time', () => {
    expect(digestSlots(18, 30)).toEqual([
      { hour: 6, minute: 30 },
      { hour: 18, minute: 30 },
    ]);
  });

  it('keeps the two slots 12 hours apart even when they wrap midnight', () => {
    const slots = digestSlots(20, 15);
    const first = slots[0].hour * 60 + slots[0].minute;
    const second = slots[1].hour * 60 + slots[1].minute;
    expect(((second - first + 1440) % 1440)).toBe(DIGEST_INTERVAL_HOURS * 60);
  });

  it('produces two slots and never collides on itself', () => {
    const slots = digestSlots(0, 0);
    expect(slots).toHaveLength(2);
    expect(slots[0]).not.toEqual(slots[1]);
  });

  it('preserves the configured minute in both slots', () => {
    const slots = digestSlots(7, 45);
    expect(slots.map((slot) => slot.minute)).toEqual([45, 45]);
  });
});

describe('payment lookahead window', () => {
  it('looks past today so upcoming dues are not silently dropped', () => {
    expect(PAYMENT_LOOKAHEAD_DAYS).toBeGreaterThan(0);
  });

  it('is the approved 3-day window, not a week', () => {
    // A week turns the twice-daily digest into a standing reminder of
    // everything on the horizon, which is what the 3-day window replaced.
    expect(PAYMENT_LOOKAHEAD_DAYS).toBe(3);
  });
});

describe('followupVisibleFrom', () => {
  const at = (iso: string) => new Date(iso);

  it('surfaces a follow-up one hour before it is scheduled by default', () => {
    // A row with no lead time set gets the 60 minute default, so an 18:00 call
    // is visible from 17:00 and the agent can prepare rather than react.
    expect(followupVisibleFrom(at('2026-09-28T18:00:00Z'), null).toISOString()).toBe(
      '2026-09-28T17:00:00.000Z',
    );
  });

  it('honours a per-row lead time', () => {
    expect(followupVisibleFrom(at('2026-09-28T18:00:00Z'), 1440).toISOString()).toBe(
      '2026-09-27T18:00:00.000Z',
    );
  });

  it('treats a zero lead time as due exactly when it is scheduled', () => {
    expect(followupVisibleFrom(at('2026-09-28T18:00:00Z'), 0).toISOString()).toBe(
      '2026-09-28T18:00:00.000Z',
    );
  });

  it('clamps an absurd lead time instead of pulling the whole backlog in', () => {
    // A typo of 100000 minutes must not make every pending row due at once.
    expect(followupVisibleFrom(at('2026-09-28T18:00:00Z'), 100000).toISOString()).toBe(
      new Date(at('2026-09-28T18:00:00Z').getTime() - MAX_FOLLOWUP_LEAD_MINUTES * 60_000).toISOString(),
    );
  });

  it('treats a negative lead time as zero rather than a follow-up in the future', () => {
    // A negative value would push visibility past the scheduled time, hiding
    // the follow-up even after it was due.
    expect(followupVisibleFrom(at('2026-09-28T18:00:00Z'), -60).toISOString()).toBe(
      '2026-09-28T18:00:00.000Z',
    );
  });

  it('falls back to the default for a non-numeric lead time', () => {
    expect(followupVisibleFrom(at('2026-09-28T18:00:00Z'), Number.NaN).toISOString()).toBe(
      '2026-09-28T17:00:00.000Z',
    );
  });
});

describe('outstandingLabel', () => {
  const money = (value: number) => `INR${value}`;

  it('shows the full amount when nothing has been paid', () => {
    expect(outstandingLabel(money, 50000, 0)).toBe('INR50000');
  });

  it('treats a null paid amount as nothing paid', () => {
    expect(outstandingLabel(money, 50000, Number.NaN)).toBe('INR50000');
  });

  it('names the remaining balance for a partially paid due', () => {
    expect(outstandingLabel(money, 50000, 20000)).toBe('INR30000 left of INR50000');
  });

  it('never reports a negative balance when an overpayment is recorded', () => {
    expect(outstandingLabel(money, 50000, 60000)).toBe('INR0');
  });

  it('survives a non-numeric amount instead of rendering NaN', () => {
    expect(outstandingLabel(money, Number.NaN, 0)).toBe('INR0');
  });
});

describe('buildReminderDigest', () => {
  const base = {
    agentName: 'Ravi Kumar',
    timeZone: IST,
    appUrl: 'https://crm.example.com',
  };

  const followup = (n: number) => ({
    kind: 'FOLLOWUP' as const,
    refId: `f${n}`,
    party: 'Aarav Mehta',
    contact: '9876543210',
    when: new Date('2026-09-28T10:00:00Z'),
    detail: 'Call about Tower B',
  });

  const payment = (n: number) => ({
    kind: 'PAYMENT' as const,
    refId: `d${n}`,
    party: 'Priya Sharma',
    contact: null,
    when: new Date('2026-09-20T00:00:00Z'),
    detail: 'Booking amount',
    overdue: true,
  });

  it('says nothing is pending when there is nothing to do', () => {
    const { subject, text } = buildReminderDigest({ ...base, followups: [], payments: [] });
    expect(text).toMatch(/nothing is waiting/i);
    expect(subject).toBe('Your summary - all clear');
  });

  it('addresses the agent by first name only', () => {
    const { text } = buildReminderDigest({ ...base, followups: [], payments: [] });
    expect(text).toContain('Hi Ravi,');
    expect(text).not.toContain('Ravi Kumar,');
  });

  it('falls back to "there" for a blank agent name', () => {
    const { text } = buildReminderDigest({ ...base, agentName: '   ', followups: [], payments: [] });
    expect(text).toMatch(/Hi\s+there,/);
  });

  it('counts follow-ups and payments together in the subject', () => {
    const { subject, text } = buildReminderDigest({
      ...base,
      followups: [followup(1)],
      payments: [payment(1)],
    });
    expect(subject).toBe('2 items waiting - 1 follow-up, 1 payment');
    expect(text).toContain('FOLLOW-UPS (1)');
    expect(text).toContain('PAYMENTS PENDING (1)');
  });

  it('uses singular wording for a single item', () => {
    const { subject } = buildReminderDigest({ ...base, followups: [followup(1)], payments: [] });
    expect(subject).toBe('1 item waiting - 1 follow-up, 0 payments');
  });

  it('shows the contact when present and omits it when absent', () => {
    const { text } = buildReminderDigest({ ...base, followups: [], payments: [payment(1)] });
    expect(text).toContain('Priya Sharma');
    expect(text).not.toContain('Priya Sharma - null');
  });

  it('renders an overdue payment as already late', () => {
    const { text } = buildReminderDigest({ ...base, followups: [], payments: [payment(1)] });
    expect(text).toMatch(/overdue since \d{2} \w+ 2026/);
  });

  it('renders a payment that is not yet late as simply due', () => {
    const { text } = buildReminderDigest({
      ...base,
      followups: [],
      payments: [{ ...payment(1), overdue: false, when: new Date('2026-10-02T00:00:00Z') }],
    });
    expect(text).toContain('PAYMENTS DUE SOON (1)');
    expect(text).toMatch(/due \d{2} \w+ 2026/);
    expect(text).not.toMatch(/overdue since/);
  });

  it('keeps the pending header when only some payments are overdue', () => {
    const { text } = buildReminderDigest({
      ...base,
      followups: [],
      payments: [payment(1), { ...payment(2), overdue: false, when: new Date('2026-10-02T00:00:00Z') }],
    });
    expect(text).toContain('PAYMENTS PENDING (2)');
  });

  it('describes a not-yet-due follow-up as upcoming rather than late', () => {
    const { text } = buildReminderDigest({
      ...base,
      followups: [{ ...followup(1), overdue: false, when: new Date('2026-09-29T10:00:00Z') }],
      payments: [],
    });
    expect(text).toMatch(/due \d{2} \w+ 2026, \d{2}:\d{2}/);
    expect(text).not.toMatch(/was due/);
  });

  it('renders the due date in the configured timezone', () => {
    const { text } = buildReminderDigest({ ...base, followups: [], payments: [payment(1)] });
    expect(text).toMatch(/(overdue since|due) \d{2} \w+ 2026/);
  });

  it('links to the today screen and states the repeat behaviour', () => {
    const { text } = buildReminderDigest({ ...base, followups: [followup(1)], payments: [] });
    expect(text).toContain('https://crm.example.com/today');
    expect(text).toMatch(/repeats every 12 hours until you clear/i);
  });

  it('tolerates a trailing slash on the configured app URL', () => {
    const { text } = buildReminderDigest({
      ...base,
      appUrl: 'https://crm.example.com/',
      followups: [followup(1)],
      payments: [],
    });
    expect(text).toContain('https://crm.example.com/today');
    expect(text).not.toContain('//today');
  });

  it('caps a long backlog but still reports the true count', () => {
    const { text, subject } = buildReminderDigest({
      ...base,
      followups: Array.from({ length: 40 }, (_, i) => followup(i)),
      payments: [],
    });
    expect(text).toContain('FOLLOW-UPS (40)');
    expect(text).toMatch(/and 20 more/);
    expect(subject).toContain('40 follow-up');
  });

  it('does not add a "more" line when the list fits', () => {
    const { text } = buildReminderDigest({ ...base, followups: [followup(1)], payments: [] });
    expect(text).not.toMatch(/and \d+ more/);
  });
});

describe('hasOutstandingDue', () => {
  it('treats a due with nothing paid as outstanding', () => {
    expect(hasOutstandingDue(100000, null)).toBe(true);
    expect(hasOutstandingDue(100000, undefined)).toBe(true);
    expect(hasOutstandingDue(100000, 0)).toBe(true);
  });

  it('treats a partially paid due as outstanding', () => {
    expect(hasOutstandingDue(100000, 40000)).toBe(true);
    expect(hasOutstandingDue(100, '25.50')).toBe(true);
  });

  it('excludes a fully settled due even when status still says PARTIAL', () => {
    expect(hasOutstandingDue(100000, 100000)).toBe(false);
    expect(hasOutstandingDue(100000, 140000)).toBe(false);
  });

  it('excludes a zero-amount due', () => {
    expect(hasOutstandingDue(0, null)).toBe(false);
    expect(hasOutstandingDue(0, 0)).toBe(false);
  });

  it('accepts the strings Postgres numeric arrives as', () => {
    expect(hasOutstandingDue('100000.00', '40000.00')).toBe(true);
    expect(hasOutstandingDue('100000.00', '100000.00')).toBe(false);
    expect(hasOutstandingDue(' 100000 ', ' 0 ')).toBe(true);
  });

  it('excludes amounts that cannot be parsed rather than guessing', () => {
    expect(hasOutstandingDue('abc', null)).toBe(false);
    expect(hasOutstandingDue('', null)).toBe(false);
    expect(hasOutstandingDue(Number.NaN, 0)).toBe(false);
    expect(hasOutstandingDue(Number.POSITIVE_INFINITY, 0)).toBe(false);
    expect(hasOutstandingDue(100000, 'abc')).toBe(true);
  });
});
