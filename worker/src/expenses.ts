/**
 * Company spending: what the company has bought, and the running total.
 *
 * Company-wide rather than per venue, so it lives on the super-admin surface and
 * inherits its gate: a venue admin -- and anyone signed out -- gets the same 404
 * as from every other /api/super route (requireSuperAdmin).
 *
 * Money is integer euro cents end to end (VAT included, negative for a refund).
 * Nothing here ever holds an amount as a float, so the total is exact however
 * many rows it sums. Past purchases arrive in one batch from
 * worker/scripts/import-expenses.mjs; with `replace: true` that batch deletes
 * every existing row first in the same D1 transaction, which is what makes
 * re-running the importer idempotent rather than doubling the totals.
 */
import { json, requireSuperAdmin } from './handlers';
import type { Params } from './router';
import { EXPENSE_CATEGORIES, type Env, type Expense, type ExpenseCategory } from './types';

/** Bounds on what one request may write. Generous, but finite. */
const MAX_VENDOR = 200;
const MAX_DESCRIPTION = 500;
const MAX_NOTES = 2000;
/** 100 million euros, in cents. Anything past it is a typo, not a purchase. */
const MAX_ABS_CENTS = 10_000_000_000;
/** One import is the whole history; far more than the company will ever have. */
export const MAX_IMPORT_ROWS = 5000;

/** The request body shape, for POST, each import row, and (partially) PATCH. */
export interface ExpenseInput {
  date: string;
  vendor: string;
  description: string;
  category: ExpenseCategory;
  amountCents: number;
  currencyOriginal: string | null;
  amountOriginalCents: number | null;
  notes: string | null;
}

export interface ExpenseTotals {
  allCents: number;
  byCategory: Record<string, number>;
  byMonth: Record<string, number>;
}

/** A real calendar date in YYYY-MM-DD -- not merely the right shape (no 2026-02-30). */
function isIsoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

function isCents(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && Math.abs(v) <= MAX_ABS_CENTS;
}

function requiredText(v: unknown, field: string, max: number): string | { error: string } {
  if (typeof v !== 'string' || !v.trim()) return { error: `${field} is required` };
  if (v.trim().length > max) return { error: `${field} must be at most ${max} characters` };
  return v.trim();
}

/**
 * Validate and normalise one expense body. Returns the clean input or a message
 * fit for a 400. Unknown fields are ignored; every known one is checked.
 */
export function validateExpense(raw: unknown): ExpenseInput | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'body must be a JSON object' };
  }
  const b = raw as Record<string, unknown>;

  if (typeof b.date !== 'string' || !isIsoDate(b.date)) {
    return { error: 'date must be a calendar date as YYYY-MM-DD' };
  }
  const vendor = requiredText(b.vendor, 'vendor', MAX_VENDOR);
  if (typeof vendor !== 'string') return vendor;
  const description = requiredText(b.description, 'description', MAX_DESCRIPTION);
  if (typeof description !== 'string') return description;

  if (typeof b.category !== 'string' || !(EXPENSE_CATEGORIES as readonly string[]).includes(b.category)) {
    return { error: `category must be one of: ${EXPENSE_CATEGORIES.join(', ')}` };
  }
  if (!isCents(b.amountCents)) {
    return { error: 'amountCents must be an integer number of euro cents (e.g. 13799 for €137.99)' };
  }

  // The original currency is optional, but it is a pair: a USD amount without
  // its currency, or a currency without its amount, cannot be reconciled.
  let currencyOriginal: string | null = null;
  let amountOriginalCents: number | null = null;
  const cur = b.currencyOriginal;
  const orig = b.amountOriginalCents;
  const hasCur = cur !== undefined && cur !== null && cur !== '';
  const hasOrig = orig !== undefined && orig !== null;
  if (hasCur) {
    if (typeof cur !== 'string' || !/^[A-Za-z]{3}$/.test(cur.trim())) {
      return { error: 'currencyOriginal must be a 3-letter currency code, e.g. "USD"' };
    }
    currencyOriginal = cur.trim().toUpperCase();
  }
  if (hasOrig) {
    if (!isCents(orig)) {
      return { error: 'amountOriginalCents must be an integer number of cents' };
    }
    amountOriginalCents = orig;
  }
  if (currencyOriginal !== null && amountOriginalCents === null) {
    return { error: 'amountOriginalCents is required when currencyOriginal is set' };
  }
  if (currencyOriginal === null && amountOriginalCents !== null) {
    return { error: 'currencyOriginal is required when amountOriginalCents is set' };
  }
  // EUR is the booking currency: stored as NULL, per the schema.
  if (currencyOriginal === 'EUR') {
    currencyOriginal = null;
    amountOriginalCents = null;
  }

  let notes: string | null = null;
  if (b.notes !== undefined && b.notes !== null) {
    if (typeof b.notes !== 'string') return { error: 'notes must be a string' };
    if (b.notes.trim().length > MAX_NOTES) {
      return { error: `notes must be at most ${MAX_NOTES} characters` };
    }
    notes = b.notes.trim() || null;
  }

  return {
    date: b.date,
    vendor,
    description,
    category: b.category as ExpenseCategory,
    amountCents: b.amountCents,
    currencyOriginal,
    amountOriginalCents,
    notes,
  };
}

/** Totals over every row. byCategory always lists every category, zero or not. */
export function expenseTotals(rows: Expense[]): ExpenseTotals {
  const byCategory: Record<string, number> = Object.fromEntries(
    EXPENSE_CATEGORIES.map((c) => [c, 0]),
  );
  const byMonth: Record<string, number> = {};
  let allCents = 0;
  for (const r of rows) {
    allCents += r.amount_cents;
    byCategory[r.category] = (byCategory[r.category] ?? 0) + r.amount_cents;
    const month = r.date.slice(0, 7);
    byMonth[month] = (byMonth[month] ?? 0) + r.amount_cents;
  }
  return { allCents, byCategory, byMonth };
}

function insertStatement(env: Env, id: string, e: ExpenseInput, now: number): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO expenses (id, date, vendor, description, category, amount_cents,
       currency_original, amount_original_cents, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    e.date,
    e.vendor,
    e.description,
    e.category,
    e.amountCents,
    e.currencyOriginal,
    e.amountOriginalCents,
    e.notes,
    now,
    now,
  );
}

function getExpense(env: Env, id: string): Promise<Expense | null> {
  return env.DB.prepare(`SELECT * FROM expenses WHERE id = ?`).bind(id).first<Expense>();
}

/** The row back in request-body form, so a PATCH can be validated as a whole. */
function toInput(e: Expense): Record<string, unknown> {
  return {
    date: e.date,
    vendor: e.vendor,
    description: e.description,
    category: e.category,
    amountCents: e.amount_cents,
    currencyOriginal: e.currency_original,
    amountOriginalCents: e.amount_original_cents,
    notes: e.notes,
  };
}

const PATCHABLE = [
  'date',
  'vendor',
  'description',
  'category',
  'amountCents',
  'currencyOriginal',
  'amountOriginalCents',
  'notes',
] as const;

export async function listExpensesHandler(req: Request, env: Env): Promise<Response> {
  const admin = await requireSuperAdmin(req, env);
  if (admin instanceof Response) return admin;

  const { results } = await env.DB.prepare(
    `SELECT * FROM expenses ORDER BY date DESC, created_at DESC, id`,
  ).all<Expense>();
  const expenses = results ?? [];
  return json({ expenses, totals: expenseTotals(expenses) });
}

export async function createExpenseHandler(req: Request, env: Env): Promise<Response> {
  const admin = await requireSuperAdmin(req, env);
  if (admin instanceof Response) return admin;

  const input = validateExpense(await req.json().catch(() => null));
  if ('error' in input) return json(input, 400);

  const id = crypto.randomUUID();
  await insertStatement(env, id, input, Date.now()).run();
  return json({ expense: await getExpense(env, id) }, 201);
}

/**
 * Partial update. The patch is merged over the stored row and the result is
 * validated whole, so a PATCH cannot leave a row that a POST would refuse --
 * e.g. a currency with its amount removed. `null` clears an optional field.
 */
export async function updateExpenseHandler(
  req: Request,
  env: Env,
  _ctx: ExecutionContext,
  params: Params,
): Promise<Response> {
  const admin = await requireSuperAdmin(req, env);
  if (admin instanceof Response) return admin;

  const existing = await getExpense(env, params.id!);
  if (!existing) return json({ error: 'Unknown expense' }, 404);

  const patch = await req.json().catch(() => null);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return json({ error: 'body must be a JSON object' }, 400);
  }
  const merged = toInput(existing);
  for (const key of PATCHABLE) {
    if (key in patch) merged[key] = (patch as Record<string, unknown>)[key];
  }
  // Clearing the currency clears its amount too, rather than failing the pair rule.
  if ('currencyOriginal' in patch && !(patch as Record<string, unknown>).currencyOriginal &&
      !('amountOriginalCents' in patch)) {
    merged.amountOriginalCents = null;
  }
  const input = validateExpense(merged);
  if ('error' in input) return json(input, 400);

  await env.DB.prepare(
    `UPDATE expenses SET date = ?, vendor = ?, description = ?, category = ?,
       amount_cents = ?, currency_original = ?, amount_original_cents = ?, notes = ?,
       updated_at = ?
     WHERE id = ?`,
  )
    .bind(
      input.date,
      input.vendor,
      input.description,
      input.category,
      input.amountCents,
      input.currencyOriginal,
      input.amountOriginalCents,
      input.notes,
      Date.now(),
      existing.id,
    )
    .run();
  return json({ expense: await getExpense(env, existing.id) });
}

export async function deleteExpenseHandler(
  req: Request,
  env: Env,
  _ctx: ExecutionContext,
  params: Params,
): Promise<Response> {
  const admin = await requireSuperAdmin(req, env);
  if (admin instanceof Response) return admin;

  const res = await env.DB.prepare(`DELETE FROM expenses WHERE id = ?`).bind(params.id!).run();
  if (!res.meta.changes) return json({ error: 'Unknown expense' }, 404);
  return new Response(null, { status: 204 });
}

/**
 * Bulk insert, for the importer. Every row is validated before anything is
 * written, and the delete (with `replace: true`) and the inserts go in one D1
 * batch -- a transaction -- so a bad row or a failed write leaves the table as it
 * was, never half-replaced.
 */
export async function importExpensesHandler(req: Request, env: Env): Promise<Response> {
  const admin = await requireSuperAdmin(req, env);
  if (admin instanceof Response) return admin;

  const body = (await req.json().catch(() => null)) as { rows?: unknown; replace?: unknown } | null;
  if (!body || !Array.isArray(body.rows) || body.rows.length === 0) {
    // Empty is refused on purpose: with replace it would silently wipe the table.
    return json({ error: 'rows must be a non-empty array' }, 400);
  }
  if (body.rows.length > MAX_IMPORT_ROWS) {
    return json({ error: `at most ${MAX_IMPORT_ROWS} rows per import` }, 400);
  }
  if (body.replace !== undefined && typeof body.replace !== 'boolean') {
    return json({ error: 'replace must be a boolean' }, 400);
  }

  const inputs: ExpenseInput[] = [];
  for (const [i, raw] of body.rows.entries()) {
    const input = validateExpense(raw);
    if ('error' in input) return json({ error: `row ${i + 1}: ${input.error}`, row: i + 1 }, 400);
    inputs.push(input);
  }

  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  if (body.replace === true) statements.push(env.DB.prepare(`DELETE FROM expenses`));
  for (const input of inputs) statements.push(insertStatement(env, crypto.randomUUID(), input, now));
  await env.DB.batch(statements);

  return json({ inserted: inputs.length });
}
