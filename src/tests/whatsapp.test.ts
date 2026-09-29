import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

/**
 * WhatsApp broadcast runs through the Meta Graph API, which is not something a
 * test can reach. These tests pin the two contracts the code actually owns:
 *
 *   - phone normalisation: an invalid E.164 must be refused before any HTTP
 *     call is made, and a bare 10-digit number must become the app's default
 *     `+91...` long form - getting this wrong either burns the user's phone
 *     number dialling something mangled, or silently drops the lead alert;
 *   - the template-message payload and the config resolution order (a saved
 *     integration row wins over env vars, env vars are the fallback).
 *
 * `fetch` is stubbed globally, so no network traffic happens in these tests.
 */

/** The single integrations row `resolveWhatsAppConfig` reads. */
let integrationRow: Record<string, unknown> | undefined;
/** Rows recorded through `logOutboundMessage` (mocked `message_logs` insert). */
let messageLogRows: Array<Record<string, unknown>>;
/** Handler captured by the mocked `registerJobHandler`. */
let whatsappHandler: ((payload: Record<string, unknown>) => Promise<void>) | undefined;
const fetchMock = vi.fn();

vi.mock('@/lib/db', () => ({
  db: {
    query: {
      integrations: {
        findFirst: async () => integrationRow,
      },
    },
    insert: () => ({
      values: async (values: Record<string, unknown>) => {
        messageLogRows.push(values);
        return [];
      },
    }),
  },
}));

vi.mock('@/lib/queue', () => ({
  registerJobHandler: (type: string, handler: (p: Record<string, unknown>) => Promise<void>) => {
    if (type === 'WHATSAPP') whatsappHandler = handler;
  },
}));

vi.mock('@/lib/secrets', () => ({
  looksEncrypted: (value: string) => typeof value === 'string' && value.startsWith('enc:'),
  decryptSecret: (value: string) =>
    value.startsWith('enc:') ? `decrypted-${value.slice(4)}` : value,
}));

const {
  toE164,
  isValidPhone,
  resolveWhatsAppConfig,
  sendWhatsAppMessage,
  registerWhatsAppHandler,
} = await import('@/lib/whatsapp');

function okJson(id: string) {
  return new Response(JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  integrationRow = undefined;
  whatsappHandler = undefined;
  messageLogRows = [];
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  delete process.env.WHATSAPP_ACCESS_TOKEN;
  delete process.env.WHATSAPP_PHONE_NUMBER_ID;
  delete process.env.WHATSAPP_FROM_PHONE;
  delete process.env.WHATSAPP_TEMPLATE_NAME;
  delete process.env.WHATSAPP_TEMPLATE_LANGUAGE;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('toE164', () => {
  it('keeps a number that is already long-form', () => {
    expect(toE164('+919876543210')).toBe('+919876543210');
  });

  it('assumes a bare 10-digit national number is India (+91)', () => {
    expect(toE164('9876543210')).toBe('+919876543210');
  });

  it('accepts a 91-prefixed number with extra punctuation', () => {
    expect(toE164('91 98765 43210')).toBe('+919876543210');
  });

  it('returns null for a number that cannot be interpreted', () => {
    expect(toE164('')).toBeNull();
    expect(toE164('garbage')).toBeNull();
    expect(toE164('123')).toBeNull();
    expect(toE164('+1')).toBeNull();
  });

  it('rejects strings that are too long for E.164', () => {
    expect(toE164('+91123456789012345678')).toBeNull();
  });
});

describe('isValidPhone', () => {
  it('accepts an E.164 number', () => {
    expect(isValidPhone('+919876543210')).toBe(true);
  });

  it('rejects anything not prefixed with a non-zero country code', () => {
    expect(isValidPhone('9876543210')).toBe(false);
    expect(isValidPhone('')).toBe(false);
    expect(isValidPhone('+0xxxxxxxxx')).toBe(false);
  });
});

describe('resolveWhatsAppConfig', () => {
  it('returns null when neither a row nor env vars provide credentials', async () => {
    expect(await resolveWhatsAppConfig()).toBeNull();
  });

  it('falls back to env vars and applies the template defaults', async () => {
    process.env.WHATSAPP_ACCESS_TOKEN = 'env-token';
    process.env.WHATSAPP_PHONE_NUMBER_ID = '123456';

    const config = await resolveWhatsAppConfig();
    expect(config).toMatchObject({
      accessToken: 'env-token',
      phoneNumberId: '123456',
      fromPhone: '',
      templateName: 'lead_alert',
      templateLanguage: 'en',
    });
  });

  it('overrides env vars from an active, encrypted integration row', async () => {
    process.env.WHATSAPP_ACCESS_TOKEN = 'env-token';
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'env-id';
    integrationRow = {
      provider: 'whatsapp',
      isActive: true,
      config: {
        accessToken: 'enc:ui-token',
        phoneNumberId: 'ui-id',
        fromPhone: '+919800000000',
        templateName: 'crm_alert',
        templateLanguage: 'hi',
      },
    };

    const config = await resolveWhatsAppConfig();
    expect(config).toMatchObject({
      accessToken: 'decrypted-ui-token',
      phoneNumberId: 'ui-id',
      fromPhone: '+919800000000',
      templateName: 'crm_alert',
      templateLanguage: 'hi',
    });
  });

  it('ignores an inactive row', async () => {
    process.env.WHATSAPP_ACCESS_TOKEN = 'env-token';
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'env-id';
    integrationRow = { provider: 'whatsapp', isActive: false, config: { accessToken: 'enc:x' } };

    const config = await resolveWhatsAppConfig();
    expect(config?.accessToken).toBe('env-token');
  });

  it('falls back to env when the stored token is not encrypted ciphertext', async () => {
    process.env.WHATSAPP_ACCESS_TOKEN = 'env-token';
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'env-id';
    integrationRow = {
      provider: 'whatsapp',
      isActive: true,
      config: { accessToken: 'plaintext', phoneNumberId: 'ui-id' },
    };

    const config = await resolveWhatsAppConfig();
    expect(config?.accessToken).toBe('env-token');
    // The phone number id still wins from the row.
    expect(config?.phoneNumberId).toBe('ui-id');
  });
});

describe('sendWhatsAppMessage', () => {
  const config = {
    accessToken: 'token',
    phoneNumberId: 'ph-id',
    fromPhone: '',
    templateName: 'lead_alert',
    templateLanguage: 'en',
  };

  it('refuses an invalid number without any network call', async () => {
    await expect(
      sendWhatsAppMessage(config, { to: '9876543210', bodyParams: ['hi'] }),
    ).rejects.toThrow(/invalid number/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs a template message and returns the message id', async () => {
    fetchMock.mockResolvedValueOnce(okJson('wamid.7'));
    const result = await sendWhatsAppMessage(config, { to: '+919876543210', bodyParams: ['New lead: Riya'] });

    expect(result.id).toBe('wamid.7');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://graph.facebook.com/v22.0/ph-id/messages');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token');

    const body = JSON.parse(String(init.body)) as {
      messaging_product: string;
      to: string;
      type: string;
      template: { name: string; language: { code: string }; components: Array<{ type: string; parameters: Array<{ type: string; text: string }> }> };
    };
    expect(body.messaging_product).toBe('whatsapp');
    expect(body.to).toBe('+919876543210');
    expect(body.type).toBe('template');
    expect(body.template.name).toBe('lead_alert');
    expect(body.template.language.code).toBe('en');
    expect(body.template.components[0].parameters).toEqual([{ type: 'text', text: 'New lead: Riya' }]);
  });

  it('resolves per-message template overrides', async () => {
    fetchMock.mockResolvedValueOnce(okJson('wamid.8'));
    await sendWhatsAppMessage(config, {
      to: '+919876543210',
      templateName: 'custom',
      templateLanguage: 'hi',
      bodyParams: ['x'],
    });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(init.body)) as { template: Record<string, unknown> };
    expect(body.template.name).toBe('custom');
    expect(body.template.language).toEqual({ code: 'hi' });
  });

  it('omits the components block when there are no body params', async () => {
    fetchMock.mockResolvedValueOnce(okJson('wamid.9'));
    await sendWhatsAppMessage(config, { to: '+919876543210', bodyParams: [] });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(init.body)) as { template: Record<string, unknown> };
    expect(body.template.components).toBeUndefined();
  });

  it('throws with a trimmed response slice when the API rejects', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"error":{"message":"bad token"}}', { status: 401 }));

    await expect(
      sendWhatsAppMessage(config, { to: '+919876543210', bodyParams: ['x'] }),
    ).rejects.toThrow(/status 401/);
  });
});

describe('registerWhatsAppHandler', () => {
  const envConfig = () => {
    process.env.WHATSAPP_ACCESS_TOKEN = 'token';
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'ph-id';
  };

  it('registers a WHATSAPP job handler that sends a template message', async () => {
    envConfig();
    fetchMock.mockResolvedValueOnce(okJson('wamid.1'));
    await registerWhatsAppHandler();

    expect(whatsappHandler).toBeDefined();
    await whatsappHandler!({ to: '+919876543210', bodyParams: ['summary'], leadId: 'lead-1', userId: 'u1' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(init.body)) as { to: string; template: { components: unknown[] } };
    expect(body.to).toBe('+919876543210');
    expect(body.template.components).toHaveLength(1);
    // Successful send is recorded in the outbound message log, with the ids
    // needed to trace it back to the lead and recipient.
    expect(messageLogRows).toHaveLength(1);
    expect(messageLogRows[0]).toMatchObject({
      channel: 'WHATSAPP',
      recipient: '+919876543210',
      bodyText: 'summary',
      status: 'SENT',
      providerMessageId: 'wamid.1',
      leadId: 'lead-1',
      userId: 'u1',
    });
  });

  it('records a FAILED log row and rethrows when the API rejects the send', async () => {
    envConfig();
    fetchMock.mockResolvedValueOnce(new Response('quota exceeded', { status: 429 }));
    await registerWhatsAppHandler();

    await expect(
      whatsappHandler!({ to: '+919876543210', bodyParams: ['summary'], leadId: 'lead-1' }),
    ).rejects.toThrow(/429/);
    expect(messageLogRows).toHaveLength(1);
    expect(messageLogRows[0]).toMatchObject({
      channel: 'WHATSAPP',
      status: 'FAILED',
      recipient: '+919876543210',
      leadId: 'lead-1',
    });
    expect(String(messageLogRows[0].error)).toContain('429');
  });

  it('throws on payload missing a recipient or body, so the queue retries', async () => {
    envConfig();
    await registerWhatsAppHandler();

    await expect(whatsappHandler!({ to: '', bodyParams: [] })).rejects.toThrow(/payload/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws when WhatsApp is not configured, so the queue retries', async () => {
    // No env vars, no row.
    await registerWhatsAppHandler();

    await expect(whatsappHandler!({ to: '+919876543210', bodyParams: ['summary'] })).rejects.toThrow(
      /not configured/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});