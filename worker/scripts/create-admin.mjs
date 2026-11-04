#!/usr/bin/env node
/**
 * Create a venue and its first admin account.
 *
 * There is deliberately no self-service signup and no bootstrap endpoint — an
 * always-available "create the first admin" route is a permanent way in. This
 * runs from your machine instead, against local or remote D1.
 *
 *   node worker/scripts/create-admin.mjs --venue my-club --name "My Club" \
 *        --email you@example.com --local
 *
 * Omit --local to write to the deployed database.
 * The password is prompted, never passed as an argument.
 */
import { execFileSync } from 'node:child_process';
import { pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const ITERATIONS = 100_000; // must match PBKDF2_ITERATIONS in worker/src/auth.ts

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256');
  return `pbkdf2$${ITERATIONS}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/** Prompt without echoing, by muting the readline output stream. */
function askHidden(question) {
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
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

const sql = (value) => `'${String(value).replace(/'/g, "''")}'`;

const venueId = arg('venue');
const venueName = arg('name') ?? venueId;
const email = arg('email')?.trim().toLowerCase();
const local = process.argv.includes('--local');

if (!venueId || !email) {
  console.error(
    'usage: create-admin.mjs --venue <id> --name "<name>" --email <email> [--local]',
  );
  process.exit(64);
}

const password = await askHidden(`Password for ${email}: `);
if (password.length < 10) {
  console.error('!! Use at least 10 characters — this account controls a venue.');
  process.exit(1);
}

const now = Date.now();
const statements = [
  `INSERT OR IGNORE INTO venues (id, name, created_at) VALUES (${sql(venueId)}, ${sql(venueName)}, ${now});`,
  `INSERT INTO admins (id, venue_id, email, password_hash, created_at) VALUES (${sql(randomUUID())}, ${sql(venueId)}, ${sql(email)}, ${sql(hashPassword(password))}, ${now});`,
];

// Write to a file rather than passing --command: the hash contains characters
// that are awkward to quote safely through a shell.
const file = join(mkdtempSync(join(tmpdir(), 'padel-admin-')), 'create-admin.sql');
writeFileSync(file, statements.join('\n') + '\n');

const workerDir = dirname(dirname(fileURLToPath(import.meta.url)));
const target = local ? '--local' : '--remote';
console.log(`==> Creating venue "${venueId}" and admin ${email} (${target})`);
execFileSync(
  'npx',
  ['wrangler', 'd1', 'execute', 'padel-cam-db', target, `--file=${file}`, '--yes'],
  { cwd: workerDir, stdio: 'inherit' },
);
console.log(`\n==> Done. Sign in with ${email}`);
