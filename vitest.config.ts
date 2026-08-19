import { defineConfig } from 'vitest/config';

// A local config is required: without it vitest picks up a config from a
// parent directory and never sees the tests here.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
