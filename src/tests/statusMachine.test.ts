import { describe, it, expect } from 'vitest';
import { validateStatusChange, isKnownStatus, isOpenStatus, canReopen, TERMINAL_STATUSES, pipelineWithUnknown } from '@/lib/services/statusMachine';

describe('statusMachine', () => {
  it('recognises known and open statuses', () => {
    expect(isKnownStatus('NEW')).toBe(true);
    expect(isKnownStatus('DEAL_COMPLETED')).toBe(true);
    expect(isKnownStatus('BOGUS')).toBe(false);
    expect(isOpenStatus('NEW')).toBe(true);
    expect(isOpenStatus('DEAL_COMPLETED')).toBe(false);
    expect(isOpenStatus('LOST')).toBe(false);
  });

  it('flags terminal statuses', () => {
    expect(TERMINAL_STATUSES).toEqual(['DEAL_COMPLETED', 'CANCELLED', 'DUPLICATE']);
  });

  it('allows initial assignment from null', () => {
    expect(validateStatusChange(null, 'NEW')).toEqual({ ok: true });
    expect(validateStatusChange(undefined, 'CONTACTED')).toEqual({ ok: true });
  });

  it('rejects unknown target statuses', () => {
    const r = validateStatusChange('NEW', 'BOGUS');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('Unknown status');
  });

  it('allows unchanged status', () => {
    expect(validateStatusChange('CONTACTED', 'CONTACTED')).toEqual({ ok: true });
  });

  it('allows open -> open transitions', () => {
    expect(validateStatusChange('NEW', 'CONTACTED')).toEqual({ ok: true });
    expect(validateStatusChange('CONTACTED', 'MEETING')).toEqual({ ok: true });
    expect(validateStatusChange('FOLLOW_UP', 'NEGOTIATION')).toEqual({ ok: true });
  });

  it('allows open -> closed transitions', () => {
    expect(validateStatusChange('NEGOTIATION', 'DEAL_COMPLETED')).toEqual({ ok: true });
    expect(validateStatusChange('FOLLOW_UP', 'LOST')).toEqual({ ok: true });
  });

  it('rejects transitions out of terminal statuses', () => {
    const r = validateStatusChange('DEAL_COMPLETED', 'NEW');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('terminal');
    expect(validateStatusChange('CANCELLED', 'CONTACTED').ok).toBe(false);
    expect(validateStatusChange('DUPLICATE', 'NEW').ok).toBe(false);
  });

  it('rejects closed -> closed transitions of different terminals', () => {
    const r = validateStatusChange('LOST', 'DEAL_COMPLETED');
    expect(r.ok).toBe(false);
  });

  it('canReopen only for privileged roles', () => {
    expect(canReopen('SUPER_ADMIN')).toBe(true);
    expect(canReopen('ADMIN')).toBe(true);
    expect(canReopen('SALES_EXECUTIVE')).toBe(false);
    expect(canReopen('SALES_MANAGER')).toBe(false);
  });

  it('pipelineWithUnknown falls back to NEW', () => {
    expect(pipelineWithUnknown(null)).toBe('NEW');
    expect(pipelineWithUnknown(undefined)).toBe('NEW');
    expect(pipelineWithUnknown('CONTACTED')).toBe('CONTACTED');
  });
});