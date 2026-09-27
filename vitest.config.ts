import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/tests/**/*.test.ts'],
    globals: true,
    env: {
      DATABASE_URL: 'postgres://test:test@localhost:5432/test_crm',
    },
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
});