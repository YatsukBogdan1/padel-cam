// Company spending on the super-admin surface, and the importer that fills it
// from the CFO's CSV. Totals are money, so they are asserted to the cent.

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  decimalToCents,
  parseCsv,
  parseExpensesCsv,
} from '../scripts/import-expenses.mjs';
import fixtureCsv from './fixtures/expenses.csv?raw';
import { BASE, adminCookie, resetDb } from './helpers';
import type { Expense } from '../src/types';

beforeEach(resetDb);

interface ListBody {
  expenses: Expense[];
  totals: { allCents: number; byCategory: Record<string, number>; byMonth: Record<string, number> };
}

function call(method: string, path: string, cookie: string | null, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  return SELF.fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const superCookie = () => adminCookie(`hq-${crypto.randomUUID().slice(0, 8)}`, true);

const pi = {
  date: '2026-08-03',
  vendor: 'ExampleParts',
  description: 'Raspberry Pi 5, 8GB',
  category: 'hardware',
  amountCents: 13799,
};

async function list(cookie: string): Promise<ListBody> {
  const res = await call('GET', '/api/super/expenses', cookie);
  expect(res.status).toBe(200);
  return (await res.json()) as ListBody;
}

describe('expenses CRUD', () => {
  it('creates, lists, patches and deletes an expense', async () => {
    const cookie = await superCookie();

    const created = await call('POST', '/api/super/expenses', cookie, {
      ...pi,
      currencyOriginal: 'usd',
      amountOriginalCents: 14999,
      notes: '  card ending 1234 ',
    });
    expect(created.status).toBe(201);
    const { expense } = (await created.json()) as { expense: Expense };
    expect(expense).toMatchObject({
      date: '2026-08-03',
      vendor: 'ExampleParts',
      description: 'Raspberry Pi 5, 8GB',
      category: 'hardware',
      amount_cents: 13799,
      currency_original: 'USD',
      amount_original_cents: 14999,
      notes: 'card ending 1234',
    });
    expect(expense.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(expense.created_at).toBe(expense.updated_at);

    expect((await list(cookie)).expenses.map((e) => e.id)).toEqual([expense.id]);

    const patched = await call('PATCH', `/api/super/expenses/${expense.id}`, cookie, {
      amountCents: 12999,
      currencyOriginal: null,
      notes: null,
    });
    expect(patched.status).toBe(200);
    const after = ((await patched.json()) as { expense: Expense }).expense;
    expect(after).toMatchObject({
      vendor: 'ExampleParts',
      amount_cents: 12999,
      currency_original: null,
      amount_original_cents: null,
      notes: null,
    });
    expect(after.updated_at).toBeGreaterThanOrEqual(expense.updated_at);

    const del = await call('DELETE', `/api/super/expenses/${expense.id}`, cookie);
    expect(del.status).toBe(204);
    expect((await list(cookie)).expenses).toEqual([]);
    expect((await call('DELETE', `/api/super/expenses/${expense.id}`, cookie)).status).toBe(404);
    expect((await call('PATCH', `/api/super/expenses/${expense.id}`, cookie, { vendor: 'x' })).status).toBe(404);
  });

  it('stores EUR as the original currency as NULL', async () => {
    const cookie = await superCookie();
    const res = await call('POST', '/api/super/expenses', cookie, {
      ...pi,
      currencyOriginal: 'EUR',
      amountOriginalCents: 13799,
    });
    const { expense } = (await res.json()) as { expense: Expense };
    expect(expense.currency_original).toBeNull();
    expect(expense.amount_original_cents).toBeNull();
  });
});

describe('expenses are super-admin only', () => {
  const routes: [string, string, unknown?][] = [
    ['GET', '/api/super/expenses'],
    ['POST', '/api/super/expenses', pi],
    ['PATCH', '/api/super/expenses/ID', { vendor: 'x' }],
    ['DELETE', '/api/super/expenses/ID'],
    ['POST', '/api/super/expenses/import', { rows: [pi], replace: true }],
  ];

  it('answers 404 to a venue admin, and changes nothing', async () => {
    const owner = await superCookie();
    const created = (await (await call('POST', '/api/super/expenses', owner, pi)).json()) as { expense: Expense };
    const venueAdmin = await adminCookie('club-a');

    for (const [method, path, body] of routes) {
      const res = await call(method, path.replace('ID', created.expense.id), venueAdmin, body);
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(await res.text()).not.toContain('ExampleParts');
    }
    const rows = await env.DB.prepare(`SELECT amount_cents FROM expenses`).all<{ amount_cents: number }>();
    expect(rows.results).toEqual([{ amount_cents: 13799 }]);
  });

  // Signed out is 401, exactly as every other /api/super route answers it
  // (requireSuperAdmin): the SPA's useSession drops an expired session to the
  // login form on 401, which a 404 here would break. The existence of the
  // surface is hidden only from signed-in accounts without the flag.
  it('refuses anyone signed out with 401, like every /api/super route', async () => {
    const owner = await superCookie();
    const created = (await (await call('POST', '/api/super/expenses', owner, pi)).json()) as { expense: Expense };
    for (const [method, path, body] of routes) {
      const res = await call(method, path.replace('ID', created.expense.id), null, body);
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(await res.text()).not.toContain('ExampleParts');
    }
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM expenses`).first<{ n: number }>())?.n).toBe(1);
    // ...and the same as an existing super route, so the two cannot drift apart.
    expect((await call('GET', '/api/super/overview', null)).status).toBe(401);
  });
});

describe('expense validation', () => {
  const bad: [string, Record<string, unknown>, RegExp][] = [
    ['date shape', { date: '03/08/2026' }, /date/],
    ['impossible date', { date: '2026-02-30' }, /date/],
    ['unknown category', { category: 'food' }, /category must be one of/],
    ['float cents', { amountCents: 137.99 }, /amountCents/],
    ['string cents', { amountCents: '13799' }, /amountCents/],
    ['absurd amount', { amountCents: 1e15 }, /amountCents/],
    ['empty vendor', { vendor: '   ' }, /vendor is required/],
    ['missing description', { description: undefined }, /description is required/],
    ['long vendor', { vendor: 'x'.repeat(201) }, /vendor must be at most 200/],
    ['long notes', { notes: 'x'.repeat(2001) }, /notes must be at most 2000/],
    ['bad currency', { currencyOriginal: 'dollars', amountOriginalCents: 500 }, /currencyOriginal/],
    ['currency without amount', { currencyOriginal: 'USD' }, /amountOriginalCents is required/],
    ['amount without currency', { amountOriginalCents: 500 }, /currencyOriginal is required/],
  ];

  for (const [name, change, message] of bad) {
    it(`400 on ${name}`, async () => {
      const cookie = await superCookie();
      const res = await call('POST', '/api/super/expenses', cookie, { ...pi, ...change });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(message);
    });
  }

  it('400 on a body that is not an object', async () => {
    const cookie = await superCookie();
    const res = await SELF.fetch(`${BASE}/api/super/expenses`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  it('a PATCH cannot leave a row a POST would refuse', async () => {
    const cookie = await superCookie();
    const { expense } = (await (await call('POST', '/api/super/expenses', cookie, pi)).json()) as { expense: Expense };
    for (const patch of [{ category: 'food' }, { date: '2026-13-01' }, { amountOriginalCents: 10 }]) {
      expect((await call('PATCH', `/api/super/expenses/${expense.id}`, cookie, patch)).status).toBe(400);
    }
    const row = await env.DB.prepare(`SELECT * FROM expenses WHERE id = ?`).bind(expense.id).first<Expense>();
    expect(row).toMatchObject({ category: 'hardware', date: '2026-08-03', amount_original_cents: null });
  });

  it('an import with one bad row writes nothing and names the row', async () => {
    const cookie = await superCookie();
    await call('POST', '/api/super/expenses', cookie, pi);
    const res = await call('POST', '/api/super/expenses/import', cookie, {
      rows: [pi, { ...pi, category: 'food' }],
      replace: true,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ row: 2, error: expect.stringMatching(/^row 2: category/) });
    // Not replaced: the existing row is still the only one.
    expect((await list(cookie)).expenses).toHaveLength(1);
  });

  it('refuses an empty import, which with replace would wipe the table', async () => {
    const cookie = await superCookie();
    await call('POST', '/api/super/expenses', cookie, pi);
    const res = await call('POST', '/api/super/expenses/import', cookie, { rows: [], replace: true });
    expect(res.status).toBe(400);
    expect((await list(cookie)).expenses).toHaveLength(1);
  });
});

describe('expense totals', () => {
  it('sums to the cent, with a refund, by category and by month, newest first', async () => {
    const cookie = await superCookie();
    const rows = [
      { ...pi, date: '2026-08-03', amountCents: 13799 },
      { ...pi, date: '2026-08-20', category: 'cloud', vendor: 'Cloudflare', amountCents: 461 },
      { ...pi, date: '2026-09-01', category: 'cloud', vendor: 'Cloudflare', amountCents: 29 },
      { ...pi, date: '2026-09-14', description: 'Refund', amountCents: -1250 },
      { ...pi, date: '2025-12-31', category: 'legal', vendor: 'Notary', amountCents: 10000 },
    ];
    for (const r of rows) expect((await call('POST', '/api/super/expenses', cookie, r)).status).toBe(201);

    const { expenses, totals } = await list(cookie);
    expect(expenses.map((e) => e.date)).toEqual([
      '2026-09-14', '2026-09-01', '2026-08-20', '2026-08-03', '2025-12-31',
    ]);
    expect(totals.allCents).toBe(13799 + 461 + 29 - 1250 + 10000);
    expect(totals.byCategory).toEqual({
      hardware: 13799 - 1250,
      cloud: 490,
      software: 0,
      services: 0,
      legal: 10000,
      other: 0,
    });
    expect(totals.byMonth).toEqual({
      '2025-12': 10000,
      '2026-08': 13799 + 461,
      '2026-09': 29 - 1250,
    });
  });

  it('is all zeros with nothing spent', async () => {
    const { expenses, totals } = await list(await superCookie());
    expect(expenses).toEqual([]);
    expect(totals.allCents).toBe(0);
    expect(totals.byMonth).toEqual({});
  });
});

describe('import', () => {
  it('with replace: true is idempotent -- re-running gives the same table, not double', async () => {
    const cookie = await superCookie();
    // Something added by hand first: the CSV is the source of truth, so it goes.
    await call('POST', '/api/super/expenses', cookie, { ...pi, vendor: 'Hand-entered' });

    const rows = parseExpensesCsv(fixtureCsv);
    for (let run = 0; run < 2; run++) {
      const res = await call('POST', '/api/super/expenses/import', cookie, { rows, replace: true });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ inserted: 4 });
    }
    const { expenses, totals } = await list(cookie);
    expect(expenses).toHaveLength(4);
    expect(expenses.some((e) => e.vendor === 'Hand-entered')).toBe(false);
    expect(totals.allCents).toBe(13799 + 461 + 29 - 1250);
    expect(expenses.find((e) => e.amount_cents === 461)).toMatchObject({
      currency_original: 'USD',
      amount_original_cents: 500,
      notes: 'monthly, card ending 1234',
    });
  });

  it('without replace, appends', async () => {
    const cookie = await superCookie();
    await call('POST', '/api/super/expenses', cookie, pi);
    const res = await call('POST', '/api/super/expenses/import', cookie, { rows: [pi] });
    expect(await res.json()).toEqual({ inserted: 1 });
    expect((await list(cookie)).totals.allCents).toBe(2 * 13799);
  });
});

describe('importer CSV parsing', () => {
  it('converts decimals to cents without float error', () => {
    expect(decimalToCents('0.29')).toBe(29); // 0.29 * 100 = 28.999999999999996
    expect(decimalToCents('137.99')).toBe(13799);
    expect(decimalToCents('-12.50')).toBe(-1250);
    expect(decimalToCents('1.1')).toBe(110);
    expect(decimalToCents('5')).toBe(500);
    expect(decimalToCents(' 1.15 ')).toBe(115); // 1.15 * 100 = 114.99999999999999
    for (const bad of ['1,50', '1.234', '1 000.00', '€5', '', 'abc']) {
      expect(() => decimalToCents(bad), bad).toThrow();
    }
  });

  it('keeps quoted commas, doubled quotes and newlines inside one field', () => {
    expect(parseCsv('a,"b, c","say ""hi""","two\nlines"\r\nx,y,,\n')).toEqual([
      ['a', 'b, c', 'say "hi"', 'two\nlines'],
      ['x', 'y', '', ''],
    ]);
    expect(() => parseCsv('a,"open')).toThrow(/quoted/);
  });

  it('turns the fixture into API rows', () => {
    const rows = parseExpensesCsv('﻿' + fixtureCsv);
    expect(rows).toEqual([
      { date: '2026-08-03', vendor: 'ExampleParts', description: 'Raspberry Pi 5, 8GB', category: 'hardware', amountCents: 13799 },
      {
        date: '2026-08-20', vendor: 'Cloudflare', description: 'Workers Paid', category: 'cloud',
        amountCents: 461, currencyOriginal: 'USD', amountOriginalCents: 500, notes: 'monthly, card ending 1234',
      },
      { date: '2026-09-01', vendor: 'Cloudflare', description: 'R2 storage', category: 'cloud', amountCents: 29 },
      {
        date: '2026-09-14', vendor: 'ExampleParts', description: 'Refund: dead SD card "SanDisk"', category: 'hardware',
        amountCents: -1250, notes: 'returned',
      },
    ]);
  });

  it('names the CSV line of a bad row, and refuses a wrong header', () => {
    const header = 'date,vendor,description,category,amount_eur,currency_original,amount_original,notes';
    expect(() => parseExpensesCsv(`${header}\n2026-08-03,A,B,hardware,1.00,,,\n2026-08-03,A,B,hardware,1,5,,,\n`)).toThrow(
      /line 3: expected 8 fields/,
    );
    expect(() => parseExpensesCsv(`${header}\n2026-08-03,A,B,hardware,"1,50",,,\n`)).toThrow(/line 2:/);
    expect(() => parseExpensesCsv(`${header}\n2026-08-03,A,B,hardware,1.00,USD,,\n`)).toThrow(/amount_original/);
    expect(() => parseExpensesCsv('date,vendor,amount\n')).toThrow(/header/);
  });
});
