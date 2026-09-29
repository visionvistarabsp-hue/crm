import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { classifySource, parseMetaFieldData, readStringMap, type MetaConfig } from '@/lib/services/meta';

const config: MetaConfig = {
  pageToken: 'token',
  verifyToken: 'verify',
  appSecret: 'app-secret',
  facebookPageId: 'fb-page-1',
  instagramAccountId: 'ig-account-9',
  formSources: { 'form-wa': 'WHATSAPP', 'form-ig': 'INSTAGRAM', 'form-yt': 'YOUTUBE_ADS' },
};

describe('classifySource', () => {
  it('prefers a hidden whatsapp_account_id field over any mapping', () => {
    expect(classifySource(config, { formId: 'form-ig', customFields: { whatsapp_account_id: 'anything' } })).toBe('WHATSAPP');
  });

  it('treats a blank whatsapp_account_id as absent', () => {
    expect(classifySource(config, { formId: 'form-ig', customFields: { whatsapp_account_id: '   ' } })).toBe('INSTAGRAM');
  });

  it('falls back to the form mapping when no hidden field is present', () => {
    expect(classifySource(config, { formId: 'form-wa' })).toBe('WHATSAPP');
    expect(classifySource(config, { formId: 'form-yt' })).toBe('YOUTUBE_ADS');
  });

  it('tolerates whitespace around a form id', () => {
    expect(classifySource(config, { formId: '  form-wa  ' })).toBe('WHATSAPP');
  });

  it('falls back to the instagram account id when the form is unmapped', () => {
    expect(classifySource(config, { formId: 'form-unknown', pageId: 'ig-account-9' })).toBe('INSTAGRAM');
  });

  it('defaults to facebook for a page-bound lead with no mapping', () => {
    expect(classifySource(config, { formId: 'form-unknown', pageId: 'fb-page-1' })).toBe('FACEBOOK');
    expect(classifySource(config, { pageId: 'fb-page-1' })).toBe('FACEBOOK');
    expect(classifySource(config, {})).toBe('FACEBOOK');
  });

  it('does not treat a facebook page id as instagram', () => {
    expect(classifySource(config, { pageId: 'fb-page-1' })).not.toBe('INSTAGRAM');
  });
});

describe('readStringMap', () => {
  it('normalises keys and upper-cases values', () => {
    expect(readStringMap({ ' 123 ': 'whatsapp' })).toEqual({ '123': 'WHATSAPP' });
  });

  it('drops entries with a blank id or value', () => {
    expect(readStringMap({ '  ': 'WHATSAPP', '1': '   ' })).toEqual({});
  });

  it('returns an empty map for non-objects', () => {
    expect(readStringMap(null)).toEqual({});
    expect(readStringMap('nope')).toEqual({});
    expect(readStringMap(['a'])).toEqual({});
  });
});

describe('parseMetaFieldData', () => {
  it('reads known keys case-insensitively and keeps custom fields raw', () => {
    const parsed = parseMetaFieldData([
      { name: 'full_name', values: ['Aditi Rao'] },
      { name: 'PHONE_NUMBER', values: ['+91 90000 00000'] },
      { name: 'whatsapp_account_id', values: ['wa-1'] },
    ]);

    expect(parsed.name).toBe('Aditi Rao');
    expect(parsed.phone).toBe('+91 90000 00000');
    expect(parsed.customFields.whatsapp_account_id).toBe('wa-1');
  });

  it('returns empty values for an empty field list', () => {
    const parsed = parseMetaFieldData([]);
    expect(parsed.name).toBe('Meta Lead');
    expect(parsed.phone ?? '').toBe('');
    expect(parsed.customFields).toEqual({});
  });
});
