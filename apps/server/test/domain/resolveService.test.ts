import { describe, expect, it } from 'vitest';
import { resolveService, type NamedService } from '../../src/domain/services/resolveService.js';

const payments: NamedService = {
  name: 'payments-api',
  displayName: 'payments API',
  aliases: ['payments', 'payment api', 'payment service', 'checkout'],
};
const webhooks: NamedService = {
  name: 'webhook-receiver',
  displayName: 'webhook receiver',
  aliases: ['webhooks', 'payment webhooks'],
};
const paymentsWorker: NamedService = {
  name: 'payments-worker',
  displayName: 'payments worker',
  aliases: [],
};
const catalog = [payments, webhooks];

const name = (r: ReturnType<typeof resolveService>) =>
  r.kind === 'match'
    ? r.service.name
    : r.kind === 'ambiguous'
      ? r.candidates.map((c) => c.name)
      : null;

describe('resolveService', () => {
  it.each([
    ['payments-api', 'payments-api'],
    ['Payments API', 'payments-api'],
    ['payments', 'payments-api'],
    ['payment', 'payments-api'],
    ['the payments service', 'payments-api'],
    ['how is the payments service doing', 'payments-api'],
    ['checkout', 'payments-api'],
    ['webhooks', 'webhook-receiver'],
    ['payment webhooks', 'webhook-receiver'],
    ['the webhook receiver', 'webhook-receiver'],
  ])('%j resolves to %s', (query, expected) => {
    expect(name(resolveService(query, catalog))).toBe(expected);
  });

  it('returns none for unknown or empty references', () => {
    expect(resolveService('inventory', catalog).kind).toBe('none');
    expect(resolveService('   ', catalog).kind).toBe('none');
    expect(resolveService('the service', catalog).kind).toBe('none');
  });

  it('prefers an explicit alias over a fuzzy match', () => {
    expect(name(resolveService('payments', [payments, paymentsWorker]))).toBe('payments-api');
  });

  it('is ambiguous when two services match equally well', () => {
    const paymentsNoAlias = { ...payments, aliases: [] };
    expect(name(resolveService('payments', [paymentsNoAlias, paymentsWorker]))).toEqual([
      'payments-api',
      'payments-worker',
    ]);
  });

  it('is ambiguous when an alias is shared', () => {
    const a = { name: 'a', displayName: 'alpha', aliases: ['core'] };
    const b = { name: 'b', displayName: 'beta', aliases: ['core'] };
    expect(resolveService('core', [a, b]).kind).toBe('ambiguous');
  });
});
