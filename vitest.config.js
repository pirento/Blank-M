import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Browser-storage helpers (order plans, saved views, research history) need a DOM.
    // Server tests opt into Node with a `@vitest-environment node` header.
    environment: 'jsdom',
    include: ['tests/**/*.test.js'],
    globalSetup: ['tests/helpers/global-setup.js'],
    testTimeout: 30000,
    hookTimeout: 120000,
  },
});
