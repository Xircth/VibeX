import { defineConfig } from 'vitest/config';
import path from 'path';
import { astryxRichtextCoreAlias } from './vite.astryx-richtext-core-alias';

export default defineConfig({
  plugins: [astryxRichtextCoreAlias()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      shared: path.resolve(__dirname, '../shared'),
      '@vibex/plugin-sdk': path.resolve(
        __dirname,
        '../packages/plugin-sdk/src/index.ts'
      ),
      react: path.resolve(__dirname, './node_modules/react'),
      'react/jsx-runtime': path.resolve(
        __dirname,
        './node_modules/react/jsx-runtime.js'
      ),
      'react/jsx-dev-runtime': path.resolve(
        __dirname,
        './node_modules/react/jsx-dev-runtime.js'
      ),
      'react-dom': path.resolve(__dirname, './node_modules/react-dom'),
      'react-dom/client': path.resolve(
        __dirname,
        './node_modules/react-dom/client.js'
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
