import { defineConfig } from 'vitest/config';
import path from 'path';
import { astryxRichtextCoreAlias } from './vite.astryx-richtext-core-alias';

export default defineConfig({
  envDir: path.resolve(__dirname, '..'),
  envPrefix: ['VITE_', 'VIBEX_'],
  plugins: [astryxRichtextCoreAlias()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      shared: path.resolve(__dirname, '../shared'),
      '@module-federation/runtime': path.resolve(
        __dirname,
        './src/test/moduleFederationRuntimeStub.ts'
      ),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    server: {
      deps: {
        inline: ['@astryxdesign/richtext', '@astryxdesign/core-rte'],
      },
    },
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
