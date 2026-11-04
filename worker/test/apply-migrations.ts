import { applyD1Migrations, env } from 'cloudflare:test';

// The same migrations production runs, so a test can never pass against a
// schema that does not exist.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

import { beforeEach } from 'vitest';
import { resetDb } from './helpers';

beforeEach(resetDb);
