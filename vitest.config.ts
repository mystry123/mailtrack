import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts, whose root is web/. Unit tests get a dummy
// environment; nothing here connects anywhere (end-to-end tests live in test/e2e).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'web/src/**/*.test.ts'],
    env: {
      NODE_ENV: 'test',
      PUBLIC_URL: 'http://localhost:4199',
      MONGODB_URI: 'mongodb://unused',
      GOOGLE_CLIENT_ID: 'test',
      GOOGLE_CLIENT_SECRET: 'test',
      ALLOWED_EMAIL: 'me@example.com',
      SESSION_SECRET: 'test-session-secret-0123456789abcdef',
      TOKEN_ENC_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    },
  },
});
