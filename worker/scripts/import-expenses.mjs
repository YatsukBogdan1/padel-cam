#!/usr/bin/env node
/**
 * Import the company's past purchases from a CSV into the expenses table.
 *
 *   node worker/scripts/import-expenses.mjs --file expenses.csv --dry-run   # parse + total, send nothing
 *   node worker/scripts/import-expenses.mjs --file expenses.csv             # deployed Worker
 *   node worker/scripts/import-expenses.mjs --file expenses.csv --base http://127.0.0.1:8787
 *
 * Reads the CSV given by --file (required), with the header
 *
 *   date,vendor,description,category,amount_eur,currency_original,amount_original,notes
 *
 * and POSTs every row to /api/super/expenses/import with `replace: true`: the
 * server deletes what is there and inserts these rows in one transaction, so
 * running it twice gives the same table, never doubled totals. That also means
 * the CSV is the source of truth for everything it holds -- an expense added in
 * the UI and not in the CSV is gone after a re-import.
 *
 * Needs a super-admin login (prompted, never echoed), exactly like
 * make-thumbnails.mjs. Set PADEL_EMAIL and PADEL_PASSWORD to run it unattended.
 *
 * Amounts are converted to integer cents by string arithmetic, never through a
 * float: 0.29 * 100 is 28.999999999999996 in floating point.
 */

const DEFAULT_BASE = 'https://padel-worker.YOUR-SUBDOMAIN.workers.dev';

export const HEADER = [
  'date',
  'vendor',
  'description',
  'category',
  'amount_eur',
  'currency_original',
  'amount_original',
  'notes',
];

/**
 * RFC 4180 CSV: fields may be quoted, quoted fields may hold commas, newlines
 * and doubled quotes (""). Accepts CRLF or LF and a leading UTF-8 BOM (what
 * spreadsheet exports produce). Returns rows of raw strings; blank lines dropped.
 */
export function parseCsv(text) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (quoted) throw new Error('CSV ends inside a quoted field (unbalanced ")');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

/**
 * "137.99" -> 13799, "-12.50" -> -1250, "0.29" -> 29, "5" -> 500, "1.5" -> 150.
 * Pure string arithmetic. Refuses thousands separators, comma decimals and more
 * than two decimals rather than guessing what they meant.
 */
export function decimalToCents(value) {
  const s = String(value).trim();
  const m = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) {
    throw new Error(
      `"${value}" is not an amount like 137.99 (use a dot for decimals, no thousands separators, at most 2 decimals)`,
    );
  }
  const cents = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  return m[1] === '-' ? -cents : cents;
}

/**
 * The CSV text -> API rows for /api/super/expenses/import. Throws with the CSV
 * line number on the first bad row, so the CFO can find it in the sheet.
 * Category and date are checked server-side too; they are checked here as well
 * so --dry-run catches them before anyone logs in.
 */
export function parseExpensesCsv(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new Error('CSV is empty');
  const header = rows[0].map((h) => h.trim().toLowerCase());
  if (header.join(',') !== HEADER.join(',')) {
    throw new Error(`CSV header must be exactly:\n  ${HEADER.join(',')}\ngot:\n  ${header.join(',')}`);
  }
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const line = i + 1;
    const r = rows[i];
    if (r.length !== HEADER.length) {
      throw new Error(`line ${line}: expected ${HEADER.length} fields, got ${r.length} (an unquoted comma?)`);
    }
    const [date, vendor, description, category, amountEur, currency, amountOriginal, notes] = r.map((f) =>
      f.trim(),
    );
    try {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`date "${date}" is not YYYY-MM-DD`);
      const body = {
        date,
        vendor,
        description,
        category: category.toLowerCase(),
        amountCents: decimalToCents(amountEur),
      };
      const cur = currency.toUpperCase();
      if (cur && cur !== 'EUR') {
        if (!amountOriginal) throw new Error(`currency_original ${cur} needs amount_original`);
        body.currencyOriginal = cur;
        body.amountOriginalCents = decimalToCents(amountOriginal);
      } else if (amountOriginal && !cur) {
        throw new Error('amount_original is set but currency_original is empty');
      }
      if (notes) body.notes = notes;
      out.push(body);
    } catch (e) {
      throw new Error(`line ${line}: ${e.message}`);
    }
  }
  return out;
}

export function formatEur(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}€${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// CLI. Only when run directly: the test suite imports the parser above inside
// workerd, where there is no filesystem, no stdin and no node: modules.

async function main() {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { createInterface } = await import('node:readline');
  const { Writable } = await import('node:stream');

  function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? fallback : process.argv[i + 1];
  }
  const BASE = (arg('base', DEFAULT_BASE) ?? DEFAULT_BASE).replace(/\/$/, '');
  const DRY_RUN = process.argv.includes('--dry-run');
  const file = arg('file');
  if (!file) {
    console.error('usage: import-expenses.mjs --file <expenses.csv> [--base <url>] [--dry-run]');
    process.exit(2);
  }

  function ask(question, hidden = false) {
    return new Promise((resolve) => {
      let muted = false;
      const out = new Writable({
        write(chunk, encoding, done) {
          if (!muted) process.stdout.write(chunk, encoding);
          done();
        },
      });
      const rl = createInterface({ input: process.stdin, output: out, terminal: true });
      rl.question(question, (answer) => {
        rl.close();
        if (hidden) process.stdout.write('\n');
        resolve(answer.trim());
      });
      muted = hidden;
    });
  }

  async function login() {
    const email = process.env.PADEL_EMAIL || (await ask('Super-admin email: '));
    const password = process.env.PADEL_PASSWORD || (await ask(`Password for ${email}: `, true));
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      console.error(`!! Login failed: ${(await res.json().catch(() => ({}))).error ?? res.status}`);
      process.exit(1);
    }
    const me = await res.json();
    if (!me.isSuperadmin) {
      console.error('!! That account is not a super-admin. Run grant-super.mjs first.');
      process.exit(1);
    }
    const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    if (!cookie) {
      console.error('!! No session cookie returned.');
      process.exit(1);
    }
    return cookie;
  }

  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    console.error(`!! Cannot read ${file}: ${e.message}`);
    process.exit(1);
  }

  let rows;
  try {
    rows = parseExpensesCsv(text);
  } catch (e) {
    console.error(`!! ${file}: ${e.message}`);
    process.exit(1);
  }
  const total = rows.reduce((sum, r) => sum + r.amountCents, 0);

  if (DRY_RUN) {
    for (const r of rows) {
      const orig = r.currencyOriginal ? ` (${r.currencyOriginal} ${formatEur(r.amountOriginalCents).replace('€', '')})` : '';
      console.log(
        `  ${r.date}  ${formatEur(r.amountCents).padStart(11)}  ${r.category.padEnd(8)}  ${r.vendor} -- ${r.description}${orig}`,
      );
    }
    console.log(`\n==> ${rows.length} row(s), total ${formatEur(total)} (dry run, nothing sent)`);
    return;
  }

  console.log(`==> ${rows.length} row(s) from ${file}, total ${formatEur(total)}`);
  console.log(`==> Replacing every expense on ${BASE}`);
  const cookie = await login();
  const res = await fetch(`${BASE}/api/super/expenses/import`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ rows, replace: true }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // The server numbers rows from 1 after the header, i.e. CSV line = row + 1.
    const where = body.row ? ` (CSV line ${body.row + 1})` : '';
    console.error(`!! Import failed (HTTP ${res.status}): ${body.error ?? 'unknown error'}${where}`);
    process.exit(1);
  }
  console.log(`==> Imported ${body.inserted} expense(s).`);
}

const invokedPath = globalThis.process?.argv?.[1];
if (invokedPath && /import-expenses\.mjs$/.test(invokedPath)) {
  await main();
}
