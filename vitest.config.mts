import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@core': resolve(import.meta.dirname, 'src/core'),
      '@shared': resolve(import.meta.dirname, 'src/shared'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 20000,
  },
});
