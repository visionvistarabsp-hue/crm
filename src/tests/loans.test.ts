import { describe, it, expect } from 'vitest';
import {
  daysInStage,
  isStuck,
  STUCK_AFTER_DAYS,
  summarise,
  type LoanView,
} from '../lib/services/loans';
import { LOAN_STATUS } from '../lib/constants';

const NOW = new Date('2026-06-15T00:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

const stageLoan = (over: Partial<Parameters<typeof daysInStage>[0]> = {}) => ({
  status: 'APPLIED',
  applicationDate: NOW,
  sanctionDate: null,
  disbursementDate: null,
  ...over,
});

const view = (over: Partial<LoanView> = {}): LoanView => ({
  id: 'l1',
  bookingId: 'b1',
  bookingNo: 'BK-1',
  customerName: 'Asha Rao',
  customerPhone: null,
  projectName: 'Palm Grove',
  unitLabel: null,
  saleValue: '5000000',
  applicantName: null,
  applicantRelation: null,
  bankName: null,
  applicationNo: null,
  loanType: 'HOME',
  loanAmount: '4000000',
  marginAmount: null,
  propertyValuation: null,
  interestRate: null,
  tenureMonths: null,
  emi: null,
  status: 'APPLIED',
  applicationDate: NOW,
  sanctionDate: null,
  disbursementDate: null,
  remarks: null,
  daysInStage: 0,
  stuck: false,
  financingShare: 80,
  createdAt: NOW,
  ...over,
});

describe('daysInStage', () => {
  it('counts from the application date before sanction', () => {
    expect(daysInStage(stageLoan({ applicationDate: daysAgo(12) }), NOW)).toBe(12);
  });

  it('counts from the sanction date once sanctioned, not the application date', () => {
    const l = stageLoan({
      status: 'SANCTIONED',
      applicationDate: daysAgo(90),
      sanctionDate: daysAgo(7),
    });
    expect(daysInStage(l, NOW)).toBe(7);
  });

  it('counts from the disbursement date once the money has gone out', () => {
    const l = stageLoan({
      status: 'DISBURSED',
      applicationDate: daysAgo(120),
      sanctionDate: daysAgo(60),
      disbursementDate: daysAgo(4),
    });
    expect(daysInStage(l, NOW)).toBe(4);
  });

  it('falls back to the sanction date when a disbursement is missing', () => {
    const l = stageLoan({
      status: 'CLOSED',
      applicationDate: daysAgo(120),
      sanctionDate: daysAgo(30),
      disbursementDate: null,
    });
    expect(daysInStage(l, NOW)).toBe(30);
  });

  it('never reports a negative age for a future-dated stage', () => {
    expect(daysInStage(stageLoan({ applicationDate: new Date(NOW.getTime() + 86_400_000) }), NOW)).toBe(0);
  });

  it('reports zero rather than NaN when the stage start is missing', () => {
    const l = stageLoan({ status: 'SANCTIONED', applicationDate: NOW, sanctionDate: null });
    expect(daysInStage(l, NOW)).toBe(0);
  });
});

describe('isStuck', () => {
  it('flags a loan left in one stage past the window', () => {
    expect(isStuck(stageLoan({ applicationDate: daysAgo(STUCK_AFTER_DAYS + 1) }), NOW)).toBe(true);
  });

  it('leaves a loan inside the window alone', () => {
    expect(isStuck(stageLoan({ applicationDate: daysAgo(STUCK_AFTER_DAYS) }), NOW)).toBe(false);
  });

  it('restarts the clock when a loan is sanctioned', () => {
    // 200 days since application, but only 5 days since sanction.
    const l = stageLoan({
      status: 'SANCTIONED',
      applicationDate: daysAgo(200),
      sanctionDate: daysAgo(5),
    });
    expect(isStuck(l, NOW)).toBe(false);
  });

  it('never flags a loan that has reached a finished state', () => {
    for (const status of ['REJECTED', 'CLOSED', 'DISBURSED']) {
      expect(isStuck(stageLoan({ status, applicationDate: daysAgo(400) }), NOW)).toBe(false);
    }
  });

  it('does not count a long-finished disbursement as stuck', () => {
    const l = stageLoan({
      status: 'DISBURSED',
      applicationDate: daysAgo(300),
      sanctionDate: daysAgo(200),
      disbursementDate: daysAgo(300),
    });
    expect(isStuck(l, NOW)).toBe(false);
  });

  it('still flags a sanctioned loan waiting on the money', () => {
    const l = stageLoan({
      status: 'SANCTIONED',
      applicationDate: daysAgo(200),
      sanctionDate: daysAgo(45),
    });
    expect(isStuck(l, NOW)).toBe(true);
  });
});

describe('summarise', () => {
  it('counts totals, open loans and disbursed value', () => {
    const s = summarise([
      view({ id: 'a', status: 'APPLIED', loanAmount: '4000000' }),
      view({ id: 'b', status: 'IN_PROGRESS', loanAmount: '3000000' }),
      view({ id: 'c', status: 'DISBURSED', loanAmount: '5000000' }),
    ]);
    expect(s.total).toBe(3);
    expect(s.open).toBe(2);
    expect(s.disbursed).toBe(1);
    expect(s.totalDisbursed).toBe(5_000_000);
    expect(s.pendingDisbursement).toBe(7_000_000);
  });

  it('adds up the rows in each stage, ordered along the lifecycle', () => {
    const s = summarise([
      view({ id: 'a', status: 'DISBURSED', loanAmount: '1000' }),
      view({ id: 'b', status: 'APPLIED', loanAmount: '2000' }),
      view({ id: 'c', status: 'APPLIED', loanAmount: '3000' }),
    ]);
    expect(s.byStatus.map((x) => x.status)).toEqual(['APPLIED', 'DISBURSED']);
    expect(s.byStatus[0].count).toBe(2);
    expect(s.byStatus[0].amount).toBe(5000);
  });

  it('groups by bank, biggest first, and skips loans with no bank yet', () => {
    const s = summarise([
      view({ id: 'a', bankName: 'HDFC', loanAmount: '1000' }),
      view({ id: 'b', bankName: 'SBI', loanAmount: '9000' }),
      view({ id: 'c', bankName: null, loanAmount: '5000' }),
    ]);
    expect(s.banks.map((b) => b.bank)).toEqual(['SBI', 'HDFC']);
  });

  it('carries the stuck count through', () => {
    const s = summarise([
      view({ id: 'a', stuck: true }),
      view({ id: 'b', stuck: false }),
      view({ id: 'c', stuck: true }),
    ]);
    expect(s.stuck).toBe(2);
  });

  it('does not double count a rejected loan as pending disbursement', () => {
    const s = summarise([view({ id: 'a', status: 'REJECTED', loanAmount: '4000000' })]);
    expect(s.open).toBe(0);
    expect(s.pendingDisbursement).toBe(0);
    expect(s.totalDisbursed).toBe(0);
  });

  it('summarises an empty pipeline without dividing by zero', () => {
    const s = summarise([]);
    expect(s.total).toBe(0);
    expect(s.byStatus).toEqual([]);
    expect(s.banks).toEqual([]);
  });

  it('reads loan amounts that Postgres returned as strings', () => {
    const s = summarise([
      view({ id: 'a', status: 'DISBURSED', loanAmount: '1234.56' }),
    ]);
    expect(s.totalDisbursed).toBe(1234.56);
  });
});

describe('LOAN_STATUS', () => {
  it('orders the lifecycle so "move to next" always makes sense', () => {
    expect(LOAN_STATUS.indexOf('APPLIED')).toBeLessThan(LOAN_STATUS.indexOf('DOCUMENTS_PENDING'));
    expect(LOAN_STATUS.indexOf('IN_PROGRESS')).toBeLessThan(LOAN_STATUS.indexOf('SANCTIONED'));
    expect(LOAN_STATUS.indexOf('SANCTIONED')).toBeLessThan(LOAN_STATUS.indexOf('DISBURSED'));
  });

  it('ends on the terminal states', () => {
    expect(LOAN_STATUS.slice(-2)).toEqual(['REJECTED', 'CLOSED']);
  });
});
