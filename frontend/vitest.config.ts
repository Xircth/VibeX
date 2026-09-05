import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      shared: path.resolve(__dirname, '../shared'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    testTimeout: 15_000,
    setupFiles: ['./src/test/vitest.setup.ts'],
    include: [
      'src/**/*.{test,spec}.{ts,tsx}',
      'tests/**/*.{test,spec}.{ts,tsx}',
    ],
    css: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.{test,spec}.{ts,tsx}',
        'src/test/**',
        'src/**/*.d.ts',
        'src/vite-env.d.ts',
      ],
    },
  },
});
