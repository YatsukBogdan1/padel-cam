import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Tests run inside workerd with the real bindings from wrangler.toml -- D1, R2,
// the CourtCamera Durable Object -- backed by local Miniflare storage, isolated
// per test file. Nothing here touches the deployed database or bucket.
export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // A fixed token so device routes are exercised with auth ON, as in
            // production -- never the auth-off local-dev mode.
            DEVICE_TOKEN: 'test-device-token',
            // No email transport in tests: notify() must log, not send.
            RESEND_API_KEY: '',
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
    },
  };
});
