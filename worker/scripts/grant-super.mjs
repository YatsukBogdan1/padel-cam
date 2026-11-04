#!/usr/bin/env node
/**
 * Grant or revoke the super-admin flag on an existing admin account.
 *
 * Super-admins assign cameras to venues and clean up abandoned recordings for
 * the whole fleet. There is deliberately no endpoint that can grant this: an
 * always-reachable "promote an account" route is a permanent way in, the same
 * reason there is no self-service signup.
 *
 *   node worker/scripts/grant-super.mjs --email you@example.com --remote
 *   node worker/scripts/grant-super.mjs --email you@example.com --remote --revoke
 *
 * Use a DIFFERENT account from the one you run a club with. The two roles have
 * different blast radii, and sharing one session between them means a stolen
 * club login is also fleet-wide control.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const sql = (value) => `'${String(value).replace(/'/g, "''")}'`;

const email = arg('email')?.trim().toLowerCase();
const revoke = process.argv.includes('--revoke');
const local = process.argv.includes('--local');

if (!email) {
  console.error('usage: grant-super.mjs --email <email> [--revoke] [--local]');
  process.exit(64);
}

const value = revoke ? 0 : 1;
const statements = [
  `UPDATE admins SET is_superadmin = ${value} WHERE email = ${sql(email)};`,
  // Revoking should take effect now, not in up to 12 hours. Sessions are rows,
  // so dropping them is what makes revocation immediate.
  ...(revoke ? [`DELETE FROM sessions WHERE admin_id IN (SELECT id FROM admins WHERE email = ${sql(email)});`] : []),
  `SELECT email, is_superadmin FROM admins WHERE email = ${sql(email)};`,
];

const file = join(mkdtempSync(join(tmpdir(), 'padel-super-')), 'grant-super.sql');
writeFileSync(file, statements.join('\n') + '\n');

const workerDir = dirname(dirname(fileURLToPath(import.meta.url)));
const target = local ? '--local' : '--remote';
console.log(`==> ${revoke ? 'Revoking' : 'Granting'} super-admin for ${email} (${target})`);
execFileSync(
  'npx',
  ['wrangler', 'd1', 'execute', 'padel-cam-db', target, `--file=${file}`, '--yes'],
  { cwd: workerDir, stdio: 'inherit' },
);
console.log('\n==> Done. If the account was signed in, sign out and back in.');
