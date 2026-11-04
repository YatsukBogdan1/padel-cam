/**
 * Money is integer cents end to end. Nothing here goes through a float: `19.99 *
 * 100` is 1998.9999999999998, and a ledger that drifts by a cent per row is one
 * nobody trusts. Parsing works on the digit string; formatting divides integers.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** `123456` → `€1,234.56`; `-500` → `−€5.00` (a refund). */
export function formatEuros(cents: number): string {
  return formatMinor(cents, '€');
}

/** Same shape for a non-euro original amount: `USD 1,234.56`. */
export function formatOriginal(cents: number, currency: string): string {
  return formatMinor(cents, `${currency.toUpperCase()} `);
}

function formatMinor(cents: number, prefix: string): string {
  const abs = Math.abs(Math.trunc(cents));
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  const sign = cents < 0 ? '−' : '';
  return `${sign}${prefix}${groupThousands(String(whole))}.${frac}`;
}

export type ParsedAmount = { ok: true; cents: number } | { ok: false; error: string };

/**
 * A typed amount in major units to integer cents. Accepts `12`, `12.5`, `12,50`,
 * `-30` and an optional `€`. Thousands separators are refused rather than
 * guessed: `1,234` could be 1.234 or 1234 depending on who typed it, and a
 * silent thousand-fold error is the worst outcome in a spending ledger.
 */
export function parseAmount(raw: string): ParsedAmount {
  const s = raw.replace(/[\s€]/g, '');
  if (s === '') return { ok: false, error: 'Enter an amount' };
  const m = /^(-?)(\d+)(?:[.,](\d*))?$/.exec(s);
  if (!m) return { ok: false, error: 'Use digits only, e.g. 1234.56 (no thousands separators)' };
  const [, sign, whole = '', frac = ''] = m;
  if (frac.length > 2) return { ok: false, error: 'At most two decimals, and no thousands separators' };
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) return { ok: false, error: 'Amount is too large' };
  return { ok: true, cents: sign === '-' ? -cents : cents };
}

/** Cents back to an editable string (`-1234.5` → `-1234.50`), for the edit form. */
export function centsToInput(cents: number): string {
  const abs = Math.abs(cents);
  return `${cents < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** `YYYY-MM-DD` in local time: what a date input speaks, and "today" for a new expense. */
export function todayInput(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** `2026-10-15` → `15 Oct 2026`. String-split, so no timezone can shift the day. */
export function formatDay(date: string): string {
  const [y, mo, d] = date.split('-');
  const month = MONTHS[Number(mo) - 1];
  if (!y || !month || !d) return date;
  return `${Number(d)} ${month} ${y}`;
}

/** `2026-10` → `Oct 2026`. */
export function formatMonth(key: string): string {
  const [y, mo] = key.split('-');
  const month = MONTHS[Number(mo) - 1];
  return y && month ? `${month} ${y}` : key;
}
